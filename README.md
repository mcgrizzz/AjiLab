# RecipeVault 🍳

A self-hosted recipe manager with first-class versioning. Write recipes in [Cooklang](https://cooklang.org), release immutable named versions, compare changes over time.

---

## Quick start

**Option A — Bun (recommended, easier self-hosting):**

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Start (default port 3000)
bun start
```

**Option B — Node.js 22+ (no extra install needed):**

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser or on your phone.

---

## Configuration

Set environment variables before starting:

| Variable   | Default   | Description                          |
|------------|-----------|--------------------------------------|
| `PORT`     | `3000`    | Port to listen on                    |
| `DATA_DIR` | `./data`  | Directory where the SQLite DB lives  |

```bash
# Example
PORT=8080 DATA_DIR=/var/recipevault bun start
```

---

## How it works

**The core loop:**

1. Every recipe has one mutable **draft** — edit it freely
2. When you're happy, hit **Release version** → give it a name (`v1.0`, `v1.1`, etc.) and optional changelog
3. Released versions are **immutable** — they can never be edited, only viewed
4. The draft continues from where you left off, pre-populated with the just-released content
5. You can **fork** any old version back into the draft at any time
6. **Compare** any two versions to see what changed (ingredients + full text diff)

**Versioning convention:**
- `v1.0` — first stable version
- `v1.1` — meaningful improvement
- `v1.1.1` — typo or unit correction
- `v2.0` — fundamentally different approach
- `v2.0-beta.1` — testable but not final

---

## Cooklang syntax

```
>> servings: 4

Melt @butter{100%g} in a #saucepan{}.
Add @flour{2%tbsp} and whisk for ~{2%minutes}.
Pour in @milk{500%ml} gradually.
Season with @salt{} and @pepper{}.
```

| Syntax | Meaning |
|--------|---------|
| `@name{qty%unit}` | Ingredient |
| `@name{}` | Ingredient (no quantity) |
| `#name{}` | Cookware |
| `~{qty%unit}` | Timer |
| `>> key: value` | Metadata (servings, source, etc.) |

---

## API

All endpoints are under `/api`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes` | List all recipes (supports `?q=search`) |
| `POST` | `/recipes` | Create recipe `{title}` |
| `GET` | `/recipes/:slug` | Get recipe with all versions |
| `PUT` | `/recipes/:slug` | Update recipe title |
| `DELETE` | `/recipes/:slug` | Delete recipe |
| `GET` | `/recipes/:slug/draft` | Get current draft |
| `PUT` | `/recipes/:slug/draft` | Save draft `{cooklang_text, notes, servings, tags}` |
| `POST` | `/recipes/:slug/draft/parse` | Parse cooklang text, return structured JSON |
| `POST` | `/recipes/:slug/release` | Release draft `{version_string, status, changelog}` |
| `GET` | `/recipes/:slug/versions` | List released versions |
| `GET` | `/recipes/:slug/versions/:v` | Get specific version |
| `POST` | `/recipes/:slug/versions/:v/fork` | Fork version into draft |
| `GET` | `/recipes/:slug/compare?from=v1.0&to=v1.1` | Compare two versions |
| `POST` | `/recipes/:slug/images` | Upload image (multipart) |
| `GET` | `/images/:id` | Serve image |
| `DELETE` | `/images/:id` | Delete image |

---

## Backup

The entire database is one file. Copy it:

```bash
# Simple copy
cp data/recipevault.db backup/recipevault-$(date +%Y%m%d).db

# With sqlite3 hot backup
sqlite3 data/recipevault.db ".backup backup.db"
```

For continuous backup, [Litestream](https://litestream.io/) can stream to S3/R2/local disk with zero config.

---

## Running as a service (Linux/systemd)

```ini
# /etc/systemd/system/recipevault.service
[Unit]
Description=RecipeVault
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/recipevault
ExecStart=/home/youruser/.bun/bin/bun start
Restart=on-failure
Environment=PORT=3000
Environment=DATA_DIR=/opt/recipevault/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now recipevault
```

---

## Project structure

```
recipevault/
├── src/
│   ├── server.ts          # Hono server + static file serving
│   ├── routes.ts          # All API route handlers
│   ├── db.ts              # SQLite schema, queries, helpers
│   └── cooklang.ts        # Server-side Cooklang parser wrapper
├── public/
│   ├── index.html         # SPA shell
│   ├── manifest.json      # PWA manifest
│   ├── css/
│   │   └── app.css        # All styles (mobile-first, light/dark)
│   └── js/
│       ├── api.js         # Thin fetch wrapper
│       ├── cooklang-render.js  # Client-side recipe renderer + timers
│       ├── views.js       # All screens: index, detail, editor, compare
│       └── app.js         # Router, modal, toast, bootstrap
├── data/
│   └── recipevault.db     # SQLite database (auto-created on first run)
├── package.json
└── README.md
```
