# Versions and tests: design

Status: **approved.** Built so far: the P1 promote fix (`9252466`) and phase 1
(names, default view, safe adopt). Phases 2–5 are next.

## 1. Summary

The app is organised around software release words (draft, beta, release,
promote). Andrew works from paper, one variable at a time. The redesign rests on
three nouns and one rule.

| | What it is | What Andrew does with it |
|---|---|---|
| **Version** (v1.0, v1.1 …) | Everything adopted so far. The newest is **the current version**. | Opens it, prints it, cooks it. The default everywhere. |
| **Test** (Test 4 · more water) | A copy of a version with one or a few things changed, and a "Testing:" line. Editable until it's cooked, then fixed. | Prints it, cooks it one or more times, then adopts it or stops it. |
| **Working copy** | The one editable scratch copy where the next test (or a quick fix) is set up. | Edits it in the Editor. It is never printed or cooked as is. |

**The rule:** anything that has been cooked is fixed, so a cook always matches
its sheet. A test can still be edited before its first cook (the app warns
when it has gone to the printer; see "Tests editable until cooked (Nov 8)").
Versions keep the one existing exception (a typo fix in place, with the
warning).

On top of the brief, this design adds three things (the reasons are in §4):

1. **Adopting a test merges it into the current version** when the test was
   based on an older one. Copying the test wholesale would silently undo
   everything adopted since. Today's Promote has the same flaw.
2. **Prints are recorded**: what was printed, at what scale, and when. "Record a
   cook" then starts from the sheet that was actually printed instead of a
   guess.
3. **The Editor tab always edits the working copy.** Fixing a typo in a version
   becomes an explicit "Fix a typo in v1.1…" action, so what the Editor edits
   never depends on hidden state.

## 2. Concepts and names

**Version.** Shown as `v1.1`. The newest is labelled **current**, as in
"v1.1 · current". Older ones are plain `v1.0`, and on their own page they read
"v1.0 · not current (current is v1.1)". There is no Best, Latest or Released;
the version number plus "current" says it all. A version is made only by
**adopting** a test or a cook, or by **"Release without testing…"** from the
working copy.

**Test.** Shown as `Test 4 · more water`.
- It has a number (per recipe), a **Testing:** line (one short phrase), and the
  version it is **based on**.
- It is **open** until it is adopted ("Adopted as v1.2"), stopped ("Stopped"),
  or re-based ("Re-based as Test 6").
- Several tests can be open at once.
- A test is read-only. Only its Testing line can change, because that line is
  a label, not part of the sheet.

**Working copy.** One per recipe. It starts from the current version.
- "Save as Test 5…" asks for the Testing line and saves a fixed test from it.
- "Release without testing…" makes the next version directly. This is the
  secondary path, for an obvious tweak.

**Cook.** It replaces "cook log" in the interface; the code and API keep
`cook_log`.
- A cook records which sheet it was cooked from (a version or a test), at what
  scale, and what was actually done.
- **Differences** are what differ from the sheet. Small ones (≈ same) are
  **slips**, shown in grey. Bigger ones are highlighted. Any difference can be
  marked **"I meant this"**, which makes it **intended**.

Words that go away in the interface: draft, beta, release/released, promote,
archived, best, latest, viewing, deviation.

## 3. The loop, end to end

1. **Open Sakadane.** It lands on **v1.1 · current**, always. Under the title, a
   strip shows the open tests and their evidence: "Testing: **Test 4 · more
   water** · 2 cooks · Better flavor, slightly dense / Better flavor, good
   rise".
2. **Start a test.** Clicking "New test…" asks "What are you testing?" (for
   example "more water"). The working copy resets to v1.1 and the Editor opens.
   Andrew changes the water.
   - "Save as Test 5" saves the test.
   - "Print" also saves it first, then prints.
3. **Print.** Print the current version or any test; the sheet is stamped
   "Sakadane Country Loaf · Test 5 — more water · based on v1.1 · at 2× ·
   printed Nov 1". The print is recorded.
4. **Cook from paper,** scribbling on the sheet.
5. **Record the cook,** days later. "Record a cook" offers the recent printouts
   first ("Test 5 at 2×, printed Nov 1"), so the sheet and scale are already
   filled in.
   - One screen looks like the sheet. Every amount, time and temperature is an
     inline field, with Outcome and "Try next" at the top.
   - Changing a field highlights it right away: grey if it's a slip,
     highlighted if it's real. A tap marks it "I meant this".
   - One Save.
6. **Decide,** on the test's page. It shows what the test changes and a table
   of only the rows that differed across cooks, plus each cook's outcome and
   "try next". The choices:
   - **Adopt Test 5 as v1.2…**, the default. It takes the test as written.
     The changelog is filled in from the actual changes ("water 350 → 380
     g"), and the test then shows "Adopted as v1.2".
   - **Adopt from Cook 2…**, using the existing per-change checklist with the
     intended changes pre-ticked.
   - **New test from Cook 2.** A lucky accident becomes the next test.
     Saving it closes Test 5 as "followed by Test 6", since the new test
     carries on from it (also for "New test from Test 5"). The Save dialog
     has the box ticked; untick it to keep both open and cook them side by
     side. Undoing the save reopens Test 5, and it can be reopened later.
   - **Stop testing.** It stays as notes and leaves the strip.
   - **Nothing.** Cook it again; each cook adds a column.
7. **The current version moves on.** Open tests based on an older version say
   "based on v1.1 (current is v1.2)".
   - Adopting one still works, because it merges.
   - "Re-base on v1.2" makes a fresh test from v1.2 plus that test's changes,
     so the next printout matches the current version.

## 4. Where I'd change the brief

1. **Adopt must merge, not copy (correctness).** Suppose Test 4 was made from
   v1.1, and Test 3 has since been adopted as v1.2. Copying Test 4 to v1.3
   would drop Test 3's change. The existing Promote does exactly this today:
   promoting the sandbox's v1.0-beta.1 now would quietly undo v1.1. Adopt will
   run the existing 3-way merge (base = the test's base version, ours = the
   current version, theirs = the test). On a conflict it offers "Re-base first".
   Adopt-from-cook does the same after the checklist.
2. **Re-basing gives a new test number.** A test is fixed and printed, so it
   can't change under its own name. "Re-base Test 4 on v1.2" creates "Test 6 ·
   more water (re-based from Test 4)" and closes Test 4 as "Re-based as Test 6".
   Test 6's page shows Test 4's cooks below its own, as earlier evidence.
   Keeping the number with a revision ("Test 4, second sheet") would need a
   second identity in every table for no real gain.
3. **"Done" needs no button or stored state.** Leaving a cook alone *is* done.
   The decision row only shows while the cook's test is open and the cook
   hasn't been adopted from. A "Done" click would be one more thing to forget
   to do.
4. **"Opens from the version or test that was printed" needs the app to know
   what was printed.** Hence a small print record (§8). Without it, the default
   is still a guess, just a better-labelled one.
5. **Comparing cooks at different scales** happens at the sheet's 1×. A 2× cook
   shows its amounts divided back, with "2×" in the column header and the real
   amount on hover. Otherwise every row of a 2× cook would light up as a
   difference.
6. **Tests are fully read-only, notes included.** Notes live in the Cooklang
   frontmatter and print on the sheet, so editing them would break "the
   printout matches". Notes about a test belong in its cooks. The Testing line
   is the one editable label.
7. **No "go-to" version is needed (agreed), but older versions stay
   printable.** Printing v1.0 when v1.1 is current is allowed, and the stamp
   says "v1.0 (not current)".
8. **Branches: agreed, parallel tests replace them.** What they don't cover is
   a long-lived variant (a vegan loaf maintained alongside the original). That
   is really a second recipe. If it ever comes up, "Duplicate as a new recipe"
   fits better than reviving branches.

## 5. Open decisions: my recommendations

| # | Question | Brief's suggestion | My recommendation |
|---|---|---|---|
| 1 | Name | Test | **Test.** Short, and it's what a baker says ("I'm testing more water"). "Trial" is fine too, but "Experiment" is long on a stamp and a button. |
| 2 | Numbering | Per recipe | **Per recipe.** The number survives the current version moving on, and re-basing needs it (§4.2). |
| 3 | Printing the working copy saves it as a test first | Yes | **Yes.** It asks the Testing line in the same dialog, so it's one step. If nothing changed from a version or test, it prints that one instead and says so. |
| 4 | "Release without testing…" | Keep, secondary | **Keep, secondary**, on the working copy only, under the Editor's ⋯ menu. "Fix a typo in v1.1…" stays for in-place fixes. |
| 5 | Tagging intended differences | Optional | **Optional.** A one-tap "I meant this" on a highlighted difference. It does two things: such a difference stands out in the comparison table, and it comes pre-ticked in "Adopt from Cook N". |
| 6 | Editing in place | Versions editable with a warning; tests read-only | **Agree**, with one change: in-place editing moves off the Editor tab into "Fix a typo in v1.1…" on the version, which opens the editor on v1.1 with the warning. |

## 6. Old terms and what replaces them

| Where (today) | Today | Becomes |
|---|---|---|
| Header badge (`views-recipe-core.js` `headerStatusBits`) | "Best: v1.0", "No releases yet" | Removed. The version picker shows "v1.1 · current". With no version: "No version yet". |
| Version picker (header) | "Draft", "v1.1-beta.1 (beta)", "v1.0 (released)" | Groups **Versions** ("v1.1 · current", "v1.0") and **Tests** ("Test 4 · more water · open"). The working copy isn't listed; it lives in the Editor. |
| Overview banner (`views-recipe-overview.js`) | "Latest · Draft", "Latest · v1.1-beta.1 (beta)", "Current best · v1.0 (released)", "Viewing · …" | "v1.1 · current version", "v1.0 · not current (current is v1.1)", "Test 4 · more water · based on v1.0 · open" |
| Overview default (`defaultActiveVersion`, `active_experiment`) | Draft if changed, else newest beta, else best | Always the current version. With no version yet: the newest open test, with "Adopt this test to make v1.0". |
| Overview sidebar | "Current Best" card, "Set a baseline" | **Open tests** card (evidence per test, "New test…"), latest-cook card kept |
| Overview / Editor buttons | "Release…", "Promote…" | On a test: "Adopt as v1.2…". On the working copy: "Save as Test 5…" plus ⋯ "Release without testing…". |
| Release dialog | Status select: Released / Beta / Archived | Removed. Adopt and Release always make a version; the version number is prefilled and editable. |
| Editor toolbar | "Save as v1.1-beta.2", "Editing Draft" | "Save as Test 5…", "Working copy · based on v1.1 · 2 changes" |
| Editor on a version | Edits it in place, sometimes by default | Only through "Fix a typo in v1.1…". The warning's button "Start a new beta from v1.0" becomes "New test from v1.0". |
| Editor on a beta | Edits it in place, no warning | Not possible. "Test 4 is fixed so printouts match it. **New test from Test 4**" |
| Draft status line (`draft_change_label`) | "Draft differs from v1.0", "Draft in progress" | "Working copy has changes" (Editor and home card only) |
| Home cards (`views-index.js`) | Release badge and beta badge at equal weight, "Draft in progress" | "v1.1 · 2 open tests"; without a version, "No version yet · 3 tests" |
| Cook form source select | "Current draft", "v1.1-beta.1 (beta)" | "Which sheet?" with recent printouts first, then the current version, open tests and older ones. No working copy. |
| Cook card | "Mark differences", "Promote to release", ⋯ "Load into draft" | Opens the cook screen (edit). On a test's cook: "Adopt from this cook…", "New test from this cook". On the current version: "New test from this cook", ⋯ "Adopt changes from this cook…". A badge "Adopted as v1.2" when that applies. |
| Step markers (`cooklang-render.js`) | "DEVIATION", "deviation" | "Added step", "Skipped", "Changed" |
| Versions tab | One list of everything | **Versions** (with "from Test 3" / "released without testing") and **Tests** (open first, then closed with their outcome). Compare stays. |
| Print meta line | "v1.1-beta.1 · created May 29", "Draft · edited May 29" | "Test 4 — more water · based on v1.0 · at 2× · printed Nov 1". The working copy is never printed. |
| Promote-from-log changelog | Defaults to the cook's outcome | Filled from the actual changes, editable |

## 7. Screens

**Home.** A card reads "v1.1 · 2 open tests · last cooked Oct 30". A recipe with
no version yet reads "No version yet · 3 tests". Sorting by recent activity
stays as it is.

**Recipe page (Overview).** It always shows the current version.
- Under the title, the **open-tests strip**: one line per open test with its
  evidence. Clicking a test opens it.
- The actions are Print and Record a cook, plus "New test…".
- When the working copy has unsaved changes, a quiet line says "Working copy has
  changes · Open editor".
- An older version is reached through the picker or the Versions tab, and its
  banner says it's not current.

**Test page** (`/recipe/<slug>/tests/4`, phase 4). From the top:
- The header: "Test 4 · more water · based on v1.0 · open". The Testing line
  is editable.
- **What this test changes**: the diff from its base, reusing compare.
- **Cooks**: the comparison table, with the outcome and "try next" for each.
- The actions: Print, Record a cook, Adopt as v1.2…, New test from this…, Stop
  testing. Re-base appears when the base isn't current. A line under them
  says what to do next (print and cook it; or, once cooked, adopt it or test
  again from a cook).
- The full sheet, always open (a collapsed sheet hid the recipe on a test's
  own page). Sections with nothing in them aren't shown: no "What this test
  changes" for a test made before any version, no "Cooks" before the first.
  The "Testing" strip of open tests shows only when another test is open.

**Cook screen** (`/recipe/<slug>/cooks/new`, and `/cooks/<id>` to edit, phase 3).
Revised after the cook-recording audit (Nov 2): recording the scenario there
(4 changed values, a skipped step, a note, outcome, try next) took about 25
actions across a modal and a second screen, ending in a native `prompt()`.
- **One click to start, no form first.** "Record a cook" opens the screen
  filled in from the paper in hand: the newest print with no cook since
  (phase 2's `cookStart`), its scale and its print date. Nothing is required;
  the cook is saved at the first change or on Done.
  **"Cooked as written"** records it as is and leaves only Outcome.
- **The paper's order.** A slim header (sheet, scale, and the date as
  **Print date · Today · Yesterday · pick…**, time optional), then the sheet
  (ingredients, then steps, every number editable in place), then the
  reflection: **Outcome** (one line), **Try next**, and one **Notes** box that
  replaces "What worked", "Problems found" and "Freeform notes" (old cooks'
  three fields are joined into it when edited).
- **Fast number editing.** The whole chip (name and amount) is the target,
  at least 32 px tall, styled like the printed text with a dotted underline.
  **Tab / Shift-Tab** moves through the values in sheet order, ingredient list
  included; **Enter** confirms and moves on; **Esc** reverts. Saving happens in
  the background with no repaint, no focus or layout change: the space for
  "was 220 g" is reserved. A unit or a range can be typed ("1 cup", "18-20").
  `Units.sameAmount` greys slips and highlights real changes while typing.
  Clicking the struck-through old value reverts it; Ctrl/Cmd-Z undoes the
  last change.
- **Ingredient list:** an ingredient used once is edited in the list. One used
  in several steps shows its total and is edited in the steps.
- **In place, no dialogs.** Each step has a visible **Skip** toggle. Notes and
  added steps open as text areas under the step (Enter saves, Shift-Enter is a
  new line). All six `prompt()` calls go.
- **Differences:** each changed value shows "was 375 g", greyed when ≈ same,
  plus an "I meant this" toggle.
- **Editing a cook later** opens the same screen.
- **Photos** (optional, any number) are added under Notes. Adding one records
  the cook, like any change. See "Photos belong to cooks (Nov 6)" below.

**Adopt dialog** (phase 4; a simplified version in phase 1).
- Title: "Adopt Test 4 as v1.2".
- The version number is prefilled with the next minor and is editable.
- **Changes**, prefilled from the real diff against the current version
  (merged when needed), editable.
- An evidence line ("2 cooks · latest Nov 5: Better flavor, good rise").
- A source choice: **As written** (default) or **From Cook 2** (the checklist,
  with intended changes pre-ticked).
- Merge result: "Merges cleanly into v1.1", or "Conflicts with v1.1 in step 3
  → Re-base first".

**Print sheet.**
- The stamp in the meta line: what the sheet is, its base, scale and print
  date.
- A footer line: "Record this cook in AjiLab as: Sakadane · Test 4".
- Printing records a print. Printing the working copy runs "Save as Test N"
  first.

**Versions tab.** Two lists, each with its own dates and links, then compare.
- **Versions:** v1.1 current, from Test 4 · v1.0, released without testing.
- **Tests:** open ones first, then closed ones with their outcome (Adopted as
  v1.1 / Stopped / Re-based as Test 6).

**Editor.**
- Always the working copy.
- The toolbar: "Working copy · based on v1.1", the save pill, and **Save as
  Test 5…**. The ⋯ menu holds "Release without testing…" and "Reset to v1.1".
- "Fix a typo in v1.1…" opens the same editor on the version, with the existing
  warning and a plain Save.

## 8. Data model

No change to the `status` values: `beta` stays the stored value for a test and
`released` for a version. The API adds derived fields, and only the interface
changes words. This keeps every existing query, index and cook-log link as it
is.

```sql
-- entries: tests and lineage
ALTER TABLE entries ADD COLUMN IF NOT EXISTS test_number   INTEGER;      -- tests only
ALTER TABLE entries ADD COLUMN IF NOT EXISTS closed_as     TEXT
  CHECK (closed_as IN ('adopted', 'stopped', 'rebased', 'superseded', 'followed'));  -- NULL = open
ALTER TABLE entries ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS from_entry_id    UUID REFERENCES entries(id)   ON DELETE SET NULL;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS from_cook_log_id UUID REFERENCES cook_logs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entries_test_number_unique
  ON entries(branch_id, test_number) WHERE test_number IS NOT NULL;

-- what was printed
CREATE TABLE IF NOT EXISTS prints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  scale      DOUBLE PRECISION NOT NULL DEFAULT 1,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cooks: differences marked "I meant this"
ALTER TABLE cook_logs ADD COLUMN IF NOT EXISTS intended JSONB NOT NULL DEFAULT '[]';
```

- **The Testing line reuses `changelog`.** For a version it's "what changed",
  for a test it's "what's being tested". Both describe the difference from the
  base, so they share a column instead of adding one.
- **Base version.** It comes from `parent_version`.
  - New tests store the version they were based on.
  - Old betas chain beta → beta, so the loader walks up to the nearest version
    (none, for betas made before v1.0).
- **New tests get an internal `version_string` of `test-5`.** It satisfies the
  existing unique constraint and keeps every `/versions/:version` route working.
  The interface never shows it. Existing betas keep `v1.1-beta.1` internally.
- **Lineage.** A version made by adopting has `from_entry_id` set to the test
  and, for adopt-from-cook, `from_cook_log_id` set to the cook. A re-based
  test or a "new test from" has the same links.
  - "Adopted as v1.2" on a test or a cook is derived from these.
  - Adopting the same cook twice gets a warning ("Already adopted as v1.2"),
    not a block.
- **`intended`** holds keys like `{"kind":"ingredient","name":"water","n":1}`
  and `{"kind":"timer","step":7,"n":0}`. They're matched the way scaling
  already matches occurrences, so they survive later edits to the cook.
- **Print records are written** by the print page on `beforeprint`. A print of
  the same sheet at the same scale on the same day updates the existing record
  instead of adding one.
- The API adds `kind` (`version` | `test` | `working_copy`), `label`
  ("v1.1" / "Test 4"), `testing`, `base_version`, `is_current`, `open`,
  `adopted_as` and `recent_prints` to the recipe record.
- `active_experiment` and `current_best_release` remain for one phase as
  aliases, then go.

## 9. Migration and existing data

All of it is idempotent SQL in `schema.sql`, applied at boot. The one-time
steps (numbering and closing) run inside a guarded `DO` block that records
itself in a one-row-per-step `app_migrations` table. This matters because a
re-run must not re-close a test Andrew has reopened. Nothing is deleted or
rewritten: cook logs, their snapshots and scales, and every version string stay
exactly as they are.

1. **Number the existing betas** as tests per recipe, oldest first.
2. **Close the betas the current version has overtaken.**
   - A beta whose text equals a later release becomes "Adopted as vX", and
     that release gets `from_entry_id`.
   - Any other beta older than the newest release becomes **"Superseded"**,
     reopenable with one click.
   - Betas newer than the newest release stay open.
   - Recipes with no release keep all their betas open.
3. **Archived entries:** an archived release shows as an old version, an
   archived beta as a stopped test.
4. **Leave working copies alone.** A draft that differs from everything shows
   "Working copy has changes".
5. **Old cooks logged from the draft** keep their snapshot and show "from the
   working copy (May 29)". New ones can't be made.
6. **Redirect old links:** `/recipe/x/versions/v1.1-beta.1` redirects to
   `/recipe/x/tests/4`.

**Sakadane, from the local copy** (the live data may have moved on):

| Today | After |
|---|---|
| v1.0-beta.1 (May 11) | Test 1 · superseded (by v1.0) |
| v1.0-beta.2 (May 13) | Test 2 · superseded |
| v1.0-beta.3 (May 29) | Test 3 · superseded. Its text differs from v1.0, so it isn't marked adopted. |
| v1.0 (released) | **v1.0 · current**. Its changelog "Even better flavor, everything else similar" is really a cook outcome; Andrew may want to edit it. |
| v1.1-beta.1 | **Test 4 · open · based on v1.0**. It changes water (15 → 30 g and 265 → 350 g) and adds a starter metric. It has no Testing line, so the page asks for one (suggested: "more water"). |
| Draft (differs from v1.1-beta.1) | Working copy, "has changes" |
| 4 cooks | Unchanged, each still tied to the sheet it was cooked from |

Sakadane will open on **v1.0** instead of v1.1-beta.1, with "Testing: Test 4 ·
more water" in the strip.

Correction after running the migration on a copy of live: Sakadane's working
copy is **not** "has changes". It was saved as Test 4 in the same click, and
Test 4 was edited in place later, so the working copy is older than Test 4.
The rule stays the one live already used: a working copy older than what it's
compared with has no changes of its own. To keep that rule honest,
`entries.updated_at` now moves only when the text or tags change, so renaming
or closing a test can't hide real changes.

**The four recipes with only betas** (cultured-butter, koji-cultured-butter,
sakadane-shokupan, soyashimizu-sakadane-starter) open on their newest test,
with "No version yet. Adopt this test to make v1.0". No versions are created
automatically, because that would be inventing decisions.

## 10. Phases

Each phase ships on its own and keeps the old data readable. Every phase
includes:
- store tests on the new in-process Postgres harness (`test/support/pg.js`);
- unit tests for the pure parts;
- a Playwright run on a local copy of Sakadane, with screenshots and the
  contrast sweep;
- a short live check limited to `audit-sandbox-claude`.

**P1: promote fix, shipped** (`9252466`).
- Promoting now copies the beta to a new row, and the beta keeps its id and
  cook logs. Store tests cover beta → release, re-release, a duplicate version
  string, and releasing the draft.
- Stale-base promotes still copy (§4.1) until phase 1's merge.
- **Live check:** on the sandbox, promote v1.0-beta.1 to v1.2 and check that
  it appears and that v1.0-beta.1 still has its cooks. (Because of §4.1,
  v1.2's text will then be v1.0-beta.1's, which is a fine thing to see on the
  sandbox.)

**Phase 1: names, default view, safe adopt.** Built. Also in it: the 3-way
merge now works per run of changed lines (it used to treat everything between
the first and last change as one edit, so two changes far apart always
collided), and an edit made on both sides is applied once instead of twice.
- Schema columns and migration steps 1–3 and 6; derived API fields.
- Interface wording across all screens (§6).
- The Overview always lands on the current version, and Print and "Log this
  cook" use what's on screen.
- The Editor tab always edits the working copy; "Fix a typo in v1.1…" for
  in-place fixes.
- The release dialog loses its status select. Adopt merges with a stale base
  and refuses on conflict.
- "Save as Test N…" with a Testing line.
- **Tests:** migration on a copy of each live recipe shape (numbering, closing,
  re-run safety); adopt with a current base, a stale base and a conflicting
  base; default view.
- **Live:** Sakadane opens on v1.0, and its strip shows Test 4. The sandbox
  shows Tests 1… and v1.0/v1.1.

**Phase 2: fixed tests, print stamping.** Built. Printing the working copy
when it has nothing of its own prints the sheet it matches; with changes, the
print page asks for the Testing line and saves the test first. The cook modal
already starts from the newest unrecorded print.
- Tests read-only in the API (PUT on a test returns 409 with "make a new
  test") and in the interface.
- The `prints` table, the stamp and footer, and the print-the-working-copy
  rule.
- **Tests:** an edit to a test is refused; printing the working copy creates a
  test; print-record dedupe.
- **Live:** print a sandbox test and check the stamp, then that "Record a cook"
  offers that print first.

**Phase 3: the one-screen cook** (§7, as revised by the audit).
- The new route replaces the modal and the "Mark differences" flow; editing
  a cook reuses it. No `prompt()` remains.
- Inline fields with keyboard flow and background saves, live slip/real
  highlighting with `Units.sameAmount`, Skip toggles, inline notes and added
  steps, "I meant this", "Cooked as written".
- **Tests:** text splicing for every token kind at 1× and 2×; intended keys
  survive edits; save creates exactly the right Cooklang text.
- **Done when:** the audit scenario takes one click to open and about 12
  actions after it, on one screen with no dialogs; "Cooked as written" with an
  outcome takes 3 actions or fewer; a whole cook can be recorded from the
  keyboard after the first click.
- **Live:** record a sandbox cook from a printout without opening any other
  screen.
- **Built.** Measured on a copy of live with the audit's scenario (v1.1
  printed at 2×; flour, water and the rest time changed, Cool skipped, a
  note, outcome, try next): one click opens the screen with the sheet,
  scale and date filled in; the rest is 17 actions counting every click,
  typed entry and key press, on one screen, no dialogs. Editing a value
  repaints nothing and moves nothing below it (measured: 0 px). "Cooked as
  written" with an outcome is 3 actions. Keyboard only works end to end.
  Decisions made while building it:
  - On a desktop, a new cook opens with the first value focused, so typing
    starts at once (not on touch screens, where it would open the keyboard).
  - Tab visits the values, plus any step whose values are all in the
    ingredient list, so every step can be reached; Alt+S skips the step
    you're on, Alt+N adds a note under it, Ctrl/Cmd-Enter is Done.
  - In a step, "I meant this" shows when you're on the value (or once
    ticked), so labels of neighbouring values don't collide; in the
    ingredient list it's always shown.
  - A value the ingredient list shows isn't repeated with "was …" in its
    step, only highlighted.
  - Values show as written in the sheet. A temperature written in words
    ("450F") stays text; `^{450%F}` is editable.
  - The parser keeps no timer names, so timers' "I meant this" keys count
    by position.
  - The photo of the sheet is not built.
  - After Andrew's run: a note added while recording can be fixed by
    clicking it (empty removes it); Skip, Note and Done show their
    shortcuts. Fixed: ranges showed their unit twice ("1-2 min min"); a
    skipped step's values weren't struck through; and a step's nth value
    was counted differently by the server when an ingredient without an
    amount came first ("@pepper{}", "@oil"), which also affected
    "Adopt from this cook".
  - Next: the print record keeps the temperature unit and unit choices,
    and the cook screen shows values as printed.

**Phase 4: the test page and decisions.**
- The test page; the comparison table (rows that differ plus the tested rows,
  at 1×, ≈ greyed, intended highlighted).
- Adopt (as written, or from a cook with pre-ticks), New test from a cook, and
  Stop testing.
- "Adopted as" on tests and cooks, and the changelog generated from the diff.
- **Tests:** table rows for 2 cooks at different scales; adopt as written
  ignores slips; adopt from a cook takes the ticked changes only; the
  double-adopt warning.
- **Live:** cook a sandbox test twice and adopt it.
- **Built.** The test page is the Overview of a test (`views-recipe-test.js`);
  the table comes from the cook screen's value model (`CookSheet.comparison`),
  so a row is "the nth water", the same key as "I meant this". Adopt shows,
  before it's clicked, whether it merges cleanly or conflicts (Adopt is then
  disabled), fills "What changed" from the real changes ("water, step 2:
  15 → 30 g"), and offers "as written" or what one of the cooks did; the
  per-change checklist comes with the "I meant this" changes ticked, and its
  "What changed" follows the ticks. The checklist's tags say "changed",
  "within the sheet's range", "added", "skipped". Not built: the cooks of an
  earlier, re-based test (phase 5).

**Test names, after Andrew's review (Nov 2).** Tests are named by the
version they were made from: "v1.1 · Test 2" is the 2nd test made from v1.1,
and a test made before any version is plain "Test 1". The number is stored
when the test is saved (`test_base`, `test_seq`; existing tests were numbered
once, in creation order), so deleting a test renames nothing. Pages are
`/tests/v1.1-2`; the old `/tests/4` links still work. "Based on v1.0" is gone
where the name already says it; a test behind the current version says
"v1.2 is newer".

**After the second review (Nov 2).**
- Adopting from a cook of a test lists the test's own changes in the
  checklist (ticked, fixed, "tested") and the changelog names both: "salt:
  2 → 1 g (tested); water: 75 → 85 g (Cook 1)".
- Cooks are ordered by the day cooked, then by when they were saved, so two
  cooks of the same day (both stored at noon) number oldest first.
- Done after recording a test's cook returns to the test's page.
- Rows of the cooks table that every cook left empty are hidden.
- After adopting, a working copy with nothing of its own moves onto the new
  version, so the next test is "v1.3 · Test 1".
- **The cook screen matches the paper.** A print records how it showed the
  amounts (`prints.display`: temperature unit and per-ingredient units); a
  cook keeps its print's (`cook_logs.display`). Values show the same way
  (header: "as printed: °C, water in oz"), a bare number is read in the shown
  unit, and what's typed is saved in the recipe's own unit (230 °C →
  `^{446%F}`, 6 oz → `@water{170%g}`), so the text keeps one set of units.

**Phase 5: re-basing. Dropped** (Nov 2). It only matters when tests run in
parallel, adopting an older test already merges correctly, and the test says
when a newer version exists. Kept below for the record.
- "Re-base on v1.2" makes Test N+1 from the 3-way merge and closes the old test
  as re-based. The new page carries the old cooks as earlier evidence.
- **Tests:** a clean re-base, a conflict, and that the earlier evidence shows.
- **Live:** adopt one sandbox test, then re-base the other.

## 11. Not in scope

- Checkboxes and timers: no change.
- Branches: stay API-only, untouched; tests live on the main branch.
- Multi-user: one owner.
- Undo for adopt beyond the existing version delete.

**Figures per cook (Nov 6).**
- The cooks table opens with the recipe's shown figures (hydration, salt %),
  for the base, the sheet and each cook, every cook at the sheet's 1× (a 2×
  cook is parsed back at ½). A sheet with a range ("365-380 g water") shows
  its figure as a range (73-76%); a cook's figure inside that range is a
  choice the sheet allowed and isn't marked changed. One outside it is.
  (`CookSheet.metricRows`.)
- Setting an amount from a figure ("make it 75%") was considered and left
  out: it means solving formulas backwards (which ingredient moves, two
  figures sharing one, scaling, cook edits). The range plus each cook's
  figure covers the need.

**Photos belong to cooks (Nov 6).**
- A photo is of a cook: added on the cook screen (optional, several at
  once; a big phone photo is shrunk to 2000 px JPEG first), shown on the
  cook's card, as a thumbnail over its column in the test's cooks table,
  and in the photo strip of the sheet it was cooked from, captioned with the
  cook. Deleting the cook deletes its photos (the confirm says so).
- Upload to a sheet (and to the working copy, whose photos were deleted on
  release) is gone. Photos already attached to a sheet stay and still show
  in its strip. The recipe's cover stays its own upload in Settings.

**Tests editable until cooked (Nov 8).**
- Locking a test the moment it was saved got in the way: a test saved, read
  over and found wrong before it was ever printed couldn't be fixed, only
  replaced by the next test number. And a print is recorded on the browser's
  beforeprint, so even a cancelled print dialog counted as "on paper".
- Now a test is `locked` once it has a cook (its cooks are compared with it)
  or is closed. Before that, "Edit" on its page (and in the Versions menu)
  opens it in the Editor; the working copy doesn't change. With a print
  record, it asks first and the Editor says to print again after.
