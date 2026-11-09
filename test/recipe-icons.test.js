// The client's icon rules match the server's (store/folders.ts normalizeIcon),
// and every bundled icon and picker emoji is one the server takes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeIcon } from "../src/store/folders.ts";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

function setup() {
  const context = vm.createContext({ Intl, escHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) });
  vm.runInContext(read("../public/vendor/lucide-food.js"), context);
  vm.runInContext(read("../public/js/recipe-icons.js"), context);
  return { RecipeIcons: vm.runInContext("RecipeIcons", context), LUCIDE_FOOD: vm.runInContext("LUCIDE_FOOD", context) };
}

test("every icon the picker offers is one the server keeps as given", () => {
  const { RecipeIcons, LUCIDE_FOOD } = setup();
  assert.ok(Object.keys(LUCIDE_FOOD).length >= 60);
  for (const name of Object.keys(LUCIDE_FOOD)) assert.equal(normalizeIcon(`lucide:${name}`), `lucide:${name}`);
  assert.equal(new Set(RecipeIcons.EMOJI).size, RecipeIcons.EMOJI.length, "no emoji twice");
  for (const emoji of RecipeIcons.EMOJI) {
    assert.ok(RecipeIcons.isEmoji(emoji), emoji);
    assert.equal(normalizeIcon(emoji), emoji);
  }
});

test("an icon renders as its svg or emoji; anything else is the fallback", () => {
  const { RecipeIcons } = setup();
  assert.match(RecipeIcons.html("lucide:wheat"), /^<svg class="ri-svg" viewBox="0 0 24 24"[^>]*>.*<path/);
  assert.equal(RecipeIcons.html("🦃"), '<span class="ri-emoji" aria-hidden="true">🦃</span>');
  for (const other of ["", "lucide:not-bundled", "turkey", "🦃🦃", "<img src=x>"]) {
    assert.equal(RecipeIcons.html(other, "FALLBACK"), "FALLBACK", other);
    assert.equal(RecipeIcons.has(other), false, other);
    assert.equal(RecipeIcons.isEmoji(other), false, other);
  }
  assert.ok(RecipeIcons.isEmoji("👨‍🍳") && RecipeIcons.isEmoji("🇯🇵"));
  assert.equal(RecipeIcons.of({ icon: "🍞", default_icon: "🥖" }), "🍞", "the chosen icon wins");
  assert.equal(RecipeIcons.of({ icon: "", default_icon: "🥖" }), "🥖", "else the sheet's");
  assert.equal(RecipeIcons.of({ icon: "", default_icon: null }), "");
});
