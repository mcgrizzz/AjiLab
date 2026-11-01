# AjiLab desktop UX/UI audit

> **Implementation status** (updated as findings are fixed)
>
> | Finding | Status |
> |---|---|
> | U1 Iterate / Start next beta overwrite the draft | **Fixed.** Confirm when the draft (or the editor's unsaved buffer) has text not saved in any version, with a line-change summary; Undo toast restores the previous draft (`POST …/draft/restore`); buttons renamed "Start draft from vX" / "Replace draft with vX…"; same guard on cook-log "Load into draft…". |
> | U1 follow-ups (review) | **Fixed.** Unsaved editor text is only dropped after the replace succeeds; danger dialogs focus Cancel and use a filled red button; Undo asks before discarding edits made since the replace. |
> | Index rows not keyboard-reachable (review) | **Fixed.** Rows are real links (Tab, Enter, Cmd/Ctrl-click for a new tab). |
> | U2 New-cook-log form loses notes | **Fixed.** Backdrop/Esc no longer close a modal with typed input; unsent log fields kept in `sessionStorage` per recipe/branch until created. |
> | U7 Recipe delete easier than version delete | **Fixed.** Typed recipe-name confirmation; version Delete moved to a ⋯ menu. |
> | U8 Bare "Viewing" badge | **Partly fixed.** Draft state is labelled and offers Open Editor; badge/sidebar wording still open. |
> | U10 Ambiguous amounts toggle | **Partly fixed.** Now "Amounts in steps: On/Off". Check-offs, timers, scale on cook logs still open. |
> | U12 Index badge / + button | **Partly fixed.** Neutral in-progress badge, "New recipe" label. Sorting and activity dates still open. |
> | U14 Scrollbar layout shift | **Partly fixed.** `scrollbar-gutter: stable`. Nested sidebar scroll still open. |
> | A3 Native controls / focus | **Partly fixed.** Accent `:focus-visible` ring. Select styling still open. |
> | A5 Duplicate modal note | **Partly fixed.** Duplicate removed. Other items still open. |
> | U4 False-positive cook-log diffs | **Fixed.** Amounts are compared after unit conversion via the shared `Units.sameAmount` (`public/js/units.js`, used server-side through `src/quantity.ts`): `450°F` vs `^{450%F}`, 1 L vs 1000 ml and min vs minutes no longer flag; same-unit numeric edits (26.5 → 27 °C) still do. U3 should reuse it. |
> | Unit popover review | **Fixed.** Popover flips/clamps on screen; chosen units step down for small rows (cups → tbsp); US units as fractions within 3%, metric as decimals; larger fraction glyphs; errors name the ingredient ("Spaghetti is measured by weight. Try g, oz or lb."). |
> | U3 Version compare | **Fixed.** Order is metrics (hydration +26.7 pts) → ingredient totals → method, with metadata and the raw diff collapsed. Ingredients compare per-name totals after unit conversion (water 265 → 380 g); a disappearing + appearing ingredient that share a word and kind of measure show as a swap (AP flour 360 g → Bread flour 375 g); amounts within 2% across units (1 cup vs 240 ml) show as "≈ same amount". Both sides of a step are compared as the reader sees them (`@flour{45%g}` → "flour (45 g)", `^{450%F}` = "450 °F"), steps are numbered as on the Overview, renamed sections pair up, and frontmatter is a Metadata list rather than "Step 1". Defaults to current best → selected version and runs when opened or when either side changes. Cook-log highlighting stays strict (0.5%). |
> | U3 follow-ups | **Fixed.** Bare `C` in an ingredient amount is a cup (rewritten to the parser's `c` before parsing; `^{…%C}` stays Celsius), and comparisons decide temperature by token context. Punctuation-only edits merge into one phrase; metadata rows show a word-level diff; step temperatures follow the Temps toggle (`?temp=C\|F`). Still open: pairing steps by similarity so an inserted step reads as added. |
> | U5 Page hierarchy | **Fixed.** Overview: "Log this cook" is the one filled button (logs the version and scale shown), Print beside it, "Release…"/"Promote…" in a neutral outline. The Promote dialog shows how many cooks are logged on that version, and at what scale (warning when none), with a link to its changes from the current best. Cook Logs cards have no filled buttons. Cook logs record a fixed scale: amounts are as cooked (source × scale), compared with the scaled source, and divided back to 1× on promote or fork; a "2×" badge shows on the card, Latest Cook Log, and in the Promote dialogs. |
> | A4 Loud diff colours | **Fixed** in the compare panel: thin tinted left rules, colour on the values only; swaps get their own dashed rule. |
> | U9 Editor friction | **Fixed.** Sticky toolbar with one save pill (Saved / Saving… / Unsaved, "Not saved · Retry" on failure). On a draft, the old "Save" was really a beta snapshot, so it's now "Save as new beta" (autosave handles saving). Release/Promote moved from the bottom banner into the toolbar as a neutral outline. On wide screens source and preview scroll separately and the preview follows the cursor's step. Syntax and metadata help sit together above the editor (collapsible). A notice offers a one-click fix either way when the `title:` line differs from the recipe's name. Preview steps show amounts, following the Overview's "Amounts in steps". |
> | U6, U11, U13, A1, A2 | Open. |

**Audited:** October 31, 2026, on the live deployment (`aji.bridgewater.epi.land`), commit `a42d4c2`
**Viewport:** 1444 × 1241 desktop, dark theme, Chrome
**Method:** I walked through the home index, Sakadane Country Loaf (Overview, Editor, Versions, Compare, Cook Logs, New-log form, Promote modal, Recipe menu), TEST (a long draft-only recipe) and Bagels. I read the frontend source to confirm the behavior behind each finding. **This was read-only.** An in-page guard blocked every POST/PUT/DELETE except the read-only `/draft/parse` preview, and the guard logged zero blocked writes. I did not save, release, promote, upload or delete anything.

Priority: **P0** can destroy work · **P1** misleads or blocks a core task · **P2** friction · **P3** polish. UX findings come first and aesthetics follow, as you asked.

---

## Status of the September audit

| Sept finding | Status |
|---|---|
| #1 New log source ≠ displayed version | **Fixed.** Viewing Draft → the form proposes "Current draft". |
| #3 UTC shown as local time | **Fixed.** Shows `03:54 PM` with "Local time (America/New_York)". |
| #6 Frontmatter shows up as "STEP 1" in compare | **Fixed** with U3. |
| #8 Dim dark-mode syntax and secondary text | **Still open** (see A1). |

---

## What already works well

- The Overview layout is strong: a sticky ingredients sidebar, a readable step column and a context sidebar (current best and latest log).
- Scaling is quick: you get presets plus a custom value, and the scale lives in the URL (`?scale=1.5`), so it survives reloads and links. Inline step amounts scale too.
- Semantic chips (ingredients, cookware, timers, temperatures) make steps easy to scan.
- The "Recipe as cooked" view (`360 g → 375 g`, strikethrough → new value, left accent on changed steps) is the best part of the app. It shows exactly what changed during a cook.
- Deleting a version requires typing its name, which is the right level of friction.

---

## UX findings

### U1. P0: "Iterate" and "Start next beta" silently overwrite the draft
**Observed:** Each version row has **Iterate**, and the Overview's Current Best card has **Start next beta**. Both call `forkVersionAndEdit` → `POST …/versions/:v/fork`, which runs `UPDATE entries SET cooklang_text = …` on the existing draft. Neither asks for confirmation. Sakadane's draft currently differs from v1.1-beta.1: the Starter metric is missing, and you can see that by toggling the version picker. One click on either button would silently replace that work.
The same action from a cook log (`fork-to-draft`) *does* show a confirm ("The current draft has unreleased changes…"), so the protection is inconsistent.
**Also:** The label "Start next beta" is misleading. It doesn't create a beta. It replaces the draft with v1.0.
**Fix:** If the draft differs from its parent, show a confirm with a short diff summary. Better still, snapshot the old draft automatically so the action can be undone. Rename both buttons to say what they do, e.g. "Replace draft with v1.0…". Code: `views-recipe-viewer.js` `forkVersionAndEdit`, `recipe-store.ts` `forkVersionToDraft`.

### U2. P1: The New-cook-log form discards typed notes on a stray click or Esc
**Observed:** I typed an outcome, clicked the dimmed backdrop, and the modal closed. When I reopened it, the field was empty. `app.js` closes *any* modal on backdrop click or Escape, with no dirty check. This is the form where post-cook observations get typed, and the editor got buffer protection last round but this form didn't.
**Fix:** Turn off backdrop-to-close for forms (or ask first when they're dirty). Keep the unsent log in `sessionStorage` keyed by recipe/branch until it's submitted.

### U3. P1: Version compare shows wrong numbers and buries what matters
Comparing v1.0-beta.2 → Draft on Sakadane:
- **The "Ingredients (totals)" section doesn't show totals.** Water shows `265 g → 30 g (−88.7%)` plus a separate `+ 350 g water`. The real change is 265 → 380 g (+43%). The flour rename shows as two removals and two additions instead of `AP flour 360 g → Bread flour 375 g`. Anyone skimming would draw the wrong conclusion.
- **Frontmatter still shows up as "STEP 1"**, with the full source URL and metric formulas.
- **The two sides render differently.** The old side shows rendered values (`23°C–25°C`), and the new side shows raw Cooklang (`^{23-25%C}`, `~{2.5%hours}`).
- **Step labels use per-section numbers** ("Bake · Step 3"). The Overview numbers steps globally (15), so you can't cross-reference them.
- **Ingredient changes come after step changes**, and metric deltas (hydration 9x% → 98.3%) aren't shown at all. For a baker these are the headline.
- **The defaults are arbitrary.** "From" is the *second-oldest* version (`options[length-2]`). Opening the panel shows a spinner that never resolves until you click Compare, because `runCompare` only runs on the button.
**Fix:** Aggregate ingredients by normalized name and show metric deltas at the top, then ingredients, then method. Move frontmatter into a collapsed "Metadata" group. Render both sides the same way. Default to *current best → selected version* and run the compare automatically on open.

### U4. P1: Cook-log diffs flag changes that didn't happen
**Observed:** In the 24 May log, step 15 is highlighted as changed with `450 °F → 450°F`. Only the whitespace or format differs. False positives teach the user to ignore the highlighting.
**Fix:** Compare normalized values (same quantity, unit and temperature after conversion) before marking a token as changed.

### U5. P1: The page hierarchy favors managing releases over cooking
- **Overview:** The only primary (filled) button is **Promote v1.1-beta.1…**, a high-consequence publish action. Its label is also truncated. There's no "Log this cook" or "Print" here. Print is buried in the gear's "Recipe menu", or Ctrl+P, which isn't discoverable.
- **Cook Logs:** Every card has a filled orange **Mark differences** and an outlined **Promote to release**, which puts five primary-colored buttons on one screen.
- **Promote gives no evidence.** v1.1-beta.1 has **zero** cook logs (the latest is from v1.0-beta.3), and the modal neither warns about that nor shows what changed against the current best.
**Fix:** Use one primary action per view. On Overview that should be cooking ("Log this cook", carrying version and scale), with Print as a secondary button. Move Promote to a secondary or overflow spot. In the Promote modal, show "N cooks logged on this version" and the diff against current best, and pre-fill the changelog from it. On log cards, make "Mark differences" secondary unless the log has no recorded deviations yet.

### U6. P1: Branches, a headline feature in the README, can't be found in the UI
**Observed:** The API has `POST /recipes/:slug/branches`, but no frontend code calls it. The branch selector only renders when `branches.length > 1`. A user can't create a branch or even learn that branches exist.
**Fix:** Add "New branch from this version…" to the version row overflow menu, and always show the branch name (`main`) beside the version picker.

### U7. P1: Deleting a whole recipe is easier than deleting one version
**Observed:** Deleting a version needs a typed confirmation. Deleting the *whole recipe* (every version, photo and cook log) uses a native `confirm()` (`views-recipe-viewer.js:370`). Every version row also has a red inline **Delete** right next to Iterate.
**Fix:** Require typing the recipe name for recipe deletion. Move version Delete into an overflow menu.

### U8. P2: Viewing state and available actions are unclear
- Switching to **Draft** in the version picker shows a bare **"Viewing"** badge with nothing after it. The `primaryLabel = 'Viewing'` fallback hits this case, and the banner shows no actions (no Release or Edit), even though the draft is editable.
- The meaning of the header badges ("Best: v1.0", the picker value and "Latest · …") isn't explained, and they change between tabs.
- The sidebar's "Current best" card and "Latest cook log" card show the same sentence ("Even better flavor…"), so it's unclear whether that's a changelog or a log outcome.
**Fix:** Label every state ("Viewing · Draft (unreleased)") and always offer that state's next action. Prefix sidebar text with its type ("Changelog:" / "Outcome:").

### U9. P2: Editor friction
- The toolbar (`Editing Draft · Saved · [Save]`) scrolls off-screen. The source and preview scroll as one page, so on long recipes the preview drifts away from the line you're editing.
- "Saved" sits next to a "Save" button. With autosave, the button reads as either redundant or a hint that something isn't saved.
- **Release version…** is a full-width orange bar at the very bottom with left-aligned text. It looks like a banner, not a button.
- The syntax hint is at the top, but the metadata snippet chips are at the bottom, below the code.
- The frontmatter `title: Sakadane Country Bread` disagrees with the recipe title "Sakadane Country Loaf", and the UI doesn't say which one wins.
- Preview steps omit inline amounts (`Bread flour`), while Overview shows `Bread flour (75 g)`.
**Fix:** Make the toolbar sticky. Scroll each pane on its own with synced scrolling. Replace Save/Saved with a single status pill (Saved / Saving / Unsaved ⟳ Retry). Put Release in the toolbar. Warn when the frontmatter title differs from the recipe title.

### U10. P2: No cooking aids on the recipe view
Ingredients can't be checked off, steps can't be marked done, and timer chips aren't clickable, even though timers are already parsed (e.g. `40 min`, `18-24 hours`). The **"✓ Hide amounts"** toggle has an ambiguous state: the checkmark appears while amounts are *shown*. Scale isn't carried into a new cook log.
**Fix:** Let users check off ingredients and steps (kept per session in `localStorage`), and make timers start a countdown on click. Rename the toggle to a clear on/off "Amounts in steps". Record scale on the cook log.

### U11. P2: The cook-log feed hides the most useful content
Cards show only the one-line outcome. **"Changes to try next"**, the input for the next iteration, sits inside a collapsed "Details" toggle on only one card. The expanded recipe sits in a narrow column with a ~250 px empty left gutter. Per-step actions hide behind faint ⋮ icons.
**Fix:** Show *Changes to try next* inline on each card. Use the full card width for the expanded recipe. Show step actions on row hover.

### U12. P2: The home index doesn't help you pick up where you left off
It's a single list stretched across 1444 px. It shows no last-cooked or last-edited date, no tags, and no sorting. The red **"Draft in progress"** badge on TEST reads like an error. A search with no results doesn't offer "Create 'zzqx'". The **+** button has no text label.
**Fix:** Sort by recent activity, and show "Last cooked May 24 · 4 logs". Make the draft badge neutral. Label the button "+ New recipe".

### U13. P2: Ctrl+P is hijacked and immediately opens the native print dialog
Ctrl+P navigates to `/print` and immediately calls `window.print()`, so there's no preview and no options (version, scale, include notes). During this audit, that dialog blocked browser automation until it was dismissed by hand.
**Fix:** Show the print view with options and let the user press Print. Given your paper-first workflow, put Print beside the recipe title.

### U14. P3: Layout shifts and nested scrolling
- Pages without a scrollbar (Versions, Cook Logs) shift the header horizontally compared with pages that have one: the gear and + buttons jump. Use `scrollbar-gutter: stable`.
- On long recipes (TEST), the sticky ingredients panel gets its own inner scrollbar inside the page scroll.

---

## Aesthetic findings

### A1. P1: Contrast and type size (still open from September)
Measured on the live page: `.text-muted` **3.4:1 at 12.8 px**, sidebar card titles **3.4:1 at 11.8 px**, badges **3.1:1 at 11.5 px**. All are below WCAG AA's 4.5:1 for small text. Editor syntax colors (dark green and brown on near-black) are still hard to read. Body copy sizes of 11.5–12.8 px are common.
**Fix:** Set a floor of ≥ 4.5:1 and ≥ 13 px for anything functional. Use separate, brighter syntax tokens for dark mode.

### A2. P2: Color meanings overlap
Orange is used for primary buttons, ingredient amounts, the active tab, the linked-recipe chip and the selected scale. Green is used for ingredient chips, the "released" badge and "from v1.0-beta.3" tags, so betas are green there but amber everywhere else. Amounts are orange on Overview but green in the editor preview.
**Fix:** Give each color one job. For example, accent = action/selection, green = released, amber = beta, and use one neutral-warm tone for quantities everywhere.

### A3. P2: Native controls break the visual language
The version picker, compare selects and log Source select are unstyled native `<select>`s with the OS blue highlight. The search box shows WebKit's blue clear "×". Focus rings use the default near-black `auto` outline, which is barely visible on the dark background.
**Fix:** Style the selects, or use a custom popover for the version picker, which would also make room to show status and log count per version. Style the clear button. Add a visible `:focus-visible` ring in the accent color.

### A4. P3: Diff colors are too loud
The compare panel's full-width saturated red, amber and green bars outweigh everything else on the page and clash with the muted notebook palette used elsewhere. Use thin left rules with tinted text, as the cook-log diff already does well.

### A5. P3: Typography and smaller details
- Three families: Lora headings, Nunito Sans body and monospace. Version strings are monospace on the Versions tab but sans everywhere else. Pick one treatment.
- Recipes without photos fall back to a 🍽 emoji tile. A monogram or neutral pattern would fit the palette better.
- Full-width pages (Versions, index, Cook Logs) have long empty right-hand areas. Use a max-width that matches the recipe page (~1100 px).
- The New-cook-log modal is ~390 px wide on a 1444 px screen, and its "use Mark differences afterwards" note appears twice. Widen it to two columns and remove the duplicate.

---

## Suggested order

1. **Protect work:** U1 (overwrite confirm or auto-snapshot), U2 (modal dirty guard), U7 (recipe delete).
2. **Make the data trustworthy:** U3 (compare totals and rendering), U4 (false-positive diffs).
3. **Re-center on cooking:** U5 (one primary action; put Log and Print on Overview), U10, U11, U13.
4. **Make features discoverable:** U6 (branches), U8, U9, U12.
5. **Polish:** A1 (contrast) first, then A2–A5 and U14.
