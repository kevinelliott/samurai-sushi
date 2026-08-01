import { describe, expect, it } from "vitest";
import { compileContentPack } from "./compile";
import { ContentValidationError, type ContentIssueCode, type StableContentFailureCode } from "./errors";
import { salmonSashimiDraftBundle } from "./fixtures/salmon-sashimi";
import { contentHashFor, contentManifestHashFor } from "./hash";
import type { ContentBundle, VersionedEntity } from "./model";
import { recipeSnapshot } from "./replay";
import { evaluateSeasonality } from "./seasonality";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const clone = (): Mutable<ContentBundle> => structuredClone(salmonSashimiDraftBundle) as Mutable<ContentBundle>;
const ref = (row: Pick<VersionedEntity, "id" | "version">) => ({ id: row.id, version: row.version });
const rehash = <T extends object>(row: T): T & { contentHash: string } => ({ ...row, contentHash: contentHashFor(row) });

function syncPack(bundle: Mutable<ContentBundle>): void {
  bundle.pack = rehash({
    ...bundle.pack,
    contentManifestHash: contentManifestHashFor(bundle),
    artAssetMapHash: contentHashFor(bundle.artAssets),
  });
}

function expectIssue(
  input: unknown,
  issueCode: ContentIssueCode,
  stableCode?: StableContentFailureCode,
): ContentValidationError {
  try {
    compileContentPack(input);
    throw new Error("expected content validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ContentValidationError);
    const validation = error as ContentValidationError;
    expect(validation.issues.some((issue) => issue.code === issueCode)).toBe(true);
    if (stableCode) expect(validation.stableCode).toBe(stableCode);
    return validation;
  }
}

describe("compileContentPack", () => {
  it("canonicalizes object keys without locale-sensitive ordering", () => {
    expect(contentHashFor({ zeta: 2, alpha: 1 })).toBe(contentHashFor({ alpha: 1, zeta: 2 }));
    expect(contentHashFor({ alpha: 1 })).not.toBe(contentHashFor({ alpha: 2 }));
    expect(() => contentHashFor({ alpha: undefined })).toThrow(/canonical JSON/);
  });

  it("compiles, freezes, and reproduces the fixture byte-for-byte", () => {
    const first = compileContentPack(salmonSashimiDraftBundle);
    const second = compileContentPack(salmonSashimiDraftBundle);
    expect(first.bundle).toEqual(second.bundle);
    expect(Object.isFrozen(first.bundle)).toBe(true);
    expect("set" in first.indexes.dish).toBe(false);
    expect("set" in first.dishFacts).toBe(false);
    const facts = first.dishFacts.get("atlantic-salmon-sashimi@1")!;
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.containsAllergens)).toBe(true);
    expect(() => (facts.containsAllergens as string[]).push("egg")).toThrow();
    expect(first.dishFacts.get("atlantic-salmon-sashimi@1")).toEqual({
      containsAllergens: ["fish"],
      mayContainAllergens: [],
      crossContactTags: [],
      rawProfile: "notice-required",
    });
    expect(recipeSnapshot(first.bundle, { id: "atlantic-salmon-sashimi", version: 1 })).toBe(
      recipeSnapshot(second.bundle, { id: "atlantic-salmon-sashimi", version: 1 }),
    );
  });

  it("rejects hostile shape, hash drift, duplicate identities, and incomplete pack membership", () => {
    expectIssue({ ...clone(), unexpected: true }, "INVALID_CONTENT_SHAPE", "CONTENT_VERSION_DRIFT");
    const hashDrift = clone();
    hashDrift.ingredients[0] = { ...hashDrift.ingredients[0]!, glossary: "silently changed" };
    expectIssue(hashDrift, "CONTENT_HASH_MISMATCH", "CONTENT_VERSION_DRIFT");
    const duplicate = clone();
    duplicate.species = [...duplicate.species, duplicate.species[0]!];
    expectIssue(duplicate, "DUPLICATE_IDENTITY", "CONTENT_VERSION_DRIFT");
    const incomplete = clone();
    incomplete.pack = rehash({ ...incomplete.pack, recipeRefs: [] });
    expectIssue(incomplete, "PACK_MEMBERSHIP_MISMATCH", "CONTENT_VERSION_DRIFT");
    const invalidEnum = clone();
    invalidEnum.species[0] = rehash({ ...invalidEnum.species[0]!, group: "dragon" as never });
    expectIssue(invalidEnum, "INVALID_CONTENT_SHAPE", "CONTENT_VERSION_DRIFT");
  });

  it("requires immutable art and registered structural review references", () => {
    const missingArt = clone();
    missingArt.artAssets = missingArt.artAssets.filter((asset) => asset.key !== missingArt.dishes[0]!.artKey);
    expectIssue(missingArt, "ART_REFERENCE_MISSING", "PROVENANCE_UNVERIFIED");

    const missingReview = clone();
    missingReview.reviewReferences = ["unrelated-review"];
    expectIssue(missingReview, "REVIEW_REFERENCE_MISSING", "PROVENANCE_UNVERIFIED");
  });

  it("hash-binds the complete art key, digest, and non-color identity mapping", () => {
    const swapped = clone();
    const first = swapped.artAssets[0]!;
    const second = swapped.artAssets[1]!;
    swapped.artAssets[0] = { ...first, digest: second.digest };
    swapped.artAssets[1] = { ...second, digest: first.digest };
    expectIssue(swapped, "PACK_MEMBERSHIP_MISMATCH", "CONTENT_VERSION_DRIFT");

    const relabeled = clone();
    relabeled.artAssets[0] = { ...relabeled.artAssets[0]!, nonColorIdentity: "silently changed silhouette" };
    expectIssue(relabeled, "PACK_MEMBERSHIP_MISMATCH", "CONTENT_VERSION_DRIFT");
  });

  it("keeps biological, culinary, component, dish, and token-like identities non-equal and rejects uni as roe", () => {
    const bundle = clone();
    const identities = [bundle.species[0]?.id, bundle.ingredients[0]?.id, bundle.components[0]?.id, bundle.dishes[0]?.id, "SALMON-token"];
    expect(new Set(identities).size).toBe(5);
    const original = bundle.ingredients[0]!;
    const uni = rehash({ ...original, id: "uni", productKind: "roe" as const, roles: ["roe" as const], names: { en: "Uni" } });
    bundle.ingredients = [uni];
    bundle.components[0] = rehash({ ...bundle.components[0]!, ingredientRef: ref(uni) });
    bundle.pack = rehash({ ...bundle.pack, ingredientRefs: [ref(uni)] });
    expectIssue(bundle, "INGREDIENT_SPECIES_INVALID", "UNKNOWN_SPECIES");
  });

  it("rejects sashimi rice, incompatible cuts, raw-policy conflicts, and contains downgrades", () => {
    const rice = clone();
    rice.ingredients[0] = rehash({ ...rice.ingredients[0]!, roles: ["sushi-rice" as const] });
    expectIssue(rice, "FAMILY_GRAMMAR_VIOLATION", "DISH_FAMILY_MISMATCH");

    const cut = clone();
    cut.cutStyles[0] = rehash({ ...cut.cutStyles[0]!, compatibleProductKinds: ["roe" as const] });
    expectIssue(cut, "INGREDIENT_SPECIES_INVALID", "UNKNOWN_COMPONENT");

    const raw = clone();
    raw.components[0] = rehash({ ...raw.components[0]!, rawNotice: "none" as const });
    expectIssue(raw, "RAW_POLICY_INVALID", "RAW_PROFILE_CONFLICT");

    const allergen = clone();
    allergen.components[0] = rehash({ ...allergen.components[0]!, containsAllergens: [], mayContainAllergens: ["fish" as const] });
    expectIssue(allergen, "ALLERGEN_DERIVATION_MISMATCH", "ALLERGEN_CONFLICT");
  });

  it("rejects wildcard and cyclic variant substitutions", () => {
    const bundle = clone();
    const component = bundle.components[0]!;
    const cooked = rehash({ ...component, id: "cooked-atlantic-salmon", treatment: "cooked" as const, rawNotice: "none" as const });
    bundle.components = [component, cooked];
    const wildcard = rehash({
      id: "wildcard-variant",
      version: 1,
      reviewId: component.reviewId,
      baseRecipeRef: ref(bundle.recipes[0]!),
      substitutions: [{ from: ref(component), to: { id: "any-fish", version: 1 } }],
      resultingDishRef: ref(bundle.dishes[0]!),
      reason: "species" as const,
      reviewIds: [component.reviewId],
      status: "draft" as const,
    });
    bundle.variants = [wildcard];
    bundle.pack = rehash({ ...bundle.pack, componentRefs: [ref(component), ref(cooked)], variantRefs: [ref(wildcard)] });
    expectIssue(bundle, "WILDCARD_FORBIDDEN", "AMBIGUOUS_VARIANT");

    const cyclicBundle = clone();
    cyclicBundle.components = [component, cooked];
    const cyclic = rehash({
      ...wildcard,
      id: "cyclic-variant",
      substitutions: [{ from: ref(component), to: ref(cooked) }, { from: ref(cooked), to: ref(component) }],
    });
    cyclicBundle.variants = [cyclic];
    cyclicBundle.pack = rehash({ ...cyclicBundle.pack, componentRefs: [ref(component), ref(cooked)], variantRefs: [ref(cyclic)] });
    expectIssue(cyclicBundle, "VARIANT_INVALID", "AMBIGUOUS_VARIANT");
  });

  it("rejects non-positive or noncanonical quantities", () => {
    const bundle = clone();
    bundle.recipes[0] = rehash({
      ...bundle.recipes[0]!,
      exactComponentAmounts: [{ ...bundle.recipes[0]!.exactComponentAmounts[0]!, quantity: "0" }],
    });
    expectIssue(bundle, "RECIPE_INVALID", "INVALID_QUANTITY");
  });

  it("rejects unsupported dietary claims and unreachable deterministic results", () => {
    const dietary = clone();
    dietary.dishes[0] = rehash({ ...dietary.dishes[0]!, dietaryTags: ["vegan"] });
    expectIssue(dietary, "RECIPE_INVALID", "UNKNOWN_RECIPE");

    const result = clone();
    result.recipes[0] = rehash({ ...result.recipes[0]!, deterministicResult: { id: "missing-dish", version: 1 } });
    expectIssue(result, "BROKEN_REFERENCE", "UNKNOWN_RECIPE");
  });

  it("enforces the exact authored nori placement at the component slot", () => {
    const bundle = clone();
    const originalIngredient = bundle.ingredients[0]!;
    const { speciesRef: _speciesRef, productKind: _productKind, ...ingredientBase } = originalIngredient;
    const ingredient = rehash({ ...ingredientBase, kind: "staple" as const, roles: ["nori" as const], baseContainsAllergens: [] });
    const originalComponent = bundle.components[0]!;
    const { cutStyleRef: _cutStyleRef, ...componentBase } = originalComponent;
    const component = rehash({ ...componentBase, treatment: "plant" as const, rawNotice: "none" as const, containsAllergens: [] });
    const family = rehash({
      ...bundle.families[0]!,
      form: "nigiri" as const,
      requiredRoles: ["wrapper" as const],
      allowedRoles: ["wrapper" as const],
      noriPlacement: "outer-wrapper" as const,
    });
    const wrongDish = rehash({
      ...bundle.dishes[0]!,
      familyRef: ref(family),
      componentSlots: [{ role: "wrapper" as const, componentRef: ref(component), noriPlacement: "inner-layer" as const }],
      containsAllergens: [],
      rawProfile: "none" as const,
    });
    const recipe = rehash({
      ...bundle.recipes[0]!,
      dishRef: ref(wrongDish),
      deterministicResult: ref(wrongDish),
      exactComponentAmounts: [{ ...bundle.recipes[0]!.exactComponentAmounts[0]!, componentRef: ref(component), role: "wrapper" as const }],
    });
    bundle.ingredients = [ingredient];
    bundle.components = [component];
    bundle.families = [family];
    bundle.dishes = [wrongDish];
    bundle.recipes = [recipe];
    syncPack(bundle);
    expectIssue(bundle, "FAMILY_GRAMMAR_VIOLATION", "DISH_FAMILY_MISMATCH");

    const correctDish = rehash({ ...wrongDish, componentSlots: [{ role: "wrapper" as const, componentRef: ref(component), noriPlacement: "outer-wrapper" as const }] });
    bundle.dishes = [correctDish];
    bundle.recipes = [rehash({ ...recipe, dishRef: ref(correctDish), deterministicResult: ref(correctDish) })];
    syncPack(bundle);
    expect(() => compileContentPack(bundle)).not.toThrow();
  });

  it("evaluates half-open regional seasonality with no-rule unspecified", () => {
    const subjectRef = { kind: "dish" as const, id: "atlantic-salmon-sashimi", version: 1 };
    const rule = {
      id: "salmon-pnw-season",
      version: 1,
      contentHash: "unused-by-evaluator",
      reviewId: "fixture-culinary-review-v1",
      subjectRef,
      regionId: "us-pnw",
      ianaTimeZone: "America/Los_Angeles",
      calendar: "iso8601-gregorian" as const,
      tzdbVersion: "2025b",
      windows: [{ startLocalDateInclusive: "2026-06-01", endLocalDateExclusive: "2026-09-01", availability: "available" as const }],
      sourceRef: "fixture-source",
      reviewedAt: "2026-07-31",
    };
    expect(evaluateSeasonality([rule], subjectRef, "us-pnw", "2026-05-31")).toBe("unavailable");
    expect(evaluateSeasonality([rule], subjectRef, "us-pnw", "2026-06-01")).toBe("available");
    expect(evaluateSeasonality([rule], subjectRef, "us-pnw", "2026-09-01")).toBe("unavailable");
    expect(evaluateSeasonality([rule], subjectRef, "jp-kanto", "2026-06-01")).toBe("unspecified");
  });

  it("rejects invalid, unpinned, and contradictory seasonality rules", () => {
    const bundle = clone();
    const dish = bundle.dishes[0]!;
    const rule = rehash({
      id: "salmon-pnw-season",
      version: 1,
      reviewId: dish.reviewId,
      subjectRef: { kind: "dish" as const, ...ref(dish) },
      regionId: "us-pnw",
      ianaTimeZone: "America/Los_Angeles",
      calendar: "iso8601-gregorian" as const,
      tzdbVersion: "2025b",
      windows: [
        { startLocalDateInclusive: "2026-06-01", endLocalDateExclusive: "2026-08-01", availability: "available" as const },
        { startLocalDateInclusive: "2026-07-01", endLocalDateExclusive: "2026-09-01", availability: "unavailable" as const },
      ],
      sourceRef: "fixture-source",
      reviewedAt: "2026-07-31",
    });
    bundle.seasonalityRules = [rule];
    bundle.pack = rehash({ ...bundle.pack, seasonalityRuleRefs: [ref(rule)] });
    expectIssue(bundle, "SEASONALITY_UNRESOLVED", "SEASONALITY_UNRESOLVED");
  });

  it("replays structurally valid historical tzdb content without reactivating it", () => {
    const bundle = clone();
    const dish = bundle.dishes[0]!;
    const rule = rehash({
      id: "historical-salmon-season",
      version: 1,
      reviewId: dish.reviewId,
      subjectRef: { kind: "dish" as const, ...ref(dish) },
      regionId: "us-pnw",
      ianaTimeZone: "America/Los_Angeles",
      calendar: "iso8601-gregorian" as const,
      tzdbVersion: "2025b",
      windows: [{ startLocalDateInclusive: "2025-06-01", endLocalDateExclusive: "2025-09-01", availability: "available" as const }],
      sourceRef: "fixture-historical-source",
      reviewedAt: "2025-07-31",
    });
    bundle.seasonalityRules = [rule];
    bundle.pack = rehash({ ...bundle.pack, seasonalityRuleRefs: [ref(rule)] });
    syncPack(bundle);
    expectIssue(bundle, "SEASONALITY_UNRESOLVED", "SEASONALITY_UNRESOLVED");
    expect(() => recipeSnapshot(bundle, bundle.recipes[0]!)).not.toThrow();
  });

  it("keeps a historical recipe snapshot byte-equivalent after new transitive versions", () => {
    const original = compileContentPack(clone());
    const before = recipeSnapshot(original.bundle, { id: "atlantic-salmon-sashimi", version: 1 });
    const bundle = clone();
    const componentV2 = rehash({ ...bundle.components[0]!, version: 2, artKey: "raw-salmon-v2" });
    const dishV2 = rehash({ ...bundle.dishes[0]!, version: 2, componentSlots: [{ role: "topping" as const, componentRef: ref(componentV2) }], artKey: "salmon-dish-v2" });
    const recipeV2 = rehash({ ...bundle.recipes[0]!, version: 2, dishRef: ref(dishV2), deterministicResult: ref(dishV2), exactComponentAmounts: [{ ...bundle.recipes[0]!.exactComponentAmounts[0]!, componentRef: ref(componentV2) }] });
    bundle.components = [...bundle.components, componentV2];
    bundle.dishes = [...bundle.dishes, dishV2];
    bundle.recipes = [...bundle.recipes, recipeV2];
    bundle.artAssets = [...bundle.artAssets, { key: "raw-salmon-v2", digest: contentHashFor({ fixture: "component-v2" }), nonColorIdentity: "wider striped slice" }, { key: "salmon-dish-v2", digest: contentHashFor({ fixture: "dish-v2" }), nonColorIdentity: "four offset slices" }];
    bundle.pack = rehash({
      ...bundle.pack,
      componentRefs: [...bundle.pack.componentRefs, ref(componentV2)],
      dishRefs: [...bundle.pack.dishRefs, ref(dishV2)],
      recipeRefs: [...bundle.pack.recipeRefs, ref(recipeV2)],
      contentManifestHash: contentManifestHashFor(bundle),
      artAssetMapHash: contentHashFor(bundle.artAssets),
    });
    const expanded = compileContentPack(bundle);
    expect(recipeSnapshot(expanded.bundle, { id: "atlantic-salmon-sashimi", version: 1 })).toBe(before);
    expect(recipeSnapshot(expanded.bundle, ref(recipeV2))).not.toBe(before);
  });
});
