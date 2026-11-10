// The cook screen's value model (public/js/cook-sheet.js) against the
// server's parser and step actions: every value the screen finds must be the
// one the server changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  parseCooklang, scaleCooklangText, updateStepQuantity, applyStepDeviation,
  insertNoteAfterStep, insertStepAfterStep, annotateCookLogDiff,
} from "../src/cooklang.ts";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(read("../public/js/units.js"), context);
vm.runInContext(read("../public/js/cook-sheet.js"), context);
const CookSheet = vm.runInContext("CookSheet", context);
const plain = (value) => JSON.parse(JSON.stringify(value));

const SHEET = `---
servings: 2
---
= Dough
Mix @bread flour{220%g}, @water{140%g} and @salt{2-3%g}.

Rest ~{1%min}, then knead ~knead{5%min}.

= Bake
Add @water{10%g} and bake at ^{450%F} for ~{30-35%min}.

Proof at %{24%C} until doubled.

Cool.`;

const fieldsOf = (text) => plain(CookSheet.buildFields(parseCooklang(text).steps));
const values = (fields) => fields.map((f) => `${f.kind}:${f.name}:${f.current.quantity} ${f.current.units}`);

for (const scale of [1, 2]) {
  test(`every value the screen finds is the one the server changes (${scale}×)`, () => {
    const text = scaleCooklangText(SHEET, scale);
    const fields = fieldsOf(text);
    assert.deepEqual(values(fields).map((v) => v.split(":").slice(0, 2).join(":")), [
      "ingredient:bread flour", "ingredient:water", "ingredient:salt",
      "timer:", "timer:",
      "ingredient:water", "inlineQuantity:", "timer:",
      "inlineQuantity:",
    ]);
    if (scale === 2) assert.equal(fields[0].current.quantity, "440");
    for (const field of fields) {
      const next = updateStepQuantity(text, field.sectionIndex, field.stepNumber, field.kind, field.index, "777", field.current.units);
      assert.notEqual(next, text, `${field.id} was found by the server`);
      const after = fieldsOf(next);
      assert.equal(after.length, fields.length);
      after.forEach((other, i) => {
        if (i === fields.indexOf(field)) assert.equal(other.current.quantity, "777", field.id);
        else assert.deepEqual(other.current, fields[i].current, `${other.id} untouched when changing ${field.id}`);
      });
    }
  });
}

test("intended keys survive edits: values, skips, notes and added steps", () => {
  const text = scaleCooklangText(SHEET, 2);
  const keys = (fields) => fields.filter((f) => !f.added).map((f) => CookSheet.keyId(f.key));
  const before = fieldsOf(text);
  assert.deepEqual(keys(before), [
    "ingredient|bread flour|0", "ingredient|water|0", "ingredient|salt|0",
    "timer||0", "timer||1",
    "ingredient|water|1", "inlineQuantity||0", "timer||2",
    "inlineQuantity||1",
  ]);
  let edited = updateStepQuantity(text, 0, 1, "ingredient", 1, "300", "g");
  edited = applyStepDeviation(edited, 0, 2, "skipped");
  edited = insertNoteAfterStep(edited, 0, 1, "dough sticky");
  edited = insertStepAfterStep(edited, 0, 1, "!+ Add @water{20%g} more.");
  const after = fieldsOf(edited);
  assert.deepEqual(keys(after), keys(before));
  const added = after.find((f) => f.added);
  assert.equal(added.key, null);
  assert.equal(added.current.quantity, "20");
});

test("a cook that differs from its sheet: original is what the paper said", () => {
  const source = scaleCooklangText(SHEET, 2);
  const cooked = updateStepQuantity(source, 0, 1, "ingredient", 1, "300", "g");
  const parsed = parseCooklang(cooked);
  annotateCookLogDiff(parsed.steps, parseCooklang(source).steps);
  const water = plain(CookSheet.buildFields(parsed.steps))[1];
  assert.deepEqual([water.original, water.current], [{ quantity: "280", units: "g" }, { quantity: "300", units: "g" }]);
});

test("reading a typed value: units, ranges, temperatures; a bare number keeps the unit", () => {
  const grams = { isTemp: false, current: { quantity: "220", units: "g" } };
  const temp = { isTemp: true, current: { quantity: "450", units: "F" } };
  const read = (text, field) => plain(CookSheet.parseTyped(text, field));
  assert.deepEqual(read("225", grams), { quantity: "225", units: "g" });
  assert.deepEqual(read(" 1 cup ", grams), { quantity: "1", units: "cup" });
  assert.deepEqual(read("18 – 20", grams), { quantity: "18-20", units: "g" });
  assert.deepEqual(read("1/2 tsp", grams), { quantity: "1/2", units: "tsp" });
  assert.deepEqual(read("2,5 kg", grams), { quantity: "2.5", units: "kg" });
  assert.deepEqual(read("230°C", temp), { quantity: "230", units: "C" });
  assert.deepEqual(read("230 c", temp), { quantity: "230", units: "C" });
  assert.deepEqual(read("460", temp), { quantity: "460", units: "F" });
  assert.equal(CookSheet.parseTyped("a lot", grams), null);
  assert.equal(CookSheet.parseTyped("230 g", temp), null);
  assert.equal(CookSheet.parseTyped("", grams), null);
  assert.equal(CookSheet.formatAmount({ quantity: "450", units: "F" }, true), "450°F");
  assert.equal(CookSheet.formatAmount({ quantity: "2", units: "" }), "2");
});

test("a change is real, the same amount written differently, or none", () => {
  const field = (original, kind = "ingredient") => ({ kind, isTemp: kind === "inlineQuantity", original, current: original });
  const flour = field({ quantity: "220", units: "g" });
  assert.equal(CookSheet.changeKind(flour, { quantity: "220", units: "g" }), "unchanged");
  assert.equal(CookSheet.changeKind(flour, { quantity: "225", units: "g" }), "changed");
  assert.equal(CookSheet.changeKind(flour, { quantity: "0.22", units: "kg" }), "same");
  const oven = field({ quantity: "450", units: "F" }, "inlineQuantity");
  assert.equal(CookSheet.changeKind(oven, { quantity: "232", units: "C" }), "same");
  assert.equal(CookSheet.changeKind(oven, { quantity: "220", units: "C" }), "changed");
});

test("ingredient list rows: one use in a section is edited there, several in the steps", () => {
  const parsed = parseCooklang(`= One
Mix @flour{100%g} and @water{50%g}, then @water{10%g}.

= Two
Add @salt{2%g}.`);
  const fields = CookSheet.buildFields(parsed.steps);
  const sections = plain(CookSheet.ingredientRows(parsed.ingredient_summary, fields));
  const shape = sections.map((s) => [s.name, s.rows.map((r) => `${r.name}:${r.field ? r.field.id : `x${r.uses}`}`)]);
  assert.deepEqual(shape, [["One", ["flour:f0", "water:x2", "water:x2"]], ["Two", ["salt:f3"]]]);
  assert.deepEqual([...CookSheet.listedFieldIds(CookSheet.ingredientRows(parsed.ingredient_summary, fields))], ["f0", "f3"]);
});

test("cooked-at: quick date choices and a time that's optional", () => {
  const now = new Date(2026, 10, 10, 18, 30);
  const choices = (printed) => plain(CookSheet.dateChoices(now, printed)).map((c) => `${c.id}:${c.day}`);
  assert.deepEqual(choices(new Date(2026, 10, 7, 9).toISOString()), ["print:2026-11-07", "today:2026-11-10", "yesterday:2026-11-09"]);
  assert.deepEqual(choices(new Date(2026, 10, 10, 9).toISOString()), ["today:2026-11-10", "yesterday:2026-11-09"]);
  assert.equal(CookSheet.cookedAt("2026-11-07", ""), new Date(2026, 10, 7, 12, 0).toISOString());
  assert.equal(CookSheet.cookedAt("2026-11-07", "07:45"), new Date(2026, 10, 7, 7, 45).toISOString());
  assert.equal(CookSheet.localTime(new Date(2026, 10, 7, 7, 5)), "07:05");
});

test("old cooks' three note fields read as one", () => {
  assert.equal(CookSheet.joinedNotes({ what_worked: "crust", problems_found: " flat ", freeform_notes: "humid day" }),
    "What worked: crust\n\nProblems: flat\n\nhumid day");
  assert.equal(CookSheet.joinedNotes({ freeform_notes: "" }), "");
});

test("a temperature written in words stays text and doesn't shift the values after it", () => {
  const text = "Preheat to 450F, then bake ~{10%min} and drop to ^{400%F}.";
  const fields = fieldsOf(text);
  assert.deepEqual(values(fields), ["timer::10 min", "inlineQuantity::400 F"]);
  assert.equal(updateStepQuantity(text, 0, 1, "inlineQuantity", fields[1].index, "380", "F"),
    "Preheat to 450F, then bake ~{10%min} and drop to ^{380%F}.");
});

test("ranges show their unit once, and putting one back writes it as it was", () => {
  const text = "Bake for ~{1-2%min}, proof ~{18-24%hours}, add @salt{2-3%g} at ^{23-25%C}.";
  const fields = fieldsOf(text);
  assert.deepEqual(fields.map((f) => CookSheet.formatAmount(f.current, f.isTemp)), ["1-2 min", "18-24 hours", "2-3 g", "23-25°C"]);
  let same = text;
  for (const f of fields) same = updateStepQuantity(same, f.sectionIndex, f.stepNumber, f.kind, f.index, f.original.quantity, f.original.units);
  assert.equal(same, text);
  const typed = CookSheet.parseTyped("20-26 hours", fields[1]);
  assert.equal(updateStepQuantity(text, 0, 1, "timer", 1, typed.quantity, typed.units),
    "Bake for ~{1-2%min}, proof ~{20-26%hours}, add @salt{2-3%g} at ^{23-25%C}.");
});

test("a time is read in the unit chosen beside it, or the one typed; anything else isn't a time", () => {
  const timer = (units, quantity = "20") => ({ kind: "timer", isTemp: false, original: { quantity, units }, current: { quantity, units } });
  const read = (text, field, unit) => plain(CookSheet.parseTyped(text, field, unit));
  const rest = timer("min");
  assert.deepEqual(read("25", rest), { quantity: "25", units: "min" });
  assert.deepEqual(read("2", rest, "hour"), { quantity: "2", units: "hours" }, "the list says hours");
  assert.deepEqual(read("1", rest, "hour"), { quantity: "1", units: "hour" });
  assert.deepEqual(read("90 min", rest, "hour"), { quantity: "90", units: "min" }, "a typed unit wins");
  assert.deepEqual(read("2 hrs", rest), { quantity: "2", units: "hours" });
  assert.deepEqual(read("1h30", rest), { quantity: "90", units: "min" });
  assert.deepEqual(read("1 hr 30 min", rest, "hour"), { quantity: "1.5", units: "hours" });
  assert.deepEqual(read("1:30", rest, "hour"), { quantity: "1.5", units: "hours" }, "h:mm in hours");
  assert.deepEqual(read("1:30", rest), { quantity: "1.5", units: "min" }, "m:ss in minutes");
  assert.deepEqual(read("18-24", timer("hours", "20-24")), { quantity: "18-24", units: "hours" });
  assert.deepEqual(read("1 1/2-2", timer("hours", "1")), { quantity: "1 1/2-2", units: "hours" });
  // The sheet's own spelling is kept, singular or plural to suit.
  assert.deepEqual(read("1", timer("minutes")), { quantity: "1", units: "minute" });
  assert.deepEqual(read("3", timer("minutes")), { quantity: "3", units: "minutes" });
  assert.deepEqual(read("2", timer("hour", "1")), { quantity: "2", units: "hours" });
  assert.deepEqual(read("45 sec", rest), { quantity: "45", units: "sec" });
  assert.equal(CookSheet.parseTyped("20 minz", rest), null);
  assert.equal(CookSheet.parseTyped("a while", rest), null);
  // A timer whose unit isn't a time ("~{1%batch}") is read like any amount.
  assert.deepEqual(read("2 batches", timer("batch", "1")), { quantity: "2", units: "batches" });
  assert.equal(CookSheet.timeUnit("Hrs."), "hour");
  assert.equal(CookSheet.timeUnit("overnight"), null);
});

test("a note added while recording can be fixed or removed; the sheet's own notes are not offered", () => {
  const source = "Mix @flour{100%g}.\n\n> keep it cool\n\nRest.";
  let cooked = insertNoteAfterStep(source, 0, 1, "dough stiky");
  assert.equal(CookSheet.noteAdded(source, "dough stiky"), true);
  assert.equal(CookSheet.noteAdded(source, "keep it cool"), false);
  const fixed = CookSheet.replaceNote(cooked, "dough stiky", 0, "dough sticky");
  assert.match(fixed, /^> dough sticky$/m);
  assert.doesNotMatch(fixed, /stiky/);
  assert.equal(CookSheet.replaceNote(cooked, "dough stiky", 0, "  "), source);
  // The second of two identical notes.
  cooked = insertNoteAfterStep(insertNoteAfterStep(source, 0, 2, "again"), 0, 1, "again");
  const second = CookSheet.replaceNote(cooked, "again", 1, "later");
  assert.deepEqual(second.split("\n").filter((l) => l.startsWith(">")), ["> again", "> keep it cool", "> later"]);
  assert.equal(CookSheet.replaceNote(cooked, "missing", 0, "x"), cooked);
});

test("values without an amount still count, as the server counts them", () => {
  for (const scale of [1, 2]) {
    const text = scaleCooklangText("Add @pepper{} and @salt{2%g}, then @oil and @sugar{5%g}, @red wine{} and @egg{2}.", scale);
    const fields = fieldsOf(text);
    assert.deepEqual(fields.map((f) => `${f.name}#${f.index}`), ["salt#1", "sugar#3", "egg#5"]);
    for (const field of fields) {
      const next = updateStepQuantity(text, field.sectionIndex, field.stepNumber, field.kind, field.index, "777", field.current.units);
      const after = fieldsOf(next);
      after.forEach((other, i) => assert.equal(other.current.quantity, other.id === field.id ? "777" : fields[i].current.quantity, `${field.name} at ${scale}×`));
    }
  }
  // A bare ingredient gets braces when given an amount, and 0 leaves the word.
  assert.equal(updateStepQuantity("Add @oil and @salt{2%g}.", 0, 1, "ingredient", 0, "10", "ml"), "Add @oil{10%ml} and @salt{2%g}.");
  assert.equal(updateStepQuantity("Add @oil and @salt{2%g}.", 0, 1, "ingredient", 1, "3", "g"), "Add @oil and @salt{3%g}.");
  assert.equal(updateStepQuantity("Add @oil, then stir.", 0, 1, "ingredient", 0, "0", ""), "Add oil, then stir.");
});

test("a value in an ingredient's note is that ingredient's, counted on its own; prose in a note is words", () => {
  // `(at ^{90-95%F})` once showed placeholder characters, and counting it
  // among the step's values would have sent an oven edit to the water. It's
  // a noteQuantity now: editable, and numbered apart from the step's values.
  for (const scale of [1, 2]) {
    const text = scaleCooklangText("Mix @flour{450%g} and @water{365-380%g}(at ^{90-95%F}) in a #bowl{}(warm, 30°C), then heat to ^{230%C} for ~{5%min}.", scale);
    const parsed = parseCooklang(text);
    assert.doesNotMatch(JSON.stringify(parsed), /[\uE000-\uF8FF]/);
    assert.equal(parsed.ingredients[1].note, "at 90-95°F");
    const water = parsed.steps[0].find((t) => t.name === "water");
    assert.deepEqual(plain(water.note_parts), ["at ", 0]);
    assert.equal(water.note_values[0].quantity, "90-95");
    assert.equal(parsed.steps[0].find((t) => t.name === "bowl").note_values, undefined, "30°C in words isn't a value");
    const fields = fieldsOf(text);
    assert.deepEqual(fields.map((f) => `${f.kind}#${f.index}`), ["ingredient#0", "ingredient#1", "noteQuantity#0", "inlineQuantity#0", "timer#0"]);
    const note = fields.find((f) => f.kind === "noteQuantity");
    assert.equal(note.name, "water");
    assert.equal(note.isTemp, true);
    assert.deepEqual(note.key, { kind: "noteQuantity", name: "water", n: 0 });
    assert.equal(note.current.quantity, "90-95", "temperatures don't scale");
    for (const field of fields) {
      const next = updateStepQuantity(text, field.sectionIndex, field.stepNumber, field.kind, field.index, "777", field.current.units);
      const after = fieldsOf(next);
      after.forEach((other, i) => assert.equal(other.current.quantity, other.id === field.id ? "777" : fields[i].current.quantity, `${field.kind}#${field.index} at ${scale}×`));
      if (field.kind === "noteQuantity") assert.match(next, /@water\{[^}]*\}\(at \^\{777%F\}\)/);
      else assert.match(next, /\(at \^\{90-95%F\}\)/, "the note is untouched");
    }
  }
});

test("a cook that changed a note's value shows what the sheet said, and the comparison names it", () => {
  const sheet = "Mix @water{380%g}(at ^{90-95%F}) and @flour{500%g}.";
  const cooked = "Mix @water{380%g}(at ^{85%F}) and @flour{500%g}.";
  const parsed = parseCooklang(cooked);
  annotateCookLogDiff(parsed.steps, parseCooklang(sheet).steps);
  const fields = plain(CookSheet.buildFields(parsed.steps));
  const note = fields.find((f) => f.kind === "noteQuantity");
  assert.deepEqual([note.original.quantity, note.current.quantity], ["90-95", "85"]);
  assert.equal(CookSheet.changeKind(note), "changed");
  assert.equal(CookSheet.cookChangeSummary(fields, 1, [CookSheet.keyId(note.key)]), "water temperature: 90-95°F → 85°F");
});

// A sheet and its cooks, parsed the way the test page parses them.
const sheetOf = (text) => { const parsed = parseCooklang(text); return { fields: CookSheet.buildFields(parsed.steps), steps: parsed.steps, text }; };
function cookOf(sheetText, cookedText, scale, intended = []) {
  const parsed = parseCooklang(cookedText);
  annotateCookLogDiff(parsed.steps, parseCooklang(scaleCooklangText(sheetText, scale)).steps);
  return { scale, fields: CookSheet.buildFields(parsed.steps), steps: parsed.steps, intended };
}

test("the cooks of a test side by side, at the sheet's 1×", () => {
  const BASE = "Mix @flour{500%g} and @water{375%g}.\n\nAdd @salt{10%g}.\n\nRest ~{30%min}.";
  const TEST = BASE.replace("375", "390");
  // Cook 1 at 1×: rested longer (meant it), and added a step.
  let one = updateStepQuantity(TEST, 0, 3, "timer", 0, "40", "min");
  one = insertStepAfterStep(one, 0, 1, "!+ Fold twice.");
  // Cook 2 at 2×: water written in kg (the same amount), more salt, skipped the rest.
  const at2 = scaleCooklangText(TEST, 2);
  let two = updateStepQuantity(at2, 0, 1, "ingredient", 1, "0.78", "kg");
  two = updateStepQuantity(two, 0, 2, "ingredient", 0, "30", "g");
  two = applyStepDeviation(two, 0, 3, "skipped");
  const table = plain(CookSheet.comparison({
    base: sheetOf(BASE), sheet: sheetOf(TEST),
    cooks: [cookOf(TEST, one, 1, [{ kind: "timer", name: "", n: 0 }]), cookOf(TEST, two, 2)],
  }));
  const cell = (c) => (c.kind === "unchanged" ? "=" : `${c.kind}:${CookSheet.formatAmount(c.amount)}${c.intended ? "!" : ""}`);
  assert.deepEqual(table.rows.map((r) => [r.label, r.tested, r.base && CookSheet.formatAmount(r.base), CookSheet.formatAmount(r.sheet), ...r.cells.map(cell)]), [
    // 0.78 kg at 2× is the sheet's 780 g: not a difference.
    ["water", true, "375 g", "390 g", "=", "="],
    ["salt", false, "10 g", "10 g", "=", "changed:15 g"],
    ["time, step 3", false, "30 min", "30 min", "changed:40 min!", "="],
  ]);
  // The real amount, for the hover.
  assert.deepEqual([table.rows[1].cells[1].cooked, table.rows[1].cells[1].scaled], [{ quantity: "30", units: "g" }, true]);
  assert.deepEqual(table.stepRows.map((r) => [r.label, r.text, ...r.cells]), [
    ["Skipped step 3", "Rest 30 min.", false, true],
    ["Added after step 1", "Fold twice.", true, false],
  ]);

  assert.equal(CookSheet.changeSummary(sheetOf(BASE), sheetOf(TEST)), "water: 375 → 390 g");
  assert.equal(CookSheet.changeSummary(sheetOf(BASE), sheetOf(TEST.replace("Rest", "Rest covered"))), "water: 375 → 390 g; changes to the steps");
  const cook2 = cookOf(TEST, two, 2);
  assert.equal(CookSheet.cookChangeSummary(cook2.fields, 2, ["ingredient|salt|0", "ingredient|water|0"]), "salt: 10 → 15 g");

  // Checklist ids are in the sheet's coordinates at the cook's scale.
  const sheetAt2 = CookSheet.buildFields(parseCooklang(at2).steps);
  assert.equal(CookSheet.keyForChange(sheetAt2, "step-token:0:2:ingredient:0"), "ingredient|salt|0");
  assert.equal(CookSheet.keyForChange(sheetAt2, "step-token:0:3:timer:0"), "timer||0");
  assert.equal(CookSheet.keyForChange(sheetAt2, "step-add:0:2"), null);
});

test("values show as the paper did, and what's typed is saved in the recipe's units", () => {
  const fields = fieldsOf("Mix @flour{220%g} and @salt{=4%g}.\n\nBake at ^{450%F} for ~{30%min}.");
  const [flour, salt, oven, time] = fields;
  const paper = { temp: "C", units: { flour: "oz" } };
  const shown = (f) => CookSheet.formatAmount(CookSheet.shownAmount(f, f.current, paper), f.isTemp);
  assert.deepEqual(fields.map(shown), ["7¾ oz", "4 g", "232.2°C", "30 min"]);
  assert.equal(CookSheet.shownAmount(oven, oven.current, {}), oven.current, "nothing to convert");
  // Grams can't become cups without a density: shown as written, like the print.
  assert.equal(CookSheet.formatAmount(CookSheet.shownAmount(flour, flour.current, { units: { flour: "cup" } })), "220 g");
  // Typed as on the paper: a bare number takes the shown unit, then it's
  // saved in the recipe's own unit.
  const typedOven = CookSheet.parseTyped("230", oven, CookSheet.shownAmount(oven, oven.current, paper).units);
  assert.deepEqual(plain(typedOven), { quantity: "230", units: "C" });
  assert.deepEqual(plain(CookSheet.savedAmount(oven, typedOven)), { quantity: "446", units: "F" });
  assert.deepEqual(plain(CookSheet.savedAmount(flour, CookSheet.parseTyped("8", flour, "oz"))), { quantity: "227", units: "g" });
  assert.deepEqual(plain(CookSheet.savedAmount(flour, { quantity: "250", units: "g" })), { quantity: "250", units: "g" });
  assert.deepEqual(plain(CookSheet.savedAmount(time, { quantity: "1", units: "hour" })), { quantity: "1", units: "hour" });
  // Retyping what the paper said changes nothing that matters.
  assert.equal(CookSheet.changeKind(oven, CookSheet.savedAmount(oven, CookSheet.parseTyped("232.2", oven, "C"))), "unchanged");
  assert.equal(CookSheet.changeKind(flour, CookSheet.savedAmount(flour, CookSheet.parseTyped("7¾", flour, "oz"))), "unchanged");
  assert.equal(CookSheet.displayNote(paper), "°C, flour in oz");
});

test("cooks of the same day are in the order they were saved", () => {
  const cooks = [
    { id: "b", cooked_at: "2026-11-02T17:00:00.000Z", created_at: "2026-11-02T20:00:00.000Z" },
    { id: "c", cooked_at: "2026-11-03T17:00:00.000Z", created_at: "2026-11-03T09:00:00.000Z" },
    { id: "a", cooked_at: "2026-11-02T17:00:00.000Z", created_at: "2026-11-02T19:00:00.000Z" },
  ];
  assert.deepEqual([...cooks].sort(CookSheet.cookOrder).map((c) => c.id), ["a", "b", "c"]);
});

test("a step added before a timed step doesn't move the timer's key", () => {
  const text = "Mix @flour{100%g}.\n\nRest ~{30%min}.\n\nBake ~{20%min}.";
  const keys = (t) => fieldsOf(t).filter((f) => !f.added).map((f) => `${CookSheet.keyId(f.key)}=${f.current.quantity}`);
  const cooked = updateStepQuantity(insertStepAfterStep(text, 0, 1, "!+ Wait ~{5%min} first."), 0, 3, "timer", 0, "40", "min");
  assert.deepEqual(keys(text), ["ingredient|flour|0=100", "timer||0=30", "timer||1=20"]);
  assert.deepEqual(keys(cooked), ["ingredient|flour|0=100", "timer||0=40", "timer||1=20"]);
});

test("a version adopted from a cook of a test lists the tested change, then the cook's", () => {
  const BASE = "Add @salt{=2%g} and @water{75%g}.";
  const TEST = BASE.replace("=2%g", "=1%g");
  const tested = CookSheet.changeList(sheetOf(BASE), sheetOf(TEST));
  const cooked = updateStepQuantity(scaleCooklangText(TEST, 2), 0, 1, "ingredient", 1, "170", "g");
  const cook = cookOf(TEST, cooked, 2);
  const notes = CookSheet.adoptFromCookNotes(tested, CookSheet.cookChangeList(cook.fields, 2, ["ingredient|water|0"]), "Cook 1");
  assert.equal(notes, "salt: 2 → 1 g (tested); water: 75 → 85 g (Cook 1)");
});

test("each cook's figures, at the sheet's 1×, with a choice inside the sheet's range not a change", () => {
  const SHEET = `---
metric.total_flour: bread_flour.g + whole_wheat_flour.g | g | hidden
metric.hydration: water.g / metric.total_flour * 100 | %
metric.dough: metric.total_flour + water.g | g
---

Mix @bread flour{450%g}, @whole wheat flour{50%g} and @water{365-380%g}.
`;
  const BASE = SHEET.replace("365-380", "350");
  const metrics = (text) => parseCooklang(text).metrics;
  // Cook 1 chose 372 g; cook 2 went past the range; cook 3 cooked at 2× and
  // chose 760 g (380 at 1×), parsed back at 1× as the test page does.
  const cook3 = parseCooklang(scaleCooklangText(scaleCooklangText(SHEET, 2).replace("730-760", "760"), 0.5)).metrics;
  const rows = plain(CookSheet.metricRows({
    base: { metrics: metrics(BASE) },
    sheet: { metrics: metrics(SHEET) },
    cooks: [{ metrics: metrics(SHEET.replace("365-380", "372")) }, { metrics: metrics(SHEET.replace("365-380", "400")) }, { metrics: cook3 }],
  }));
  assert.deepEqual(rows.map((r) => r.name), ["hydration", "dough"], "hidden figures stay out");
  const [hydration, dough] = rows;
  assert.deepEqual([hydration.base, hydration.sheet], ["70%", "73-76%"]);
  assert.deepEqual(hydration.cells.map((c) => `${c.display} ${c.kind}`), ["74.4% same", "80% changed", "76% same"]);
  assert.deepEqual(dough.cells.map((c) => `${c.display} ${c.kind}`), ["872 g same", "900 g changed", "880 g same"]);
  // No figure in a cook, or one that fails, shows as a gap.
  const gaps = plain(CookSheet.metricRows({ base: null, sheet: { metrics: metrics(SHEET) }, cooks: [{ metrics: [] }, { metrics: [{ name: "hydration", error: "bad", hidden: false }] }] }));
  assert.deepEqual(gaps[0].cells.map((c) => c.kind), ["none", "error"]);
  assert.equal(gaps[0].base, null);
});
