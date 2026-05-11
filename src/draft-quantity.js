export function rewriteDraftQuantity(text, token, nextValue) {
  const formatted = typeof nextValue === "number"
    ? formatEditableQuantity(nextValue)
    : String(nextValue).trim();
  if (!formatted) return text;
  return text.slice(0, token.rangeStart) + formatted + text.slice(token.rangeEnd);
}

export function formatEditableQuantity(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === Math.floor(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}
