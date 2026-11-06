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
  assert.deepEqual(sum, { title: "Brown Butter Cornbread", ingredients: 9, steps: 7, sections: 2, error: "" });
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
