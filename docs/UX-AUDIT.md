# AjiLab UX/UI audit: the experimental chef

Audited September 8, 2026. Documentation/screenshots commit: `ac1b19e`.

## Follow-up: fixes and design direction

Findings 1–3 have been addressed in the local working tree: the cook-log form follows the selected version or draft; editor buffers retain unsaved text and tags across navigation/reloads with visible status and retry; timestamps use local wall-clock time and preserve the original instant when only notes change. Browser verification intercepted all writes. The original findings below describe the audited behavior, not the updated implementation.

**Published versions are intentionally editable.** Keep that behavior. The proposed middle ground is a stable public label such as `v1.0` pointing to its latest revision, with prior revisions retained underneath. Ordinary recipe views show only the latest content. An optional History view offers timestamped diffs and restore; restoring creates another revision. Cook logs retain the exact source snapshot used. Corrections should not force a new public version number.

**Design for print, annotate, then transcribe.** The current workflow is paper-first. A useful next increment is a printable cook sheet tied to an exact recipe copy, with version, scale, date, and space for actual quantities, timing, results, and next changes. A short link or QR code could reopen that copy in a focused “Record this cook” screen. Let the chef attach a photo of the marked-up sheet and enter only deviations and results. This is a proposal; print snapshots, revision history, and the transcription screen are not implemented in this pass.

After that workflow is comfortable, add optional measured fields and compare completed cooks side by side. Avoid requiring a detailed experimental plan or a phone at the workbench for every cook.

## Assessment

AjiLab has useful foundations for recipe experimentation: Cooklang, live derived metrics, recipe references, version comparison, and cook logs that preserve a source snapshot. The biggest opportunity is to make the **cook session** as clear and reliable as the recipe editor.

A chef should be able to answer: **What did I start with? What did I change? What actually happened? What evidence supports the next change?** Today, some of those answers depend on remembering a version selector, editing a log after creation, or reconstructing the experiment from prose.

Prioritize record integrity and workflow clarity before adding more visual polish.

## Scope and method

Inspected the running app through the supplied Tailscale address in dark mode, at 1440 × 1000 desktop and 390 × 844 mobile viewports. Walked through Bagels and Sakadane Country Loaf: overview, editor, published-version editing, version comparison, cook-log feed, new-log form, and recipe menu. Checked relevant local code to corroborate behavior.

Browser requests that could change stored data were blocked. The read-only parsing endpoint remained available. Local editor text was used to test navigation and failed-save behavior; no recipe changes were saved. Successful writes, promotion, branch creation, concurrent editing, and actual kitchen use were not tested. Recommendations below are design judgments, not findings from chef usability interviews.

## Preserve these strengths

- Ingredient quantities, equipment, timers, and temperatures are visually distinct in the cooking view.
- The editor puts formulas and computed results close together on desktop.
- Cook logs separate the source recipe from the recipe as cooked. The database stores both texts; preserve this foundation.
- “What worked,” “Problems found,” and “Changes to try next” encourage useful reflection.
- The subdued palette and typography suit a personal notebook. Improve hierarchy and legibility without replacing that character.

## Findings

### 1. P1 — A new cook log can start from a different version than the displayed recipe

**Observed:** Sakadane Country Loaf opens on `v1.1-beta.1`, with `Best: v1.0` also displayed. Opening **New cook log** selects `v1.0` as its source. The form defaults to the current best release, rather than the selected recipe version.

**Chef impact:** A cook using the beta can accidentally record results against the stable recipe. Subsequent comparisons start from the wrong baseline, even if the notes are accurate.

**Recommendation:** Add **Start cook / Log this version** beside the displayed recipe. Carry the selected version, branch, and scale into the session explicitly. Show a persistent line such as “Cooking v1.1-beta.1 · main · 1×”; do not silently substitute the best release. If the user starts from the general log feed without a selected source, make source choice explicit.

**Acceptance:** Starting a log from a selected beta proposes that beta. An intentional source change is visible before creation. A scaled cooking session retains its scale and quantities.

Code: [default recipe selection](../public/js/views-recipe-core.js), [new-log source default](../public/js/views-recipe-cook-logs.js), functions `defaultActiveVersion` and `openCookLogModal`.

### 2. P1 — Failed saves and navigation can discard observations

**Observed:** With writes blocked to simulate a failed autosave, typing a local note in the beta editor, switching to Overview, and returning to Editor loses the note without a confirmation dialog. A released-version edit also disappears on tab changes without saving. The code debounces autosave by 1.5 seconds and suppresses errors for silent saves.

**Chef impact:** A brief network interruption or a quick tab switch can erase measurements recorded during a cook. The chef has no reliable indication of whether the record survived.

**Recommendation:** Keep an editor buffer keyed by recipe, branch, and editing target. Show persistent **Unsaved / Saving / Saved / Could not save** status. Preserve failed edits locally, offer retry, and protect navigation while work remains unsaved. Bind delayed saves to their original target rather than whichever editor is currently active.

**Acceptance:** Failed-save edits survive tab navigation and reload; errors stay visible until resolved. Released-version edits receive equivalent navigation protection. Test switching targets before the debounce expires.

Code: [editor](../public/js/views-recipe-editor.js), `renderEditorTab` and `saveDraft`.

### 3. P1 — Cook-log timestamps use UTC as local time

**Observed:** With the browser set to America/New_York, the actual local time was 16:46 while the new-log field contained `2026-09-08T20:46`. The default is produced by slicing an ISO UTC timestamp; submission interprets that field as local time.

**Chef impact:** Cook records can be shifted by hours, complicating fermentation notes and the chronology of experiments. Editing an existing log uses the same conversion pattern.

**Recommendation:** Format the input in local time, convert to UTC only for storage, and show the timezone near the field. Separate “started cooking” from “logged at” if session tracking is added.

**Acceptance:** Creating and reopening a log preserves the intended wall-clock time in UTC and non-UTC zones, including daylight-saving transitions.

Code: [cook-log form](../public/js/views-recipe-cook-logs.js), `openCookLogModal` and `saveCookLog`.

### 4. Design decision — Keep editable releases, with revisions underneath

**Observed:** Opening released `v1.0` in the editor allows **Save changes** to overwrite it. The warning is explicit, which is good, but editing the released recipe remains available. Betas are also editable in place. “Save” has different consequences for a draft, beta, release, and cook log.

**Chef impact:** Two cooks labeled with the same version can refer to different recipe contents. Existing cook-log source snapshots mitigate this; the issue is that the version label alone no longer guarantees reproducibility.

**Recommendation, revised after discussion:** Keep editing the named release directly. Save revisions underneath it, while showing only the latest copy in normal use. Offer revision history and restore as secondary actions; keep **Start experiment from this version** available for deliberate variations. Label snapshot creation separately from saving work.

**Acceptance:** Every cook can reopen its exact baseline. A published correction retains the prior content and records what changed. Buttons explain whether they save work, create a snapshot, or publish a release.

Code: [released-version warning and save behavior](../public/js/views-recipe-editor.js).

### 5. P2 — Cook logging starts after the outcome, rather than supporting the experiment as it happens

**Observed:** A new log requires an outcome. Actual measurements are adjusted after creation. The form instructs the user to use **Edit recipe**, while the current workflow exposes **Mark differences** and opens that panel after creation.

**Chef impact:** The user must reconstruct quantities and decisions after cooking, when small deviations are easy to forget. There is no visible place in this form to state the hypothesis before seeing the result.

**Recommendation:** Support a lightweight session lifecycle: **Planned → Cooking → Evaluated**. At start, capture the baseline and one optional “What am I testing?” field. During cooking, make deviations and observations quick to enter. Request the outcome at completion. Retain a fast retrospective-log path and fix the existing instructional copy immediately.

**Acceptance:** A session can be saved before an outcome exists; the baseline remains fixed; deviations are recorded against it. The UI distinguishes unreviewed copied quantities from confirmed “as cooked” measurements.

Code: [log form and post-create flow](../public/js/views-recipe-cook-logs.js), [snapshot storage](../src/recipe-store.ts).

### 6. P2 — Comparing text is easier than comparing experimental outcomes

**Observed:** The country-loaf feed shows four useful outcome summaries and filters by source version. It does not present the runs side by side with their measurements. In the Bagels version comparison, frontmatter and a long source URL appear as “STEP 1” before the meaningful dough changes.

**Chef impact:** It takes manual reconstruction to answer “Did the extra fermentation improve the crust?” or “Which runs produced the best flavor?” Metadata noise also competes with changes that affect the food.

**Recommendation:** Separate comparison into **Ingredients / Method / Metadata**, with raw text secondary. Add an optional run table showing source, hypothesis, changed variables, actual measurements, outcome, and next action. Start with a few user-defined numeric or categorical fields with units; retain prose. Distinguish measured values from formula-derived values, and show missing data explicitly.

**Acceptance:** A chef can compare two runs without opening multiple editors. A source-URL change does not appear as a cooking step. Hydration or timing differences can be read alongside outcomes, without implying that one uncontrolled run establishes causation.

### 7. P2 — Mobile prioritizes recipe management over the active cook

**Observed:** At 390 px, the Cook Logs tab is partially offscreen. The overview puts promotion, metrics, and the ingredient list before the method; the first screen contains no cooking steps. The editor initially shows mostly frontmatter. Controls measured approximately 24–32 px high include grouping, scaling, temperatures, and log filters. The new-log form places Source and Cooked at side by side, truncating the date/time display.

**Chef impact:** With a phone on a flour-covered counter, navigation and precise taps compete with cooking. Recording a deviation is less accessible than releasing a recipe.

**Recommendation:** Add an explicit cooking mode with a sticky **Ingredients / Method / Log** switch and a prominent quick observation action. Use generous touch targets, around 44–48 px for frequent cooking controls. Stack narrow form fields, make all primary tabs discoverable, and provide **Write / Preview** switching in the mobile editor. Keep promotion in the review workflow.

**Acceptance:** At 390 px, Method and Log are reachable without searching or horizontal tab discovery. The complete date/time can be read. Frequent actions work comfortably with one thumb.

### 8. P2 — Dark-mode secondary text and editor syntax are difficult to read

**Observed:** Green and brown syntax tokens are subdued against the dark editor. Labels and instructional text are also low emphasis, particularly on the mobile log form. The overall page palette works better than these smaller details.

**Chef impact:** Ingredient syntax and units are precisely the details that must remain legible under imperfect kitchen lighting. Low-emphasis instructions can conceal important source and saving behavior.

**Recommendation:** Give dark mode its own brighter syntax colors, strengthen essential labels, and reserve faint text for genuinely optional information. Keep status words alongside color. Check computed contrast and real phone readability before choosing final colors.

**Acceptance:** Ingredients, units, timers, and field labels remain easy to distinguish at normal text size. Validate the final palette rather than treating this visual review as a formal accessibility certification.

## Suggested sequence

1. **Protect the record:** save-state recovery, local-time handling, selected-source propagation, and clearer save/snapshot labels.
2. **Make the cook session explicit:** frozen baseline, planned change, quick deviations, optional in-progress state, and mobile cooking navigation.
3. **Make results comparable:** structured optional observations, a run comparison table, and less noisy recipe diffs.
4. **Polish the interface:** contrast, touch targets, clearer form layout, and progressive disclosure of metadata.

The first implementation pass addresses findings 1–3. Validate those changes in normal use before committing to the larger experiment model.

## Proposed session model

| Stage | Primary question | Information to preserve |
| --- | --- | --- |
| Plan | What am I testing? | Exact baseline, branch, batch scale, hypothesis, intended variable change |
| Cook | What did I actually do? | Actual quantities, temperatures, timing, observations, photos |
| Evaluate | How did it turn out? | Outcome, optional measurements or ratings, uncertainty, next change |
| Adopt | What belongs in the recipe? | Selected successful changes, supporting cook logs, new revision |

Treat this as a suggested direction to validate with a few real cooks, not a requirement to turn every recipe into a laboratory form.
