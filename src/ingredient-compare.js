export function diffIngredients(fromIngredients, toIngredients) {
  const fromBuckets = bucketIngredients(filterComparableIngredients(fromIngredients));
  const toBuckets = bucketIngredients(filterComparableIngredients(toIngredients));
  const keys = new Set([...fromBuckets.keys(), ...toBuckets.keys()]);

  const added = [];
  const removed = [];
  const changed = [];

  for (const key of keys) {
    const fromList = fromBuckets.get(key) || [];
    const toList = toBuckets.get(key) || [];
    const maxLen = Math.max(fromList.length, toList.length);

    for (let idx = 0; idx < maxLen; idx += 1) {
      const fromIng = fromList[idx];
      const toIng = toList[idx];
      if (fromIng && toIng) {
        if (
          String(fromIng.quantity) !== String(toIng.quantity) ||
          normalizeUnit(fromIng.units) !== normalizeUnit(toIng.units)
        ) {
          changed.push(createRow("changed", fromIng, toIng));
        }
      } else if (toIng) {
        if (hasMeaningfulAmount(toIng)) {
          added.push(createRow("added", null, toIng));
        }
      } else if (fromIng) {
        if (hasMeaningfulAmount(fromIng)) {
          removed.push(createRow("removed", fromIng, null));
        }
      }
    }
  }

  const sortRows = (rows) => rows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    added: sortRows(added),
    removed: sortRows(removed),
    changed: sortRows(changed),
  };
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

  return {
    name,
    status,
    from_quantity: fromQuantity,
    from_units: fromUnits,
    to_quantity: toQuantity,
    to_units: toUnits,
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
    percent_change: computePercentChange(fromQuantity, fromUnits, toQuantity, toUnits),
  };
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

function computePercentChange(fromQuantity, fromUnits, toQuantity, toUnits) {
  if (normalizeUnit(fromUnits) !== normalizeUnit(toUnits)) return null;
  const fromValue = parseQuantityNumber(fromQuantity);
  const toValue = parseQuantityNumber(toQuantity);
  if (fromValue === null || toValue === null || fromValue === 0) return null;
  return ((toValue - fromValue) / fromValue) * 100;
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
