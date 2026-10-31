// Barrel for the compare/ feature directory. routes.ts and tests import from
// here; individual modules import from each other via their direct paths.

export { diffIngredients, classifyIngredientRow } from "./ingredient-compare.js";

export { buildInlineDiffLines } from "./compare/inline-diff.ts";
export { diffStepBlocks, readableText } from "./compare/step-diff.ts";
export { diffMetadata, splitFrontmatter } from "./compare/metadata-diff.ts";
export { diffMetrics } from "./compare/metric-diff.ts";
export { classifyCookLogSteps, classifyCookLogVsSource } from "./compare/classify.ts";
export {
  changeIdsForClassification,
  tokenChangeId,
  synthesizePromotedRecipe,
} from "./compare/promote.ts";

export type {
  DiffToken,
  InlineDiffToken,
  DiffLineEntry,
  StepBlock,
  StepChange,
  Classification,
  TokenDiff,
  StepClassification,
} from "./compare/types.ts";
export type { MetadataChange } from "./compare/metadata-diff.ts";
export type { MetricChange } from "./compare/metric-diff.ts";
