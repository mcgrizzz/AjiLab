import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { applySchema } from "./db.ts";
import api from "./routes.ts";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "3000");

app.use("*", cors());
app.route("/api", api);
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

await applySchema();

console.log(`\n🍳 AjiLab running at http://localhost:${PORT}\n`);
serve({ fetch: app.fetch, port: PORT });
