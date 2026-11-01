// In-process Postgres for store tests: PGlite (Postgres compiled to WASM)
// behind a minimal wire-protocol socket, so the app's postgres.js client
// talks to it exactly as it would to a real server.
//
//   const { url, stop } = await startTestDatabase();
//   process.env.DATABASE_URL = url;   // before importing src/db.ts
//
// One client connection at a time is enough: tests set DATABASE_POOL_MAX=1.
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;
const PROTOCOL_3 = 196608;

export async function startTestDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  // Schema NOTICEs ("… does not exist, skipping") are noise in test output.
  await db.exec("SET client_min_messages = warning");

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let queue = Promise.resolve();

    // Split the byte stream into whole protocol messages.
    const nextMessage = () => {
      if (buffer.length >= 8) {
        const length = buffer.readInt32BE(0);
        const code = buffer.readInt32BE(4);
        if (length === 8 && code === SSL_REQUEST) {
          buffer = buffer.subarray(8);
          return { reply: Buffer.from("N") };
        }
        if (length === 16 && code === CANCEL_REQUEST) {
          buffer = buffer.subarray(16);
          return { skip: true };
        }
        if (code === PROTOCOL_3) {
          if (buffer.length < length) return null;
          const message = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          return { message };
        }
      }
      if (buffer.length < 5) return null;
      const length = 1 + buffer.readInt32BE(1);
      if (buffer.length < length) return null;
      const message = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return { message };
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let item;
      while ((item = nextMessage())) {
        const current = item;
        queue = queue.then(async () => {
          if (current.reply) socket.write(current.reply);
          if (!current.message) return;
          await db.runExclusive(() => db.execProtocolRawStream(new Uint8Array(current.message), {
            onRawData: (data) => { if (data.length && socket.writable) socket.write(Buffer.from(data)); },
          }));
        }).catch((error) => socket.destroy(error));
      }
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    db,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

// Start a database, point the app at it, apply the schema and return the
// store module. Call once per test file (each file runs in its own process).
export async function setupStore() {
  const database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.DATABASE_POOL_MAX = "1";
  const dbModule = await import("../../src/db.ts");
  await dbModule.applySchema();
  const store = await import("../../src/recipe-store.ts");
  return {
    store,
    sql: dbModule.sql,
    async stop() {
      await dbModule.sql.end({ timeout: 1 });
      await database.stop();
    },
  };
}
