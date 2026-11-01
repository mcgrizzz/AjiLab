import { Hono } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { applySchema } from "./db.ts";
import api from "./routes.ts";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "3000");

app.use("*", cors());
app.route("/api", api);

// The app's own files (HTML, JS, CSS) must never be stale after a deploy:
// "no-cache" makes the browser check with the server every time, and the
// ETag lets an unchanged file come back as a quick 304 instead of a re-download.
app.use("/*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/api/")) return;
  const type = c.res.headers.get("content-type") || "";
  if (/text\/html|javascript|text\/css/.test(type)) c.res.headers.set("Cache-Control", "no-cache");
});
const assetEtag = etag();
app.use("/*", async (c, next) => (c.req.path.startsWith("/api/") ? next() : assetEtag(c, next)));
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

await applySchema();

console.log(`\n🍳 AjiLab running at http://localhost:${PORT}\n`);
serve({ fetch: app.fetch, port: PORT });
