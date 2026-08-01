export type ContentIssueCode =
  | "ALLERGEN_DERIVATION_MISMATCH"
  | "ART_REFERENCE_MISSING"
  | "BROKEN_REFERENCE"
  | "CONTENT_HASH_MISMATCH"
  | "DISH_COMPONENT_MISMATCH"
  | "DUPLICATE_IDENTITY"
  | "FAMILY_GRAMMAR_VIOLATION"
  | "INGREDIENT_SPECIES_INVALID"
  | "INVALID_CONTENT_SHAPE"
  | "INVALID_IDENTITY"
  | "NON_CANONICAL_SET"
  | "PACK_MEMBERSHIP_MISMATCH"
  | "RAW_POLICY_INVALID"
  | "RECIPE_INVALID"
  | "REVIEW_REFERENCE_MISSING"
  | "SEASONALITY_UNRESOLVED"
  | "VARIANT_INVALID"
  | "WILDCARD_FORBIDDEN";

export interface ContentIssue {
  readonly code: ContentIssueCode;
  readonly path: string;
  readonly message: string;
}

export type StableContentFailureCode =
  | "CONTENT_VERSION_DRIFT"
  | "UNKNOWN_SPECIES"
  | "UNKNOWN_COMPONENT"
  | "DISH_FAMILY_MISMATCH"
  | "AMBIGUOUS_VARIANT"
  | "ALLERGEN_CONFLICT"
  | "RAW_PROFILE_CONFLICT"
  | "SEASONALITY_UNRESOLVED"
  | "PROVENANCE_UNVERIFIED"
  | "INVALID_QUANTITY"
  | "UNKNOWN_RECIPE";

function stableCodeFor(issue: ContentIssue): StableContentFailureCode {
  switch (issue.code) {
    case "INGREDIENT_SPECIES_INVALID":
      return issue.path.includes("cutStyleRef") ? "UNKNOWN_COMPONENT" : "UNKNOWN_SPECIES";
    case "BROKEN_REFERENCE":
      if (issue.path.includes("species")) return "UNKNOWN_SPECIES";
      if (issue.path.includes("recipe")) return "UNKNOWN_RECIPE";
      if (issue.path.includes("component") || issue.path.includes("ingredient") || issue.path.includes("cutStyle")) {
        return "UNKNOWN_COMPONENT";
      }
      if (issue.path.includes("dish") || issue.path.includes("family")) return "DISH_FAMILY_MISMATCH";
      return "CONTENT_VERSION_DRIFT";
    case "FAMILY_GRAMMAR_VIOLATION":
    case "DISH_COMPONENT_MISMATCH":
      return "DISH_FAMILY_MISMATCH";
    case "VARIANT_INVALID":
    case "WILDCARD_FORBIDDEN":
      return "AMBIGUOUS_VARIANT";
    case "ALLERGEN_DERIVATION_MISMATCH":
      return "ALLERGEN_CONFLICT";
    case "RAW_POLICY_INVALID":
      return "RAW_PROFILE_CONFLICT";
    case "SEASONALITY_UNRESOLVED":
      return "SEASONALITY_UNRESOLVED";
    case "ART_REFERENCE_MISSING":
    case "REVIEW_REFERENCE_MISSING":
      return "PROVENANCE_UNVERIFIED";
    case "RECIPE_INVALID":
      return issue.message.startsWith("Quantity") ? "INVALID_QUANTITY" : "UNKNOWN_RECIPE";
    default:
      return "CONTENT_VERSION_DRIFT";
  }
}

function stableCodeForIssues(issues: readonly ContentIssue[]): StableContentFailureCode {
  const mapped = new Set(issues.map(stableCodeFor));
  const priority: readonly StableContentFailureCode[] = [
    "AMBIGUOUS_VARIANT",
    "ALLERGEN_CONFLICT",
    "RAW_PROFILE_CONFLICT",
    "SEASONALITY_UNRESOLVED",
    "DISH_FAMILY_MISMATCH",
    "UNKNOWN_SPECIES",
    "INVALID_QUANTITY",
    "PROVENANCE_UNVERIFIED",
    "UNKNOWN_RECIPE",
    "UNKNOWN_COMPONENT",
    "CONTENT_VERSION_DRIFT",
  ];
  return priority.find((code) => mapped.has(code)) ?? "CONTENT_VERSION_DRIFT";
}

export class ContentValidationError extends Error {
  readonly stableCode: StableContentFailureCode;

  constructor(readonly issues: readonly ContentIssue[]) {
    super(`Content validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`);
    this.name = "ContentValidationError";
    this.stableCode = stableCodeForIssues(issues);
  }
}

export function sortedIssues(issues: readonly ContentIssue[]): readonly ContentIssue[] {
  return [...issues].sort((left, right) => {
    const path = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    if (path !== 0) return path;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
}
