// The import prompt teaches the syntax the app actually reads. Every example
// in it goes through the real parser, and so does the sample recipe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseCooklang } from "../src/cooklang.ts";
import { parseVersionMetadata } from "../src/store/frontmatter.ts";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(read("../public/js/import-prompt.js"), context);
const ImportPrompt = vm.runInContext("ImportPrompt", context);
const plain = (value) => JSON.parse(JSON.stringify(value));

// What a one-line example parses to.
function kindOf(line) {
  const parsed = parseCooklang(`${line}\n`);
  assert.equal(parsed.error, undefined, `${line}: ${parsed.error}`);
  const tokens = parsed.steps.flat();
  if (tokens.length === 1 && tokens[0].type === "comment") return { kind: "note" };
  const text = tokens.every((t) => t.type === "text") ? tokens.map((t) => t.value).join("") : null;
  if (text !== null && /^\s*=\s+/.test(text)) return { kind: "section" };
  const token = tokens.find((t) => t.type !== "text");
  if (!token) return { kind: "text" };
  if (token.type === "inlineQuantity" && /°/.test(token.value)) return { kind: "temperature", token };
  const ingredient = token.type === "ingredient" ? parsed.ingredients[0] : null;
  return { kind: token.type, token, ingredient };
}

test("every syntax example parses as what the prompt says it is", () => {
  for (const item of ImportPrompt.SYNTAX) {
    const got = kindOf(`Do it with ${item.example} now.`.replace(/^Do it with (= |> )/, "$1"));
    assert.equal(got.kind, item.kind, `${item.code} (${item.example})`);
  }
});

test("the syntax rules hold: optional, preparation, fixed, ranges", () => {
  const optional = parseCooklang("Add @?sesame seeds{1%tbsp}.\n");
  assert.equal(optional.ingredients[0].optional, true);
  const prep = parseCooklang("Add @butter{15%g}(melted).\n");
  assert.equal(prep.ingredients[0].note, "melted");
  const fixed = parseCooklang("Add @salt{=1%tsp}.\n");
  assert.equal(fixed.ingredients[0].fixed ?? fixed.ingredients[0].scalable === false, true);
  const range = parseCooklang("Bake ~{20-25%min} at ^{21-23%C}.\n");
  const tokens = range.steps.flat();
  assert.ok(tokens.find((t) => t.type === "timer").range);
  assert.match(tokens.find((t) => t.type === "inlineQuantity").value, /21.*23.*°C/);
});

test("the sample recipe parses, with its metadata where the app reads it", () => {
  const parsed = parseCooklang(ImportPrompt.EXAMPLE);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.metadata.title, "Brown Butter Cornbread");
  const meta = parseVersionMetadata(ImportPrompt.EXAMPLE);
  assert.equal(meta.servings, "8");
  assert.match(meta.notes, /Keeps 2 days[\s\S]*\nReheat/);
  const sum = plain(ImportPrompt.summarize(parsed));
  assert.deepEqual(sum, { title: "Brown Butter Cornbread", ingredients: 9, steps: 6, sections: 2, error: "" });
  // It uses what it teaches, so the assistant sees each in use.
  assert.match(ImportPrompt.EXAMPLE, /^= \w/m);
  assert.match(ImportPrompt.EXAMPLE, /#[\w -]+\{\}/);
  assert.match(ImportPrompt.EXAMPLE, /\^\{\d+%[FC]\}/);
  assert.match(ImportPrompt.EXAMPLE, /~\{\d+-\d+%min\}/);
  assert.match(ImportPrompt.EXAMPLE, /\}\(\w+\)/);
  assert.match(ImportPrompt.EXAMPLE, /@\w[\w ]*\{\}/);
  assert.match(ImportPrompt.EXAMPLE, /^> /m);
  assert.doesNotMatch(ImportPrompt.EXAMPLE, /°[FC]/, "temperatures are ^{}, not plain text");
});

test("the sample recipe is as brief as the prompt asks", () => {
  // Steps are the blocks after the metadata that aren't sections or notes.
  const body = ImportPrompt.EXAMPLE.split(/\n---\n/)[1];
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const steps = blocks.filter((b) => !/^(=|>)\s/.test(b));
  const words = (b) => b.replace(/[@#~^]\{[^}]*\}|\{[^}]*\}/g, "").split(/\s+/).filter(Boolean).length;
  for (const step of steps) assert.ok(words(step) <= ImportPrompt.EXAMPLE_LIMITS.wordsPerStep, `too long: ${step}`);
  const notes = blocks.filter((b) => /^>\s/.test(b));
  assert.ok(notes.length >= 1 && notes.length <= ImportPrompt.EXAMPLE_LIMITS.notes, "one important note, no more");
  for (const note of notes) assert.ok(words(note) <= 12, `note too long: ${note}`);
});

// Words the principles say order already gives.
const SEQUENCING = /\b(then|next|now|after that|once)\b/i;

test("the prompt teaches the writing principles, with real edits", () => {
  const prompt = ImportPrompt.build({});
  ImportPrompt.PRINCIPLES.forEach((rule, i) => assert.ok(prompt.includes(`${i + 1}. ${rule}`), rule));
  assert.ok(prompt.includes(`## How to write it\n\n${ImportPrompt.PURPOSE}\n\n1. `));
  assert.match(prompt, /Instructions, not narration/);
  assert.match(prompt, /Sections are stages of work/);
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  for (const { before, after } of ImportPrompt.BEFORE_AFTER) {
    assert.ok(prompt.includes(`Not:\n${before}\n\nBut:\n${after}`));
    for (const text of [before, after]) assert.equal(parseCooklang(`${text}\n`).error, undefined, text);
    // Every amount, time and temperature in the original survives the edit.
    const values = (t) => (t.match(/[@~^]\{[^}]+\}/g) || []).filter((v) => !/\{\}$/.test(v)).sort();
    for (const v of values(before)) assert.ok(after.includes(v), `${v} lost in: ${after}`);
    assert.ok(words(after) < words(before) / 2, `not much shorter: ${after}`);
    assert.doesNotMatch(after, SEQUENCING, after);
  }
  // The principles come before the examples, so the examples read as them.
  assert.ok(prompt.indexOf('## How to write it') < prompt.indexOf('## House style'));
});

test("the sample recipes follow the principles: no \"then\" or \"once\"", () => {
  for (const recipe of [ImportPrompt.EXAMPLE, ImportPrompt.METRIC_EXAMPLE]) {
    const body = recipe.split(/\n---\n/)[1];
    assert.doesNotMatch(body, SEQUENCING);
  }
});

test("the metrics example computes, with the figures a baker would expect", () => {
  const parsed = parseCooklang(ImportPrompt.METRIC_EXAMPLE);
  assert.equal(parsed.error, undefined);
  const byName = Object.fromEntries(parsed.metrics.map((m) => [m.name, m]));
  for (const m of parsed.metrics) assert.equal(m.error, null, `${m.name}: ${m.error}`);
  // 500 g flour + half the 100 g levain; 350 + 25 g water + the other half.
  assert.equal(byName.total_flour.value, 550);
  assert.equal(byName.total_water.value, 425);
  assert.deepEqual([byName.hydration.display, byName.salt.display, byName.levain.display], ["77.3%", "1.8%", "18.2%"]);
  assert.deepEqual(parsed.metrics.filter((m) => m.hidden).map((m) => m.name), ["total_flour", "total_water"]);
  // It is as brief as the other example.
  const body = ImportPrompt.METRIC_EXAMPLE.split(/\n---\n/)[1];
  const steps = body.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b && !/^(=|>)\s/.test(b));
  const words = (b) => b.replace(/[@#~^&]*\{[^}]*\}/g, "").split(/\s+/).filter(Boolean).length;
  for (const step of steps) assert.ok(words(step) <= ImportPrompt.EXAMPLE_LIMITS.wordsPerStep, `too long: ${step}`);
});

test("@& is why a repeated ingredient adds up in metrics", () => {
  const metric = (steps) => parseCooklang(`---\nmetric.w: water.g | g\n---\n\n${steps}\n`).metrics[0].value;
  assert.equal(metric("Mix @water{350%g}.\n\nAdd @&water{25%g}."), 375);
  // Without it the formula sees only one of them, which the prompt warns about.
  assert.notEqual(metric("Mix @water{350%g}.\n\nAdd @water{25%g}."), 375);
});

test("the prompt teaches metrics for more than bread, and how to write them", () => {
  const prompt = ImportPrompt.build({});
  for (const rule of [...ImportPrompt.METRICS.when, ...ImportPrompt.METRICS.how]) assert.ok(prompt.includes(rule));
  assert.match(prompt, /Ferments, cures and brines/);
  assert.match(prompt, /most everyday recipes need none/);
  assert.ok(prompt.includes(ImportPrompt.METRIC_EXAMPLE));
  assert.match(prompt, /## Example with metrics\n\n```cooklang\n---\ntitle: Country Loaf/);
});

test("every metadata key the prompt teaches is one the app reads", () => {
  const known = ["title", "servings", "source", "notes"];
  for (const item of ImportPrompt.METADATA) {
    assert.ok(known.includes(item.key) || item.key.startsWith("metric."), item.key);
    const parsed = parseCooklang(`---\n${item.code}\n---\n\nMix @water{70%g} and @flour{100%g}.\n`);
    if (item.key.startsWith("metric.")) {
      const metric = parsed.metrics.find((m) => `metric.${m.name}` === item.key);
      assert.equal(metric?.display, "70%", item.code);
    } else {
      assert.ok(parsed.metadata[item.key] !== undefined, item.code);
    }
  }
});

test("AjiLab's own syntax is either taught or set aside with a reason", () => {
  // The extensions in CLAUDE.md. A new one goes in SYNTAX or NOT_FOR_IMPORT.
  const extensions = ["^{", "%{}", "@?", "@-", "@&", "@&(=N)", "{=", "!+ / !-", "@./", "metric."];
  const taught = [...ImportPrompt.SYNTAX, ...ImportPrompt.METADATA].map((item) => item.code).join(" ");
  for (const ext of extensions) {
    const covered = taught.includes(ext) || ext in ImportPrompt.NOT_FOR_IMPORT;
    assert.ok(covered, `${ext} is neither in the prompt nor set aside`);
  }
});

test("the editor help shows the same codes the prompt teaches", () => {
  const editor = read("../public/js/views-recipe-editor.js");
  assert.match(editor, /codes\(ImportPrompt\.SYNTAX\)/);
  assert.match(editor, /codes\(ImportPrompt\.METADATA\)/);
  assert.ok(ImportPrompt.SYNTAX.filter((item) => item.help).length >= 6);
});

test("the prompt carries the link, the format, the house style and the example", () => {
  const prompt = ImportPrompt.build({ url: "  https://example.org/pie  " });
  assert.match(prompt, /^Turn the recipe at this link into Cooklang for AjiLab, my recipe app:\nhttps:\/\/example\.org\/pie\n/);
  for (const item of [...ImportPrompt.SYNTAX, ...ImportPrompt.METADATA]) assert.ok(prompt.includes(item.code), item.code);
  for (const rule of ImportPrompt.HOUSE_STYLE) assert.ok(prompt.includes(rule));
  assert.ok(prompt.includes(ImportPrompt.EXAMPLE));
  assert.match(prompt, /```cooklang\n---\ntitle: Brown Butter Cornbread[\s\S]*\n```\n$/);
  const noLink = ImportPrompt.build({});
  assert.match(prompt, /If you can't open the link, say so and stop/);
  assert.match(noLink, /^Turn the recipe I give you/);
  assert.doesNotMatch(noLink, /open the link|\n\n\n/);
  assert.doesNotMatch(noLink, /undefined|null/);
});

test("the reply is read from its code block, chatter and all", () => {
  const recipe = "---\ntitle: Pie\n---\n\nBake ~{1%hour}.";
  assert.equal(ImportPrompt.fromReply(`Here you go!\n\n\`\`\`cooklang\n${recipe}\n\`\`\`\n\nEnjoy.`), `${recipe}\n`);
  assert.equal(ImportPrompt.fromReply(`\`\`\`\r\n${recipe.replace(/\n/g, "\r\n")}\r\n\`\`\``), `${recipe}\n`);
  assert.equal(ImportPrompt.fromReply(`  ${recipe}  `), `${recipe}\n`);
  assert.equal(ImportPrompt.fromReply("   "), "");
});

test("summarize counts what a reply holds, and passes a parse error on", () => {
  const parsed = parseCooklang("---\ntitle: Toast\n---\n\nToast @bread{2%slices} in a #toaster{}.\n\n> Watch it.\n\nButter it with @butter{}.\n");
  assert.deepEqual(plain(ImportPrompt.summarize(parsed)), { title: "Toast", ingredients: 2, steps: 2, sections: 0, error: "" });
  assert.equal(ImportPrompt.summarize({ error: "bad", steps: [] }).error, "bad");
  assert.equal(ImportPrompt.summarize(null).steps, 0);
});

test("a formula reads an ingredient in the unit it's written in, not across weight and volume", () => {
  const metric = (formula) => parseCooklang(`---\nmetric.x: ${formula}\n---\n\nAdd @milk{250%ml} and @flour{0.5%kg}.\n`).metrics[0];
  assert.equal(metric("milk.ml").value, 250);
  assert.equal(metric("flour.g").value, 500);
  assert.ok(metric("milk.g").error, "ml to g fails, as the prompt says");
});
