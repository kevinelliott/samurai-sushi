import { contentHashFor, contentManifestHashFor } from "./hash";
import { ContentValidationError, sortedIssues, type ContentIssue, type ContentIssueCode } from "./errors";
import {
  type Allergen,
  type CompiledContentPack,
  type ContentKind,
  type DishDefinition,
  type DishFamily,
  type DishFacts,
  type IngredientDefinition,
  type PreparedComponent,
  type RecipeVersion,
  type VersionedEntity,
  type VersionedRef,
} from "./model";
import { decodeContentBundle } from "./schema";

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DECIMAL_PATTERN = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WILDCARD_PATTERN = /(?:^|-)any(?:-|$)|(?:^|-)all(?:-|$)|[*?]/;
const RUNTIME_TZDB_VERSION = process.versions.tz;

type IndexedKind = Exclude<ContentKind, "pack">;
type EntityIndex = Map<string, VersionedEntity>;

export interface CompileContentOptions {
  readonly mode?: "activation" | "historical";
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

export function versionedKey(kind: ContentKind, ref: VersionedRef): string {
  return `${kind}:${refKey(ref)}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(issues: ContentIssue[], code: ContentIssueCode, path: string, message: string): void {
  issues.push({ code, path, message });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

function assertCanonicalSet(values: readonly string[], path: string, issues: ContentIssue[]): void {
  const canonical = sortedUnique(values);
  if (!sameStrings(values, canonical)) {
    addIssue(issues, "NON_CANONICAL_SET", path, "Set-like arrays must be sorted by code point and contain no duplicates.");
  }
}

function assertIdentity(entity: VersionedEntity, path: string, issues: ContentIssue[]): void {
  if (!ID_PATTERN.test(entity.id) || !Number.isSafeInteger(entity.version) || entity.version <= 0) {
    addIssue(issues, "INVALID_IDENTITY", path, "Identity must use a canonical kebab-case ID and a positive safe-integer version.");
  }
  if (!HASH_PATTERN.test(entity.contentHash) || entity.contentHash !== contentHashFor(entity)) {
    addIssue(issues, "CONTENT_HASH_MISMATCH", `${path}.contentHash`, "contentHash must match canonical SHA-256 row content in domain v1.");
  }
}

function createIndex(rows: readonly VersionedEntity[], kind: IndexedKind, path: string, issues: ContentIssue[]): EntityIndex {
  const index = new Map<string, VersionedEntity>();
  rows.forEach((row, position) => {
    const rowPath = `${path}[${position}]`;
    assertIdentity(row, rowPath, issues);
    const key = refKey(row);
    if (index.has(key)) addIssue(issues, "DUPLICATE_IDENTITY", rowPath, `Duplicate ${kind} identity ${key}.`);
    else index.set(key, row);
  });
  return index;
}

function resolve<T extends VersionedEntity>(
  index: EntityIndex,
  ref: VersionedRef,
  path: string,
  kind: IndexedKind,
  issues: ContentIssue[],
): T | undefined {
  const entity = index.get(refKey(ref));
  if (!entity) addIssue(issues, "BROKEN_REFERENCE", path, `Unknown ${kind} reference ${refKey(ref)}.`);
  return entity as T | undefined;
}

function validateReview(reviewId: string, references: ReadonlySet<string>, path: string, issues: ContentIssue[]): void {
  if (!references.has(reviewId)) {
    addIssue(issues, "REVIEW_REFERENCE_MISSING", path, `Review reference ${JSON.stringify(reviewId)} is not present in the bundle.`);
  }
}

function deriveFacts(components: readonly PreparedComponent[]): DishFacts {
  return deepFreeze({
    containsAllergens: sortedUnique(components.flatMap((component) => component.containsAllergens)) as readonly Allergen[],
    mayContainAllergens: sortedUnique(components.flatMap((component) => component.mayContainAllergens)) as readonly Allergen[],
    crossContactTags: sortedUnique(components.flatMap((component) => component.crossContactTags)),
    rawProfile: components.some((component) => component.rawNotice === "required") ? "notice-required" : "none",
  });
}

function componentSignature(role: string, ref: VersionedRef): string {
  return `${role}:${refKey(ref)}`;
}

function strictDateOrdinal(value: string): number | undefined {
  const match = DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return Math.floor(date.getTime() / 86_400_000);
}

function containsOrderedSteps(
  sequence: readonly { readonly station: string; readonly action: string }[],
  required: readonly { readonly station: string; readonly action: string }[],
): boolean {
  let cursor = 0;
  for (const step of sequence) {
    const expected = required[cursor];
    if (expected && step.station === expected.station && step.action === expected.action) cursor += 1;
  }
  return cursor === required.length;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = {
    get size() {
      return source.size;
    },
    entries: () => source.entries(),
    forEach: (callback, thisArg) => source.forEach((value, key) => callback.call(thisArg, value, key, view)),
    get: (key) => source.get(key),
    has: (key) => source.has(key),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  };
  return Object.freeze(view);
}

export function compileContentPack(input: unknown, options: CompileContentOptions = {}): CompiledContentPack {
  const cloned = structuredClone(input) as unknown;
  const bundle = decodeContentBundle(cloned);
  const issues: ContentIssue[] = [];
  const reviews = new Set(bundle.reviewReferences);
  const art = new Map(bundle.artAssets.map((asset) => [asset.key, asset]));

  assertCanonicalSet(bundle.reviewReferences, "$.reviewReferences", issues);
  bundle.artAssets.forEach((asset, index) => {
    if (!ID_PATTERN.test(asset.key) || !HASH_PATTERN.test(asset.digest)) {
      addIssue(issues, "INVALID_IDENTITY", `$.artAssets[${index}]`, "Art keys must be canonical IDs and digests must be SHA-256 values.");
    }
  });
  if (art.size !== bundle.artAssets.length) addIssue(issues, "DUPLICATE_IDENTITY", "$.artAssets", "Art keys must be unique.");

  const indexes: Record<IndexedKind, EntityIndex> = {
    species: createIndex(bundle.species, "species", "$.species", issues),
    ingredient: createIndex(bundle.ingredients, "ingredient", "$.ingredients", issues),
    "cut-style": createIndex(bundle.cutStyles, "cut-style", "$.cutStyles", issues),
    component: createIndex(bundle.components, "component", "$.components", issues),
    family: createIndex(bundle.families, "family", "$.families", issues),
    dish: createIndex(bundle.dishes, "dish", "$.dishes", issues),
    recipe: createIndex(bundle.recipes, "recipe", "$.recipes", issues),
    variant: createIndex(bundle.variants, "variant", "$.variants", issues),
    "seasonality-rule": createIndex(bundle.seasonalityRules, "seasonality-rule", "$.seasonalityRules", issues),
  };
  assertIdentity(bundle.pack, "$.pack", issues);

  const entityGroups: readonly [IndexedKind, readonly VersionedEntity[], string][] = [
    ["species", bundle.species, "$.species"],
    ["ingredient", bundle.ingredients, "$.ingredients"],
    ["cut-style", bundle.cutStyles, "$.cutStyles"],
    ["component", bundle.components, "$.components"],
    ["family", bundle.families, "$.families"],
    ["dish", bundle.dishes, "$.dishes"],
    ["recipe", bundle.recipes, "$.recipes"],
    ["variant", bundle.variants, "$.variants"],
    ["seasonality-rule", bundle.seasonalityRules, "$.seasonalityRules"],
  ];
  for (const [, rows, path] of entityGroups) {
    rows.forEach((row, index) => validateReview(row.reviewId, reviews, `${path}[${index}].reviewId`, issues));
  }
  validateReview(bundle.pack.reviewId, reviews, "$.pack.reviewId", issues);
  bundle.pack.reviewerSignoffs.forEach((reviewId, index) => validateReview(reviewId, reviews, `$.pack.reviewerSignoffs[${index}]`, issues));

  const artUsers: readonly [readonly { readonly artKey: string }[], string][] = [
    [bundle.ingredients, "$.ingredients"],
    [bundle.components, "$.components"],
    [bundle.dishes, "$.dishes"],
  ];
  for (const [rows, path] of artUsers) {
    rows.forEach((row, index) => {
      if (!art.has(row.artKey)) addIssue(issues, "ART_REFERENCE_MISSING", `${path}[${index}].artKey`, `Unknown art key ${JSON.stringify(row.artKey)}.`);
    });
  }

  bundle.ingredients.forEach((ingredient, index) => {
    const path = `$.ingredients[${index}]`;
    for (const [values, name] of [
      [ingredient.roles, "roles"],
      [ingredient.baseContainsAllergens, "baseContainsAllergens"],
      [ingredient.baseMayContainAllergens, "baseMayContainAllergens"],
      [ingredient.baseCrossContactTags, "baseCrossContactTags"],
    ] as const) assertCanonicalSet(values, `${path}.${name}`, issues);
    if (ingredient.kind === "aquatic-product") {
      if (!ingredient.speciesRef || !ingredient.productKind) {
        addIssue(issues, "INGREDIENT_SPECIES_INVALID", path, "Aquatic products require exact speciesRef and productKind values.");
      } else {
        resolve(indexes.species, ingredient.speciesRef, `${path}.speciesRef`, "species", issues);
      }
      if (ingredient.productKind === "roe" && !ingredient.roles.includes("roe")) {
        addIssue(issues, "INGREDIENT_SPECIES_INVALID", `${path}.roles`, "Roe products must declare the roe semantic role.");
      }
      if (ingredient.productKind === "roe" && /\buni\b/i.test([ingredient.id, ...Object.values(ingredient.names)].join(" "))) {
        addIssue(issues, "INGREDIENT_SPECIES_INVALID", `${path}.productKind`, "Uni is not roe and requires its own culinary product identity.");
      }
      if (ingredient.roles.includes("roe") && ingredient.productKind !== "roe") {
        addIssue(issues, "INGREDIENT_SPECIES_INVALID", `${path}.productKind`, "The roe role requires productKind roe.");
      }
    } else if (ingredient.speciesRef || ingredient.productKind) {
      addIssue(issues, "INGREDIENT_SPECIES_INVALID", path, "Non-aquatic ingredients cannot carry aquatic species or product identity.");
    }
  });

  bundle.components.forEach((component, index) => {
    const path = `$.components[${index}]`;
    const ingredient = resolve<IngredientDefinition>(indexes.ingredient, component.ingredientRef, `${path}.ingredientRef`, "ingredient", issues);
    const cut = component.cutStyleRef
      ? resolve(indexes["cut-style"], component.cutStyleRef, `${path}.cutStyleRef`, "cut-style", issues)
      : undefined;
    for (const [values, name] of [
      [component.containsAllergens, "containsAllergens"],
      [component.mayContainAllergens, "mayContainAllergens"],
      [component.crossContactTags, "crossContactTags"],
    ] as const) assertCanonicalSet(values, `${path}.${name}`, issues);
    if (ingredient) {
      const animalDerived = ingredient.kind === "aquatic-product" || ingredient.kind === "egg";
      if ((animalDerived && component.treatment === "plant") || (!animalDerived && component.treatment !== "plant" && ingredient.kind !== "condiment" && ingredient.kind !== "staple")) {
        addIssue(issues, "RAW_POLICY_INVALID", `${path}.treatment`, "Treatment must agree with the exact ingredient kind.");
      }
      const noticeRequired = ["raw", "cured", "smoked", "surface-seared"].includes(component.treatment);
      if (noticeRequired !== (component.rawNotice === "required")) {
        addIssue(issues, "RAW_POLICY_INVALID", `${path}.rawNotice`, "Raw, cured, smoked, and surface-seared components require a notice; other treatments declare none.");
      }
      if (!ingredient.baseContainsAllergens.every((allergen) => component.containsAllergens.includes(allergen)) ||
          !ingredient.baseMayContainAllergens.every((allergen) => component.mayContainAllergens.includes(allergen)) ||
          !ingredient.baseCrossContactTags.every((tag) => component.crossContactTags.includes(tag))) {
        addIssue(issues, "ALLERGEN_DERIVATION_MISMATCH", path, "Prepared-component facts cannot remove or downgrade ingredient allergen facts.");
      }
      if (cut && ingredient.productKind && !(cut as { compatibleProductKinds?: readonly string[] }).compatibleProductKinds?.includes(ingredient.productKind)) {
        addIssue(issues, "INGREDIENT_SPECIES_INVALID", `${path}.cutStyleRef`, "Cut style is incompatible with the ingredient product kind.");
      }
    }
  });

  const dishFacts = new Map<string, DishFacts>();
  bundle.dishes.forEach((dish, index) => {
    const path = `$.dishes[${index}]`;
    const family = resolve<DishFamily>(indexes.family, dish.familyRef, `${path}.familyRef`, "family", issues);
    const resolved = dish.componentSlots.map((slot, slotIndex) =>
      resolve<PreparedComponent>(indexes.component, slot.componentRef, `${path}.componentSlots[${slotIndex}].componentRef`, "component", issues),
    );
    const components = resolved.filter((component): component is PreparedComponent => Boolean(component));
    const facts = deriveFacts(components);
    dishFacts.set(refKey(dish), facts);
    for (const [values, name] of [
      [dish.containsAllergens, "containsAllergens"],
      [dish.mayContainAllergens, "mayContainAllergens"],
      [dish.crossContactTags, "crossContactTags"],
      [dish.dietaryTags, "dietaryTags"],
    ] as const) assertCanonicalSet(values, `${path}.${name}`, issues);
    if (dish.dietaryTags.length > 0) {
      addIssue(issues, "RECIPE_INVALID", `${path}.dietaryTags`, "Schema v1 rejects dietary claims until exact derivation is modeled.");
    }
    if (!sameStrings(dish.containsAllergens, facts.containsAllergens) ||
        !sameStrings(dish.mayContainAllergens, facts.mayContainAllergens) ||
        !sameStrings(dish.crossContactTags, facts.crossContactTags)) {
      addIssue(issues, "ALLERGEN_DERIVATION_MISMATCH", path, "Dish allergen facts must exactly equal independent unions of its component versions.");
    }
    if (dish.rawProfile !== facts.rawProfile) {
      addIssue(issues, "RAW_POLICY_INVALID", `${path}.rawProfile`, "Dish raw profile must derive from its exact component versions.");
    }
    if (!family) return;
    const roles = dish.componentSlots.map((slot) => slot.role);
    if (roles.some((role) => !family.allowedRoles.includes(role)) || family.requiredRoles.some((role) => !roles.includes(role))) {
      addIssue(issues, "FAMILY_GRAMMAR_VIOLATION", `${path}.componentSlots`, "Dish roles do not satisfy the exact family grammar.");
    }
    const ingredients = components.map((component) => indexes.ingredient.get(refKey(component.ingredientRef)) as IngredientDefinition | undefined);
    const hasRice = ingredients.some((ingredient) => ingredient?.roles.includes("sushi-rice"));
    const noriSlots = dish.componentSlots.filter((_slot, slotIndex) => ingredients[slotIndex]?.roles.includes("nori"));
    if (family.form === "sashimi" && hasRice) {
      addIssue(issues, "FAMILY_GRAMMAR_VIOLATION", `${path}.componentSlots`, "Sashimi must not contain a sushi-rice component.");
    }
    const invalidNoriSlot = dish.componentSlots.some((slot, slotIndex) => {
      const isNori = ingredients[slotIndex]?.roles.includes("nori") ?? false;
      if (!isNori) return slot.noriPlacement !== undefined;
      return slot.role !== "wrapper" || family.noriPlacement === "none" || slot.noriPlacement !== family.noriPlacement;
    });
    const noriCountInvalid = family.noriPlacement === "none" ? noriSlots.length !== 0 : noriSlots.length !== 1;
    if (invalidNoriSlot || noriCountInvalid) {
      addIssue(issues, "FAMILY_GRAMMAR_VIOLATION", `${path}.componentSlots`, "Nori slots must pin the family placement exactly and use the wrapper role.");
    }
    if (["gunkan", "hosomaki", "futomaki", "uramaki", "temaki"].includes(family.form) && !roles.includes("filling")) {
      addIssue(issues, "FAMILY_GRAMMAR_VIOLATION", `${path}.componentSlots`, "Gunkan and roll families require an exact filling role.");
    }
  });

  bundle.recipes.forEach((recipe, index) => {
    const path = `$.recipes[${index}]`;
    const dish = resolve<DishDefinition>(indexes.dish, recipe.dishRef, `${path}.dishRef`, "dish", issues);
    const recipeSignature = recipe.exactComponentAmounts.map((amount, amountIndex) => {
      resolve(indexes.component, amount.componentRef, `${path}.exactComponentAmounts[${amountIndex}].componentRef`, "component", issues);
      if (!DECIMAL_PATTERN.test(amount.quantity)) addIssue(issues, "RECIPE_INVALID", `${path}.exactComponentAmounts[${amountIndex}].quantity`, "Quantity must be a positive canonical decimal string.");
      return componentSignature(amount.role, amount.componentRef);
    }).sort(compare);
    if (dish) {
      const dishSignature = dish.componentSlots.map((slot) => componentSignature(slot.role, slot.componentRef)).sort(compare);
      if (!sameStrings(recipeSignature, dishSignature)) addIssue(issues, "DISH_COMPONENT_MISMATCH", `${path}.exactComponentAmounts`, "Recipe inputs must exactly match the pinned dish component slots.");
    }
    const result = resolve<DishDefinition>(indexes.dish, recipe.deterministicResult, `${path}.deterministicResult`, "dish", issues);
    if (result && dish && refKey(result) !== refKey(dish)) {
      addIssue(issues, "RECIPE_INVALID", `${path}.deterministicResult`, "Recipe result must resolve to its exact pinned dish.");
    }
    if (recipe.stationSequence.length === 0) addIssue(issues, "RECIPE_INVALID", `${path}.stationSequence`, "Playable recipes require at least one station step.");
    recipe.exactComponentAmounts.forEach((amount, amountIndex) => {
      const component = indexes.component.get(refKey(amount.componentRef)) as PreparedComponent | undefined;
      if (component && !containsOrderedSteps(recipe.stationSequence, component.stationSteps)) {
        addIssue(issues, "RECIPE_INVALID", `${path}.stationSequence`, `Recipe sequence does not contain component ${amountIndex} steps in order.`);
      }
    });
    recipe.seasonalityRuleRefs.forEach((ref, ruleIndex) => resolve(indexes["seasonality-rule"], ref, `${path}.seasonalityRuleRefs[${ruleIndex}]`, "seasonality-rule", issues));
  });

  const expansionKeys = new Set<string>();
  const substitutionEdges = new Map<string, Set<string>>();
  bundle.variants.forEach((variant, index) => {
    const path = `$.variants[${index}]`;
    const recipe = resolve<RecipeVersion>(indexes.recipe, variant.baseRecipeRef, `${path}.baseRecipeRef`, "recipe", issues);
    const result = resolve<DishDefinition>(indexes.dish, variant.resultingDishRef, `${path}.resultingDishRef`, "dish", issues);
    variant.reviewIds.forEach((reviewId, reviewIndex) => validateReview(reviewId, reviews, `${path}.reviewIds[${reviewIndex}]`, issues));
    if (variant.substitutions.length === 0) addIssue(issues, "VARIANT_INVALID", `${path}.substitutions`, "Variants require at least one exact substitution.");
    const fromKeys = new Set<string>();
    const substituted = new Map<string, VersionedRef>();
    variant.substitutions.forEach((substitution, substitutionIndex) => {
      const substitutionPath = `${path}.substitutions[${substitutionIndex}]`;
      const from = refKey(substitution.from);
      if (WILDCARD_PATTERN.test(substitution.from.id) || WILDCARD_PATTERN.test(substitution.to.id)) addIssue(issues, "WILDCARD_FORBIDDEN", substitutionPath, "Variants only accept exact component identities.");
      if (from === refKey(substitution.to) || fromKeys.has(from)) addIssue(issues, "VARIANT_INVALID", substitutionPath, "Substitutions must be non-self and duplicate-free.");
      fromKeys.add(from);
      substituted.set(from, substitution.to);
      const destinations = substitutionEdges.get(from) ?? new Set<string>();
      destinations.add(refKey(substitution.to));
      substitutionEdges.set(from, destinations);
      resolve(indexes.component, substitution.to, `${substitutionPath}.to`, "component", issues);
      if (recipe && !recipe.exactComponentAmounts.some((amount) => refKey(amount.componentRef) === from)) addIssue(issues, "VARIANT_INVALID", `${substitutionPath}.from`, "Substitution source is not an input of the base recipe.");
    });
    if (recipe && result) {
      const expected = recipe.exactComponentAmounts.map((amount) => componentSignature(amount.role, substituted.get(refKey(amount.componentRef)) ?? amount.componentRef)).sort(compare);
      const actual = result.componentSlots.map((slot) => componentSignature(slot.role, slot.componentRef)).sort(compare);
      if (!sameStrings(expected, actual)) addIssue(issues, "VARIANT_INVALID", `${path}.resultingDishRef`, "Concrete resulting dish does not match the finite substitution expansion.");
    }
    const expansionKey = `${refKey(variant.baseRecipeRef)}:${variant.substitutions.map((entry) => `${refKey(entry.from)}>${refKey(entry.to)}`).sort(compare).join(",")}`;
    if (expansionKeys.has(expansionKey)) addIssue(issues, "VARIANT_INVALID", path, "Duplicate variant expansion.");
    expansionKeys.add(expansionKey);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      addIssue(issues, "VARIANT_INVALID", "$.variants", "Variant substitutions must form an acyclic finite graph.");
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const destination of substitutionEdges.get(node) ?? []) visit(destination);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of substitutionEdges.keys()) visit(node);

  const subjectIndexes: Record<string, EntityIndex> = {
    ingredient: indexes.ingredient,
    component: indexes.component,
    dish: indexes.dish,
    recipe: indexes.recipe,
  };
  bundle.seasonalityRules.forEach((rule, index) => {
    const path = `$.seasonalityRules[${index}]`;
    const subjectIndex = subjectIndexes[rule.subjectRef.kind];
    if (!subjectIndex) addIssue(issues, "SEASONALITY_UNRESOLVED", `${path}.subjectRef.kind`, "Unknown seasonality subject kind.");
    else resolve(subjectIndex, rule.subjectRef, `${path}.subjectRef`, rule.subjectRef.kind as IndexedKind, issues);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: rule.ianaTimeZone }).format(0);
    } catch {
      addIssue(issues, "SEASONALITY_UNRESOLVED", `${path}.ianaTimeZone`, "Unknown IANA time zone.");
    }
    if (options.mode !== "historical" && (!RUNTIME_TZDB_VERSION || rule.tzdbVersion !== RUNTIME_TZDB_VERSION)) {
      addIssue(issues, "SEASONALITY_UNRESOLVED", `${path}.tzdbVersion`, `tzdbVersion must match the compiler runtime${RUNTIME_TZDB_VERSION ? ` (${RUNTIME_TZDB_VERSION})` : ""}.`);
    } else if (!/^\d{4}[a-z]$/.test(rule.tzdbVersion)) {
      addIssue(issues, "SEASONALITY_UNRESOLVED", `${path}.tzdbVersion`, "Historical tzdbVersion must remain pinned as YYYYx.");
    }
    if (strictDateOrdinal(rule.reviewedAt) === undefined) addIssue(issues, "SEASONALITY_UNRESOLVED", `${path}.reviewedAt`, "reviewedAt must be a real ISO local date.");
    let previousStart: number | undefined;
    rule.windows.forEach((window, windowIndex) => {
      const windowPath = `${path}.windows[${windowIndex}]`;
      const start = strictDateOrdinal(window.startLocalDateInclusive);
      const end = strictDateOrdinal(window.endLocalDateExclusive);
      if (start === undefined || end === undefined || start >= end || (previousStart !== undefined && start < previousStart)) {
        addIssue(issues, "SEASONALITY_UNRESOLVED", windowPath, "Season windows must be valid, positive, sorted half-open ISO dates.");
      }
      if (start !== undefined) previousStart = start;
      for (let earlierIndex = 0; earlierIndex < windowIndex; earlierIndex += 1) {
        const earlier = rule.windows[earlierIndex];
        if (!earlier) continue;
        const earlierEnd = strictDateOrdinal(earlier.endLocalDateExclusive);
        if (start !== undefined && earlierEnd !== undefined && start < earlierEnd && earlier.availability !== window.availability) {
          addIssue(issues, "SEASONALITY_UNRESOLVED", windowPath, "Overlapping season windows cannot contradict availability.");
        }
      }
    });
  });

  const membership: readonly [readonly VersionedRef[], readonly VersionedEntity[], string][] = [
    [bundle.pack.speciesRefs, bundle.species, "speciesRefs"],
    [bundle.pack.ingredientRefs, bundle.ingredients, "ingredientRefs"],
    [bundle.pack.cutStyleRefs, bundle.cutStyles, "cutStyleRefs"],
    [bundle.pack.componentRefs, bundle.components, "componentRefs"],
    [bundle.pack.familyRefs, bundle.families, "familyRefs"],
    [bundle.pack.dishRefs, bundle.dishes, "dishRefs"],
    [bundle.pack.recipeRefs, bundle.recipes, "recipeRefs"],
    [bundle.pack.variantRefs, bundle.variants, "variantRefs"],
    [bundle.pack.seasonalityRuleRefs, bundle.seasonalityRules, "seasonalityRuleRefs"],
  ];
  for (const [refs, rows, name] of membership) {
    const actual = refs.map(refKey);
    const expected = rows.map(refKey).sort(compare);
    assertCanonicalSet(actual, `$.pack.${name}`, issues);
    if (!sameStrings(actual, expected)) addIssue(issues, "PACK_MEMBERSHIP_MISMATCH", `$.pack.${name}`, "Pack membership must exactly and atomically enumerate the supplied definitions.");
  }
  const artKeys = bundle.artAssets.map((asset) => asset.key);
  assertCanonicalSet(artKeys, "$.artAssets", issues);
  if (bundle.pack.artAssetMapHash !== contentHashFor(bundle.artAssets)) {
    addIssue(issues, "PACK_MEMBERSHIP_MISMATCH", "$.pack.artAssetMapHash", "Pack must hash-bind the exact art key, digest, and non-color identity mapping.");
  }
  if (bundle.pack.contentManifestHash !== contentManifestHashFor(bundle)) {
    addIssue(issues, "PACK_MEMBERSHIP_MISMATCH", "$.pack.contentManifestHash", "Pack must hash-bind every versioned row and content hash.");
  }

  if (issues.length > 0) throw new ContentValidationError(sortedIssues(issues));
  const frozenBundle = deepFreeze(bundle);
  const readonlyIndexes = Object.fromEntries(
    Object.entries(indexes).map(([kind, index]) => [kind, readonlyMap(index)]),
  ) as Record<IndexedKind, ReadonlyMap<string, VersionedEntity>>;
  return deepFreeze({ bundle: frozenBundle, indexes: readonlyIndexes, dishFacts: readonlyMap(dishFacts) });
}

export function deriveDishFacts(pack: CompiledContentPack, dishRef: VersionedRef): DishFacts {
  const facts = pack.dishFacts.get(refKey(dishRef));
  if (!facts) throw new ContentValidationError([{ code: "BROKEN_REFERENCE", path: "$.dishRef", message: `Unknown dish reference ${refKey(dishRef)}.` }]);
  return facts;
}
