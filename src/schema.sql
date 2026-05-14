-- AjiLab schema (PostgreSQL 16+)
-- All content lives in this database. No filesystem dependency.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS recipes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id                     UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  slug                          TEXT NOT NULL,
  name                          TEXT NOT NULL,
  kind                          TEXT NOT NULL DEFAULT 'main'
                                  CHECK (kind IN ('main', 'variant')),
  parent_branch_id              UUID REFERENCES branches(id) ON DELETE SET NULL,
  forked_from_entry_id          UUID,
  last_merged_upstream_entry_id UUID,
  archived_at                   TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, slug)
);

-- Unified draft + version table.
-- Draft:   version_string IS NULL, status = 'draft'
-- Version: version_string IS NOT NULL, status IN ('released','beta','archived')
--
-- notes and servings are not columns: they live in the cooklang frontmatter
-- (>> servings: 4 / >> notes: ...) and are parsed on read.
--
-- parent_version and current_beta_version are denormalized as strings rather
-- than FK UUIDs because version_strings are immutable once assigned and this
-- removes a JOIN from every read path.
CREATE TABLE IF NOT EXISTS entries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  version_string       TEXT,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','released','beta','archived')),
  cooklang_text        TEXT NOT NULL DEFAULT '',
  changelog            TEXT NOT NULL DEFAULT '',
  parent_version       TEXT,
  current_beta_version TEXT,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  search_vector        TSVECTOR GENERATED ALWAYS AS (
                         to_tsvector('english', coalesce(cooklang_text, ''))
                       ) STORED,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entries_branch_version_unique UNIQUE NULLS NOT DISTINCT (branch_id, version_string)
);

ALTER TABLE branches
  DROP CONSTRAINT IF EXISTS fk_branches_forked_from;
ALTER TABLE branches
  ADD CONSTRAINT fk_branches_forked_from
  FOREIGN KEY (forked_from_entry_id) REFERENCES entries(id) ON DELETE SET NULL;

ALTER TABLE branches
  DROP CONSTRAINT IF EXISTS fk_branches_last_merged;
ALTER TABLE branches
  ADD CONSTRAINT fk_branches_last_merged
  FOREIGN KEY (last_merged_upstream_entry_id) REFERENCES entries(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id    UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  entry_id     UUID REFERENCES entries(id) ON DELETE SET NULL,
  is_thumbnail BOOLEAN NOT NULL DEFAULT false,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one thumbnail per recipe (DB-enforced)
CREATE UNIQUE INDEX IF NOT EXISTS images_one_thumbnail_per_recipe
  ON images(recipe_id) WHERE is_thumbnail;

CREATE TABLE IF NOT EXISTS cook_logs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  source_entry_id      UUID REFERENCES entries(id) ON DELETE SET NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('draft','version')),
  source_version       TEXT,  -- denormalized: version_string of source entry at log time
  cooklang_text        TEXT NOT NULL DEFAULT '',
  source_cooklang_text TEXT NOT NULL DEFAULT '',
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  cooked_at            TIMESTAMPTZ NOT NULL,
  outcome              TEXT NOT NULL DEFAULT '',
  what_worked          TEXT NOT NULL DEFAULT '',
  problems_found       TEXT NOT NULL DEFAULT '',
  changes_to_try_next  TEXT NOT NULL DEFAULT '',
  freeform_notes       TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-recipe references. Populated whenever an entry's cooklang_text is saved.
CREATE TABLE IF NOT EXISTS recipe_references (
  from_entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_recipe_id  UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  pinned_version TEXT,  -- if the reference pinned a specific version
  PRIMARY KEY (from_entry_id, to_recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_branches_recipe ON branches(recipe_id);
CREATE INDEX IF NOT EXISTS idx_entries_branch ON entries(branch_id);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_search ON entries USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_images_recipe ON images(recipe_id);
CREATE INDEX IF NOT EXISTS idx_images_entry ON images(entry_id);
CREATE INDEX IF NOT EXISTS idx_cook_logs_branch_recent ON cook_logs(branch_id, cooked_at DESC);
CREATE INDEX IF NOT EXISTS idx_cook_logs_source ON cook_logs(source_entry_id);
CREATE INDEX IF NOT EXISTS idx_references_to ON recipe_references(to_recipe_id);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS touch_recipes ON recipes;
CREATE TRIGGER touch_recipes BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS touch_branches ON branches;
CREATE TRIGGER touch_branches BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS touch_entries ON entries;
CREATE TRIGGER touch_entries BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS touch_cook_logs ON cook_logs;
CREATE TRIGGER touch_cook_logs BEFORE UPDATE ON cook_logs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
