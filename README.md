# RecipeVault

A self-hosted recipe manager with first-class versioning. Write recipes in [Cooklang](https://cooklang.org), release named versions, track cook sessions, and compare changes over time.

---

## Quick start

**Option A — Node.js 22+ (default):**

```bash
npm install
npm start
```

**Option B — Bun:**

```bash
bun install
bun run src/server.ts
```

Then open **http://localhost:3000** in your browser or on your phone.

---

## Configuration

| Variable   | Default   | Description                         |
|------------|-----------|-------------------------------------|
| `PORT`     | `3000`    | Port to listen on                   |
| `DATA_DIR` | `./data`  | Directory where the SQLite DB lives |

```bash
PORT=8080 DATA_DIR=/var/recipevault npm start
```

---

## How it works

**Versioning:**

1. Every recipe has one mutable **draft** — edit it freely in the built-in CodeMirror editor
2. When you're happy, hit **Release** → give it a name (`v1.0`, `v1.1-beta`, etc.) and an optional changelog
3. Released versions have a **status**: `released`, `beta`, or `archived`
4. The draft continues from where you left off, pre-populated with the just-released content
5. You can **fork** any old version back into the draft at any time
6. **Compare** any two versions (or cook logs) to see what changed — ingredients + full text diff

**Branches:**

Recipes support multiple branches, each with their own independent draft and version history. Branches are forked from an existing version. You can sync a branch back to main when ready.

**Cook logs:**

After cooking a recipe, log the session against any version or draft. Each cook log captures outcome, what worked, problems found, and changes to try next — plus an editable copy of the recipe text you actually used. Cook logs can be forked back to the draft or promoted directly to a new release.

**Cross-references:**

Recipes can reference other recipes. The API tracks backlinks so you can see which recipes depend on a given one.

---

## Versioning convention

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

All endpoints are under `/api`. Branch-scoped routes work on both the main branch (`/recipes/:slug/...`) and named branches (`/recipes/:slug/branches/:branch/...`).

**Recipes**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes` | List all recipes (supports `?q=search`) |
| `POST` | `/recipes` | Create recipe `{title}` |
| `GET` | `/recipes/:slug` | Get recipe with all versions |
| `PUT` | `/recipes/:slug` | Update recipe title |
| `DELETE` | `/recipes/:slug` | Delete recipe |

**Branches**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes/:slug/branches` | List branches |
| `POST` | `/recipes/:slug/branches` | Create branch `{name, source_version}` |
| `GET` | `/recipes/:slug/branches/:branch` | Get branch with versions |

**Draft** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/draft` | Get current draft |
| `PUT` | `…/draft` | Save draft `{cooklang_text, tags}` |
| `PUT` | `…/draft/notes` | Save draft notes `{notes}` |
| `POST` | `…/draft/fork` | Fork branch head into draft |
| `POST` | `…/draft/parse` | Parse cooklang text, return structured JSON |

**Versions** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/versions` | List released versions |
| `GET` | `…/versions/:v` | Get specific version |
| `PUT` | `…/versions/:v` | Edit version content `{cooklang_text, tags}` |
| `PUT` | `…/versions/:v/notes` | Edit version notes `{notes}` |
| `DELETE` | `…/versions/:v` | Delete a version |
| `POST` | `…/release` | Release `{version_string, status, changelog, source_version?}` |
| `GET` | `…/compare` | Compare two versions `?from=v1.0&to=v1.1` |
| `POST` | `…/versions/:v/fork` | Fork version into draft |

**Cook logs** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/cook-logs` | List all cook logs on branch |
| `POST` | `…/cook-logs` | Create cook log `{source, cooked_at, outcome, …}` |
| `GET` | `…/versions/:v/cook-logs` | List cook logs for a specific version |
| `PUT` | `…/cook-logs/:id` | Update cook log |
| `DELETE` | `…/cook-logs/:id` | Delete cook log |
| `POST` | `…/cook-logs/:id/fork-to-draft` | Fork cook log text into draft |
| `POST` | `…/cook-logs/:id/promote` | Promote cook log to a release `{version_string, status}` |

**Images** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/images` | List images (supports `?version=v1.0`) |
| `POST` | `…/images` | Upload image (multipart, field `image`) |
| `POST` | `/recipes/:slug/thumbnail` | Set recipe thumbnail |
| `DELETE` | `/recipes/:slug/thumbnail` | Remove recipe thumbnail |
| `GET` | `/images/:id` | Serve image |
| `DELETE` | `/images/:id` | Delete image |

**Other** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/backlinks` | Recipes that reference this recipe |
| `POST` | `…/sync/preview` | Preview branch sync to main |
| `POST` | `…/sync/apply` | Apply branch sync to main |

---

## Backup

The entire database is one file:

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
ExecStart=node_modules/.bin/tsx --experimental-sqlite --experimental-wasm-modules src/server.ts
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
│   ├── server.ts              # Hono server + static file serving
│   ├── routes.ts              # All API route handlers
│   ├── db.ts                  # SQLite schema, queries, helpers
│   ├── recipe-store.ts        # Business logic for recipes, versions, cook logs
│   ├── cooklang.ts            # Server-side Cooklang parser wrapper
│   ├── compare.ts             # Inline diff + step-block diff
│   ├── ingredient-compare.js  # Ingredient diff logic
│   ├── metric-expr.ts         # Unit/quantity expression handling
│   └── draft-quantity.js      # Draft quantity utilities
├── public/
│   ├── index.html             # SPA shell
│   ├── manifest.json          # PWA manifest
│   ├── css/
│   │   └── app.css            # All styles (mobile-first, light/dark)
│   ├── js/
│   │   ├── api.js             # Thin fetch wrapper
│   │   ├── cooklang-render.js # Client-side recipe renderer + timers
│   │   ├── cooklang-editor.js # CodeMirror editor integration
│   │   ├── views.js           # All screens: index, detail, editor, compare
│   │   └── app.js             # Router, modal, toast, bootstrap
│   └── vendor/
│       └── codemirror.js      # Bundled CodeMirror (built via npm run build:editor)
├── data/
│   └── recipevault.db         # SQLite database (auto-created on first run)
├── test/                      # Unit tests
├── package.json
└── README.md
```
