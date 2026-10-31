// Ingredient diff between two ingredient lists. Callers pass the per-name
// totals (`ingredient_summary.flat`), so water used in two steps compares as
// one amount: 265 g → 380 g, not 265 g → 30 g plus a new 350 g.
//
// Amounts compare after unit conversion (shared logic in public/js/units.js):
//   same      → not listed (1 L vs 1000 ml)
//   near      → `approx`: across units within 2% (1 cup vs 240 ml), shown as
//               "≈ same" rather than a change
//   different → `changed`, with a percent change across units where possible
// An ingredient that disappears while a similar one appears (AP flour → Bread
// flour) is reported as a swap in `renamed` instead of a removal + addition.
import { compareAmounts, percentChange, comparableUnits } from "./quantity.ts";

export function diffIngredients(fromIngredients, toIngredients) {
  const fromBuckets = bucketIngredients(filterComparableIngredients(fromIngredients));
  const toBuckets = bucketIngredients(filterComparableIngredients(toIngredients));
  const keys = new Set([...fromBuckets.keys(), ...toBuckets.keys()]);

  const added = [];
  const removed = [];
  const changed = [];
  const approx = [];

  for (const key of keys) {
    const fromList = fromBuckets.get(key) || [];
    const toList = toBuckets.get(key) || [];
    const maxLen = Math.max(fromList.length, toList.length);

    for (let idx = 0; idx < maxLen; idx += 1) {
      const fromIng = fromList[idx];
      const toIng = toList[idx];
      if (fromIng && toIng) {
        const verdict = compareAmounts(amountOf(fromIng), amountOf(toIng));
        if (verdict === "near") approx.push(createRow("approx", fromIng, toIng));
        else if (verdict === "different") changed.push(createRow("changed", fromIng, toIng));
      } else if (toIng) {
        if (hasMeaningfulAmount(toIng)) added.push({ ing: toIng });
      } else if (fromIng) {
        if (hasMeaningfulAmount(fromIng)) removed.push({ ing: fromIng });
      }
    }
  }

  const renamed = pairSwaps(removed, added).map(([fromIng, toIng]) => createRow("renamed", fromIng, toIng));
  const sortRows = (rows) => rows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    added: sortRows(added.filter((entry) => !entry.paired).map((entry) => createRow("added", null, entry.ing))),
    removed: sortRows(removed.filter((entry) => !entry.paired).map((entry) => createRow("removed", entry.ing, null))),
    changed: sortRows(changed),
    renamed: sortRows(renamed),
    approx: sortRows(approx),
  };
}

const STOP_WORDS = new Set(["a", "an", "and", "of", "the", "or", "with", "for", "to", "in", "fresh", "dried"]);

function nameWords(name) {
  return new Set(
    String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !STOP_WORDS.has(word)),
  );
}

// Pair removed/added ingredients that look like one ingredient swapped for
// another: they share a word ("AP flour" / "Bread flour") and are measured the
// same way. Best overlap pairs first; each entry pairs at most once. Marks the
// paired entries and returns [fromIng, toIng] pairs.
function pairSwaps(removed, added) {
  const candidates = [];
  for (const r of removed) {
    const rWords = nameWords(r.ing.name);
    for (const a of added) {
      if (!comparableUnits(r.ing.units, a.ing.units)) continue;
      const aWords = nameWords(a.ing.name);
      let shared = 0;
      for (const word of rWords) if (aWords.has(word)) shared += 1;
      if (!shared) continue;
      const union = new Set([...rWords, ...aWords]).size;
      candidates.push({ r, a, score: shared / union });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const pairs = [];
  for (const { r, a } of candidates) {
    if (r.paired || a.paired) continue;
    r.paired = true;
    a.paired = true;
    pairs.push([r.ing, a.ing]);
  }
  return pairs;
}

// Classification (cook log vs source semantics):
//   within-spec: the "to" scalar lands inside the "from" range, units match;
//                or the amounts are near-equal across units
//   deviation:   numeric changed and either no range existed or the value is
//                outside it; or units changed; or the ingredient was swapped
//   addition:    only present in `to`
//   removal:     only present in `from`
// Powers the cherry-pick promote UI — defaults pre-check `deviation` and
// `addition`, leave `within-spec` unchecked. `from` = source recipe, `to` =
// cook log.
export function classifyIngredientRow(row, fromIng) {
  if (row.status === "added") return "addition";
  if (row.status === "removed") return "removal";
  if (row.status === "approx") return "within-spec";
  if (row.status === "renamed") return "deviation";
  // changed
  const range = fromIng?.range;
  const toQty = parseQuantityNumber(row.to_quantity);
  const sameUnits = normalizeUnit(row.from_units) === normalizeUnit(row.to_units);
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && toQty !== null && sameUnits) {
    if (toQty >= range.min && toQty <= range.max) return "within-spec";
  }
  return "deviation";
}

function amountOf(ingredient) {
  return { quantity: ingredient?.quantity, units: ingredient?.units, range: ingredient?.range ?? null };
}

function bucketIngredients(ingredients) {
  const buckets = new Map();
  ingredients.forEach((ingredient, order) => {
    const key = normalizeName(ingredient.name);
    const list = buckets.get(key) || [];
    list.push({ ...ingredient, order });
    buckets.set(key, list);
  });
  return buckets;
}

function filterComparableIngredients(ingredients) {
  return (ingredients || []).filter((ingredient) => !ingredient?.intermediate);
}

function createRow(status, fromIng, toIng) {
  const name = (toIng?.name || fromIng?.name || "").trim();
  const fromQuantity = fromIng?.quantity ?? "";
  const fromUnits = fromIng?.units || "";
  const toQuantity = toIng?.quantity ?? "";
  const toUnits = toIng?.units || "";

  const row = {
    name,
    status,
    from_quantity: fromQuantity,
    from_units: fromUnits,
    from_range: fromIng?.range ?? null,
    to_quantity: toQuantity,
    to_units: toUnits,
    to_range: toIng?.range ?? null,
    from_display: formatIngredientAmount(
      fromQuantity,
      fromUnits || toUnits,
      status === "added"
    ),
    to_display: formatIngredientAmount(
      toQuantity,
      toUnits || fromUnits,
      status === "removed"
    ),
    percent_change: fromIng && toIng ? percentChange(amountOf(fromIng), amountOf(toIng)) : null,
  };
  if (status === "renamed") row.from_name = (fromIng?.name || "").trim();
  row.classification = classifyIngredientRow(row, fromIng);
  return row;
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeUnit(unit) {
  return String(unit || "").trim().toLowerCase();
}

function formatIngredientAmount(quantity, units, useZeroFallback) {
  const qty = quantity === "" || quantity === null || quantity === undefined
    ? (useZeroFallback ? "0" : "")
    : String(quantity);
  const unit = String(units || "").trim();
  if (!qty) return unit || "0";
  return unit ? `${qty} ${unit}` : qty;
}

function parseQuantityNumber(quantity) {
  if (quantity === "" || quantity === null || quantity === undefined) return null;
  const parsed = parseFloat(String(quantity));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasMeaningfulAmount(ingredient) {
  if (!ingredient) return false;
  if (parseQuantityNumber(ingredient.quantity) !== null) return true;
  return normalizeUnit(ingredient.units) !== "";
}
