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
