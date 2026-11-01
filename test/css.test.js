// Stylesheet rules (in place of stylelint, with no extra dependency):
//   1. Literal colours live only in tokens.css; everything else uses var(--…).
//   2. No selector is defined twice in the same file and context.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(import.meta.dirname, "..", "public", "css");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".css"));

// Flat list of { context, selector, body } for every rule, with @media /
// @supports contexts recorded and @keyframes skipped.
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const walk = (src, context) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@keyframes")) { /* skip */ }
      else if (head.startsWith("@")) walk(body, `${context}${head} `);
      else out.push({ context: context.trim(), selector: head.replace(/\s+/g, " "), body });
      i = j;
    }
  };
  walk(text, "");
  return out;
}

const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|(?<![-\w])(?:white|black)(?![-\w])/i;

test("css: literal colours appear only in tokens.css", () => {
  const offenders = [];
  for (const file of files.filter((f) => f !== "tokens.css")) {
    for (const rule of rules(fs.readFileSync(path.join(DIR, file), "utf8"))) {
      for (const decl of rule.body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const value = decl.slice(colon + 1);
        if (LITERAL.test(value)) offenders.push(`${file}: ${rule.selector} { ${decl.trim()} }`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("css: no selector is defined twice in the same file and context", () => {
  const dupes = [];
  for (const file of files) {
    const seen = new Set();
    for (const rule of rules(fs.readFileSync(path.join(DIR, file), "utf8"))) {
      const key = `${rule.context}|${rule.selector}`;
      if (seen.has(key)) dupes.push(`${file}: ${rule.context ? rule.context + " " : ""}${rule.selector}`);
      seen.add(key);
    }
  }
  assert.deepEqual(dupes, []);
});

test("css: there is a single dark-mode block, in tokens.css", () => {
  const blocks = files.flatMap((file) =>
    (fs.readFileSync(path.join(DIR, file), "utf8").match(/@media\s*\(prefers-color-scheme:\s*dark\)/g) || []).map(() => file));
  assert.deepEqual(blocks, ["tokens.css"]);
});
