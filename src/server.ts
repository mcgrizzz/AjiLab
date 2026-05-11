import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import api from "./routes.js";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "3000");

app.use("*", cors());

// API
app.route("/api", api);

// Static files from ./public
app.use("/*", serveStatic({ root: "./public" }));

// SPA fallback
app.get("*", serveStatic({ path: "./public/index.html" }));

console.log(`\n🍳 RecipeVault running at http://localhost:${PORT}\n`);

serve({ fetch: app.fetch, port: PORT });
