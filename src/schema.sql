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

-- A cook log's amounts are what was cooked: at 2× they're the source × 2.
-- Set once at creation; logs from before this column read as 1×.
ALTER TABLE cook_logs
  ADD COLUMN IF NOT EXISTS scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (scale > 0);

-- "I meant this": the differences in a cook that were deliberate, as keys
-- like {"kind":"ingredient","name":"water","n":0} (the nth water in the
-- sheet, not counting added steps), so they survive later edits to the cook.
ALTER TABLE cook_logs ADD COLUMN IF NOT EXISTS intended JSONB NOT NULL DEFAULT '[]';

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

-- An entry's updated_at is when its sheet last changed (text or tags), not
-- bookkeeping like a test's Testing line or being closed: the working copy's
-- "has changes" compares against it.
CREATE OR REPLACE FUNCTION touch_entry_content() RETURNS trigger AS $$
BEGIN
  IF NEW.cooklang_text IS DISTINCT FROM OLD.cooklang_text OR NEW.tags IS DISTINCT FROM OLD.tags THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS touch_entries ON entries;
CREATE TRIGGER touch_entries BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION touch_entry_content();

DROP TRIGGER IF EXISTS touch_cook_logs ON cook_logs;
CREATE TRIGGER touch_cook_logs BEFORE UPDATE ON cook_logs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Versions and tests (docs/VERSIONING-DESIGN.md) ───────────────────────────
-- A test is an entry with a test_number: stored status 'beta' (or 'archived'
-- for an old archived beta). Its "Testing:" line is its changelog. It's open
-- until closed_as is set. Tests made from now on get the internal
-- version_string 'test-N'; older betas keep theirs.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS test_number INTEGER;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS closed_as TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
-- Lineage: a version adopted from a test (and/or a cook), or a test made from
-- another test or a cook.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS from_entry_id UUID;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS from_cook_log_id UUID;

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_closed_as_check;
ALTER TABLE entries ADD CONSTRAINT entries_closed_as_check
  CHECK (closed_as IS NULL OR closed_as IN ('adopted', 'stopped', 'rebased', 'superseded'));
ALTER TABLE entries DROP CONSTRAINT IF EXISTS fk_entries_from_entry;
ALTER TABLE entries ADD CONSTRAINT fk_entries_from_entry
  FOREIGN KEY (from_entry_id) REFERENCES entries(id) ON DELETE SET NULL;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS fk_entries_from_cook_log;
ALTER TABLE entries ADD CONSTRAINT fk_entries_from_cook_log
  FOREIGN KEY (from_cook_log_id) REFERENCES cook_logs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS entries_test_number_unique
  ON entries(branch_id, test_number) WHERE test_number IS NOT NULL;

-- Data steps, recorded by name when they run.
CREATE TABLE IF NOT EXISTS app_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Betas → tests. Runs whenever there's an old-style beta without a number
-- (first boot, or after restoring an older backup) and touches only those,
-- so a test reopened since is never closed again.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entries
    WHERE version_string IS NOT NULL AND version_string NOT LIKE 'test-%' AND test_number IS NULL
      AND (status = 'beta' OR (status = 'archived' AND version_string LIKE '%-beta%'))
  ) THEN
    RETURN;
  END IF;

  -- Only old-style betas are touched: tests saved since are named 'test-N'
  -- and already numbered.
  CREATE TEMP TABLE old_betas ON COMMIT DROP AS
    SELECT id, branch_id, created_at FROM entries
    WHERE version_string IS NOT NULL AND version_string NOT LIKE 'test-%' AND test_number IS NULL
      AND (status = 'beta' OR (status = 'archived' AND version_string LIKE '%-beta%'));

  -- 1. Number the betas (archived ones too) per branch, oldest first.
  WITH numbered AS (
    SELECT id, branch_id, ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY created_at, id) AS n
    FROM old_betas
  )
  UPDATE entries e
  SET test_number = numbered.n + COALESCE((SELECT MAX(x.test_number) FROM entries x WHERE x.branch_id = numbered.branch_id), 0)
  FROM numbered WHERE e.id = numbered.id;

  -- 2a. A beta whose text a later release has word for word was adopted.
  WITH match AS (
    SELECT DISTINCT ON (t.id) t.id AS test_id, r.id AS release_id, r.created_at
    FROM entries t
    JOIN entries r ON r.branch_id = t.branch_id AND r.status = 'released'
                  AND r.created_at > t.created_at AND r.cooklang_text = t.cooklang_text
    WHERE t.id IN (SELECT id FROM old_betas)
    ORDER BY t.id, r.created_at
  ), closed AS (
    UPDATE entries t SET closed_as = 'adopted', closed_at = match.created_at
    FROM match WHERE t.id = match.test_id
    RETURNING match.release_id, t.id AS test_id
  )
  UPDATE entries r SET from_entry_id = closed.test_id
  FROM closed WHERE r.id = closed.release_id AND r.from_entry_id IS NULL;

  -- 2b. Other betas older than the branch's newest release were overtaken by
  -- it: superseded (reopenable). Newer ones stay open.
  UPDATE entries t SET closed_as = 'superseded', closed_at = newest.created_at
  FROM (SELECT branch_id, MAX(created_at) AS created_at FROM entries
        WHERE status = 'released' GROUP BY branch_id) newest
  WHERE t.branch_id = newest.branch_id AND t.id IN (SELECT id FROM old_betas)
    AND t.status = 'beta' AND t.closed_as IS NULL AND t.created_at < newest.created_at;

  -- 3. An archived beta is a stopped test.
  UPDATE entries SET closed_as = 'stopped', closed_at = updated_at
  WHERE status = 'archived' AND id IN (SELECT id FROM old_betas) AND closed_as IS NULL;

  INSERT INTO app_migrations (name) VALUES ('betas-to-tests') ON CONFLICT (name) DO NOTHING;
END $$;

-- ── Test names ───────────────────────────────────────────────────────────────
-- A test is named by the version it was made from: "v1.1 · Test 2" is the
-- 2nd test made from v1.1 (a test made before any version is plain "Test 1").
-- Stored when the test is saved, so deleting one never renames another or
-- stops a printout from matching.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS test_base TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS test_seq INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS entries_test_seq_unique
  ON entries(branch_id, COALESCE(test_base, ''), test_seq) WHERE test_seq IS NOT NULL;

-- Name the tests that have no name yet (first boot, or a restored older
-- backup): walk each one's parent_version through earlier tests to the
-- version underneath, then number them per version in creation order, after
-- any already named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM entries WHERE test_number IS NOT NULL AND test_seq IS NULL) THEN
    RETURN;
  END IF;
  CREATE TEMP TABLE unnamed_tests ON COMMIT DROP AS
  WITH RECURSIVE walk AS (
    SELECT t.id AS test_id, t.branch_id, t.parent_version AS cur, 0 AS depth
    FROM entries t WHERE t.test_number IS NOT NULL AND t.test_seq IS NULL
    UNION ALL
    SELECT w.test_id, w.branch_id, p.parent_version, w.depth + 1
    FROM walk w
    JOIN entries p ON p.branch_id = w.branch_id AND p.version_string = w.cur AND p.test_number IS NOT NULL
    WHERE w.depth < 100
  )
  SELECT t.id AS test_id, t.branch_id, t.test_number,
         (SELECT w.cur FROM walk w
          JOIN entries v ON v.branch_id = w.branch_id AND v.version_string = w.cur AND v.test_number IS NULL
          WHERE w.test_id = t.id ORDER BY w.depth LIMIT 1) AS base
  FROM entries t WHERE t.test_number IS NOT NULL AND t.test_seq IS NULL;

  UPDATE entries e
  SET test_base = u.base,
      test_seq = COALESCE((SELECT MAX(x.test_seq) FROM entries x
                           WHERE x.branch_id = u.branch_id AND x.test_base IS NOT DISTINCT FROM u.base), 0)
               + (SELECT COUNT(*) FROM unnamed_tests o
                  WHERE o.branch_id = u.branch_id AND o.base IS NOT DISTINCT FROM u.base AND o.test_number <= u.test_number)
  FROM unnamed_tests u WHERE e.id = u.test_id;

  INSERT INTO app_migrations (name) VALUES ('tests-named-by-version') ON CONFLICT (name) DO NOTHING;
END $$;

-- ── Prints ───────────────────────────────────────────────────────────────────
-- What went on paper: a sheet (a version or a test, never the working copy)
-- at a scale. Printing the same sheet at the same scale on the same day
-- updates the one record. "Record a cook" starts from the newest print.
CREATE TABLE IF NOT EXISTS prints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  scale      DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (scale > 0),
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prints_entry_recent ON prints(entry_id, printed_at DESC);

-- How a print showed its amounts: the temperature unit and per-ingredient
-- unit choices ({"temp":"C","units":{"flour":"cup"}}). A cook started from
-- that print keeps it, so the cook screen shows what the paper said.
ALTER TABLE prints ADD COLUMN IF NOT EXISTS display JSONB NOT NULL DEFAULT '{}';
ALTER TABLE cook_logs ADD COLUMN IF NOT EXISTS display JSONB NOT NULL DEFAULT '{}';
