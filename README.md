# AjiLab

A self-hosted recipe lab for people who iterate on recipes over time.

AjiLab is built around the idea that recipes are not static documents. They change through testing, notes, mistakes, branches, and releases. Write recipes in Cooklang, cook from them, log what actually happened, compare changes, and promote successful experiments into named versions.

> **Status:** Early, and changing quickly. **AjiLab is written with the use of AI.** I am actively changing the project to fit my own workflow, so expect rough edges and frequent changes. I aim to stay compatible with the Cooklang spec where practical. When AjiLab adds extra behavior, it should remain backward-compatible, although some extensions may look unusual in other Cooklang renderers.

---

## Quick start

```bash
git clone https://github.com/mcgrizzz/AjiLab ajilab && cd ajilab
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up -d
```

Open **[http://localhost:3000](http://localhost:3000)**.

Postgres, the app, and nightly backups come up together.

---

## What AjiLab is for

AjiLab is for recipe development, not just recipe storage.

Use it when you want to:

* keep a clean main recipe while testing variations
* release named recipe versions such as `v1.0`, `v1.1`, or `v2.0-beta.1`
* keep cooking notes tied to the exact version you cooked
* compare changes between drafts, releases, branches, and logs
* track derived values like hydration, baker's percentages, salt percentage, or yield
* build recipes out of other recipes, such as levain, aioli, fillings, sauces, or components

---

## Features

### Versioned recipes

Open the **Editor** to write or continue working on a recipe. When you are happy with it, release it as a named version with an optional changelog. Old versions are preserved, so you can always review, compare, fork, or re-release earlier work.

* Write → release → iterate, as many times as needed
* Release versions such as `v1.0`, `v1.1`, or `v2.0-beta.1`
* Mark versions as `released`, `beta`, or `archived`
* Fork any old version back into the Editor to continue from there
* Create automatic beta snapshots with **advance beta**: `v1.1-beta.1`, `v1.1-beta.2`, and so on

### Branches

Create a **branch** when you want to experiment with a fundamentally different direction without disturbing the main recipe.

Examples:

* a dairy-free version
* a different technique
* a scaled-up catering version
* a lower-hydration test dough
* a separate fermentation schedule

Each branch has its own independent Editor and version history, forked from a chosen starting version. When needed, you can sync changes back from main with a 3-way merge.

### Cook logs

After cooking, log the session against any version or current work-in-progress. A cook log records what happened in the real world, including the outcome, problems, adjustments, and ideas for the next test.

Each log also stores an editable copy of the recipe text as you actually made it, because the cooked version often differs from the official recipe.

Cook logs can be:

* reviewed later as experiment history
* compared against the current Editor or any release
* forked back into the Editor
* promoted directly into a new release

### Compare

Compare any two versions, branches, cook logs, or the current Editor.

AjiLab provides more than a plain text diff:

* **Ingredient diff** — unit-normalized, so `500 g` and `0.5 kg` are treated as equivalent
* **Step diff** — grouped by Cooklang section headers such as `= Dough` or `= Bake`
* **Inline diff** — character-level highlights inside changed lines

### Computed metrics

Define derived values in recipe frontmatter: hydration, baker's percentages, salt percentage, yield, or anything else that can be calculated from ingredient quantities.

```yaml
---
metric.hydration:  100 * water.g / flour.g | %
metric.salt pct:   100 * salt.g / flour.g  | %
---
```

Metrics display alongside the recipe and update live as ingredient quantities change in the editor.

### Recipe cross-references

Use one recipe as an ingredient in another recipe.

```cooklang
Use @./levain{50%g} in this dough.
Add @./aioli/v1.2{} to serve.
```

AjiLab resolves references to the latest released version unless you pin a specific version. It can also show linked recipes inline and maintain backlinks, so every recipe knows which other recipes depend on it.

### Images

Attach images to:

* a recipe
* a specific version
* a cook log

Set a thumbnail per recipe. Images are stored in Postgres, so there is no separate upload directory to manage or back up.

### Search

Search across recipe titles, content, and tags from the recipe list.

---

## Writing recipes with Cooklang

Recipes are written in [Cooklang](https://cooklang.org), a plain-text recipe format. Use YAML frontmatter for metadata.

```cooklang
---
servings: 4
notes: |-
  Adapted from Grandma's notebook, p. 47.
---

Melt @butter{100%g} in a #saucepan{}.
Add @flour{2%tbsp} and whisk for ~{2%minutes}.
Pour in @milk{500%ml} gradually.
Season with @salt{} and @pepper{}.
Bake at ^{200%C} until golden.
```

| Syntax                  | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `@ingredient{qty%unit}` | Ingredient with quantity                                         |
| `@ingredient{}`         | Ingredient with no quantity                                      |
| `#cookware{}`           | Cookware item                                                    |
| `~{qty%unit}`           | Timer                                                            |
| `^{value%unit}`         | Temperature (AjiLab extension); supports ranges                  |
| `>> key: value`         | Inline metadata, as an alternative to frontmatter                |
| `= Section Name`        | Section header used to group steps and drive section-aware diffs |

### Ingredient annotations

AjiLab supports additional ingredient annotations for optional ingredients, hidden ingredients, repeated references, and intermediate preparations.

| Syntax               | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `@?ingredient{}`     | Optional ingredient, flagged in the UI                              |
| `@-ingredient{}`     | Hidden ingredient, counted in totals but not listed normally        |
| `@&ingredient{}`     | Reference to an earlier ingredient with the same name; totals merge |
| `@&(=1)ingredient{}` | Intermediate from section 1; shown where it is consumed             |

### Temperatures

Write temperatures with the `^{value%unit}` sigil. This is an AjiLab extension; standard Cooklang renderers fall back to showing it as plain text.

```cooklang
Preheat the #oven{} to ^{200%C}.
Roast at ^{180-200%C} until the core reaches ^{74%C}.
```

| Syntax          | Meaning                            |
| --------------- | ---------------------------------- |
| `^{200%C}`      | A single temperature               |
| `^{180-200%C}`  | A temperature range                |
| `^{350%F}`      | Fahrenheit                         |

* The unit can be `C`, `F`, `°C`, `°F`, or the spelled-out `celsius` / `fahrenheit`.
* The viewer's **°F / °C** toggle converts displayed temperatures on the fly, including both ends of a range.

### Metrics

Add `metric.<name>: <formula> | <unit>` keys to the frontmatter to compute derived values.

```yaml
---
metric.hydration:    100 * water.g / flour.g    | %
metric.salt pct:     100 * salt.g / flour.g     | %
metric._total:       flour.g + water.g + salt.g
metric.yield:        metric._total              | g
---
```

Notes:

* Reference ingredients as `name.unit`, such as `flour.g` or `water.ml`
* Use underscores for multi-word ingredient names: `whole_wheat_flour.g`
* Reference an earlier metric with `metric.<name>`
* Prefix a metric name with `_` to hide it from the UI while keeping it available to other formulas
* Use the `| %` or `| g` suffix to control display units

### Recipe references

```cooklang
Use @./sourdough-starter{50%g} as the levain.
Top with @./aioli/v1.2{} to serve.
```

| Pattern                  | Resolves to                                |
| ------------------------ | ------------------------------------------ |
| `@<slug>{}`              | Latest released version of that recipe     |
| `@./<slug>{}`            | Latest released version, path-style        |
| `@./<category>/<slug>{}` | Latest released version in a category path |
| `@./<slug>/v1.0{}`       | A specific pinned version                  |

---

## Data and backups

All data lives in a single Postgres database on your server:

* recipes
* drafts
* versions
* branches
* cook logs
* images

Nothing is sent to a third-party service.

Backups run automatically every night and write to `./backups/`. For cloud backup, configure the rclone sidecar in `docker-compose.yml`.

See [docs/BACKUP.md](docs/BACKUP.md) for restore instructions.

---

## Documentation

* [Deployment & configuration](docs/DEPLOY.md) — Docker, local development, systemd, and environment variables
* [HTTP API](docs/API.md) — endpoints with request and response shapes
* [Backup & restore](docs/BACKUP.md) — nightly dumps, cloud sync, and disaster recovery
