import { contentHashFor, contentManifestHashFor } from "../hash";
import {
  CONTENT_SCHEMA_VERSION,
  type ArtAsset,
  type ContentBundle,
  type ContentPack,
  type DishDefinition,
  type DishFamily,
  type IngredientDefinition,
  type PreparedComponent,
  type RecipeVersion,
  type VersionedEntity,
  type VersionedRef,
} from "../model";
import { salmonSashimiDraftBundle } from "./salmon-sashimi";

type Unhashed<T extends VersionedEntity> = Omit<T, "contentHash">;

function hashed<T extends VersionedEntity>(row: Unhashed<T>): T {
  return { ...row, contentHash: contentHashFor(row) } as T;
}

function ref(row: VersionedEntity): VersionedRef {
  return { id: row.id, version: row.version };
}

const reviewId = "phase-1-service-review-pending-v1";
const inheritedSalmon = salmonSashimiDraftBundle.species[0]!;
const inheritedSalmonFlesh = salmonSashimiDraftBundle.ingredients[0]!;

const ingredients: readonly IngredientDefinition[] = [
  inheritedSalmonFlesh,
  hashed<IngredientDefinition>({
    id: "cucumber",
    version: 1,
    kind: "produce",
    roles: ["produce"],
    names: { en: "Cucumber" },
    glossary: "The version-pinned cucumber ingredient for the authored first-service roll.",
    baseContainsAllergens: [],
    baseMayContainAllergens: [],
    baseCrossContactTags: [],
    artKey: "ingredient-cucumber-v1",
    reviewId,
  }),
  hashed<IngredientDefinition>({
    id: "nori",
    version: 1,
    kind: "staple",
    roles: ["nori"],
    names: { en: "Nori" },
    glossary: "The version-pinned nori ingredient for the authored first-service dishes.",
    baseContainsAllergens: [],
    baseMayContainAllergens: [],
    baseCrossContactTags: [],
    artKey: "ingredient-nori-v1",
    reviewId,
  }),
  hashed<IngredientDefinition>({
    id: "rice-vinegar",
    version: 1,
    kind: "condiment",
    roles: ["seasoning"],
    names: { en: "Rice vinegar" },
    glossary: "The version-pinned seasoning identity referenced by the forgiving rice-preparation sequence.",
    baseContainsAllergens: [],
    baseMayContainAllergens: [],
    baseCrossContactTags: [],
    artKey: "ingredient-rice-vinegar-v1",
    reviewId,
  }),
  hashed<IngredientDefinition>({
    id: "sushi-rice",
    version: 1,
    kind: "staple",
    roles: ["sushi-rice"],
    names: { en: "Sushi rice" },
    glossary: "The version-pinned rice identity used by the authored first-service recipes.",
    baseContainsAllergens: [],
    baseMayContainAllergens: [],
    baseCrossContactTags: [],
    artKey: "ingredient-sushi-rice-v1",
    reviewId,
  }),
  hashed<IngredientDefinition>({
    id: "tamago",
    version: 1,
    kind: "egg",
    roles: ["egg"],
    names: { en: "Cooked egg" },
    glossary: "The version-pinned cooked-egg ingredient for the authored tamago nigiri.",
    baseContainsAllergens: ["egg"],
    baseMayContainAllergens: [],
    baseCrossContactTags: [],
    artKey: "ingredient-tamago-v1",
    reviewId,
  }),
].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const ingredient = (id: string): IngredientDefinition => ingredients.find((row) => row.id === id)!;

const components: readonly PreparedComponent[] = [
  hashed<PreparedComponent>({
    id: "cooked-tamago",
    version: 1,
    ingredientRef: ref(ingredient("tamago")),
    treatment: "cooked",
    rawNotice: "none",
    containsAllergens: ["egg"],
    mayContainAllergens: [],
    crossContactTags: [],
    stationSteps: [],
    artKey: "component-cooked-tamago-v1",
    reviewId,
  }),
  hashed<PreparedComponent>({
    id: "cucumber-strip",
    version: 1,
    ingredientRef: ref(ingredient("cucumber")),
    treatment: "plant",
    rawNotice: "none",
    containsAllergens: [],
    mayContainAllergens: [],
    crossContactTags: [],
    stationSteps: [],
    artKey: "component-cucumber-strip-v1",
    reviewId,
  }),
  hashed<PreparedComponent>({
    id: "nori-sheet",
    version: 1,
    ingredientRef: ref(ingredient("nori")),
    treatment: "plant",
    rawNotice: "none",
    containsAllergens: [],
    mayContainAllergens: [],
    crossContactTags: [],
    stationSteps: [],
    artKey: "component-nori-sheet-v1",
    reviewId,
  }),
  hashed<PreparedComponent>({
    id: "prepared-salmon-topping",
    version: 1,
    ingredientRef: ref(inheritedSalmonFlesh),
    treatment: "cooked",
    rawNotice: "none",
    containsAllergens: ["fish"],
    mayContainAllergens: [],
    crossContactTags: [],
    stationSteps: [{ station: "prep-sashimi-board", action: "arrange" }],
    artKey: "component-prepared-salmon-topping-v1",
    reviewId,
  }),
  hashed<PreparedComponent>({
    id: "prepared-sushi-rice",
    version: 1,
    ingredientRef: ref(ingredient("sushi-rice")),
    preparationInputs: [{
      ingredientRef: ref(ingredient("rice-vinegar")),
      stationStep: { station: "rice-hearth", action: "season" },
    }],
    treatment: "seasoned",
    rawNotice: "none",
    containsAllergens: [],
    mayContainAllergens: [],
    crossContactTags: [],
    stationSteps: [],
    artKey: "component-prepared-sushi-rice-v1",
    reviewId,
  }),
].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const component = (id: string): PreparedComponent => components.find((row) => row.id === id)!;

const families: readonly DishFamily[] = [
  hashed<DishFamily>({
    id: "bound-nigiri",
    version: 1,
    form: "nigiri",
    requiredRoles: ["rice", "topping", "wrapper"],
    allowedRoles: ["garnish", "rice", "topping", "wrapper"],
    noriPlacement: "outer-wrapper",
    namingRules: ["Name the exact authored topping and the nigiri form."],
    platingRules: ["The topping, rice base, and center binding remain identifiable without color."],
    reviewId,
  }),
  hashed<DishFamily>({
    id: "hosomaki",
    version: 1,
    form: "hosomaki",
    requiredRoles: ["filling", "rice", "wrapper"],
    allowedRoles: ["filling", "garnish", "rice", "wrapper"],
    noriPlacement: "outer-wrapper",
    namingRules: ["Name the exact authored filling and the maki form."],
    platingRules: ["The cut roll and outer wrapper remain identifiable without color."],
    reviewId,
  }),
  hashed<DishFamily>({
    id: "nigiri",
    version: 1,
    form: "nigiri",
    requiredRoles: ["rice", "topping"],
    allowedRoles: ["garnish", "rice", "topping"],
    noriPlacement: "none",
    namingRules: ["Name the exact authored topping and the nigiri form."],
    platingRules: ["The topping and rice base remain identifiable without color."],
    reviewId,
  }),
].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const family = (id: string): DishFamily => families.find((row) => row.id === id)!;

const dishes: readonly DishDefinition[] = [
  hashed<DishDefinition>({
    id: "kappa-maki",
    version: 1,
    familyRef: ref(family("hosomaki")),
    names: { en: "Kappa maki" },
    glossary: "An authored cucumber roll for the first service.",
    componentSlots: [
      { role: "filling", componentRef: ref(component("cucumber-strip")) },
      { role: "wrapper", componentRef: ref(component("nori-sheet")), noriPlacement: "outer-wrapper" },
      { role: "rice", componentRef: ref(component("prepared-sushi-rice")) },
    ],
    containsAllergens: [],
    mayContainAllergens: [],
    crossContactTags: [],
    rawProfile: "none",
    dietaryTags: [],
    presentationRules: ["The sliced roll and outer nori ring remain legible without color."],
    nonColorIdentity: "A cut narrow roll with an outer wrapper ring and centered cucumber strip.",
    artKey: "dish-kappa-maki-v1",
    reviewId,
  }),
  hashed<DishDefinition>({
    id: "salmon-nigiri",
    version: 1,
    familyRef: ref(family("nigiri")),
    names: { en: "Salmon nigiri" },
    glossary: "An authored cooked-salmon-and-rice nigiri for the courier order.",
    componentSlots: [
      { role: "topping", componentRef: ref(component("prepared-salmon-topping")) },
      { role: "rice", componentRef: ref(component("prepared-sushi-rice")) },
    ],
    containsAllergens: ["fish"],
    mayContainAllergens: [],
    crossContactTags: [],
    rawProfile: "none",
    dietaryTags: [],
    presentationRules: ["The broad topping and compact rice base remain legible without color."],
    nonColorIdentity: "A broad cooked-salmon topping over a compact rice base.",
    artKey: "dish-salmon-nigiri-v1",
    reviewId,
  }),
  hashed<DishDefinition>({
    id: "tamago-nigiri",
    version: 1,
    familyRef: ref(family("bound-nigiri")),
    names: { en: "Tamago nigiri" },
    glossary: "An authored cooked-egg nigiri bound with nori.",
    componentSlots: [
      { role: "topping", componentRef: ref(component("cooked-tamago")) },
      { role: "wrapper", componentRef: ref(component("nori-sheet")), noriPlacement: "outer-wrapper" },
      { role: "rice", componentRef: ref(component("prepared-sushi-rice")) },
    ],
    containsAllergens: ["egg"],
    mayContainAllergens: [],
    crossContactTags: [],
    rawProfile: "none",
    dietaryTags: [],
    presentationRules: ["The rectangular topping and center binding remain legible without color."],
    nonColorIdentity: "A rectangular cooked-egg topping bound to a compact rice base by a center strip.",
    artKey: "dish-tamago-nigiri-v1",
    reviewId,
  }),
].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const dish = (id: string): DishDefinition => dishes.find((row) => row.id === id)!;

const recipes: readonly RecipeVersion[] = [
  hashed<RecipeVersion>({
    id: "kappa-maki",
    version: 1,
    dishRef: ref(dish("kappa-maki")),
    exactComponentAmounts: [
      { componentRef: ref(component("cucumber-strip")), quantity: "1", unit: "portion", role: "filling" },
      { componentRef: ref(component("nori-sheet")), quantity: "1", unit: "portion", role: "wrapper" },
      { componentRef: ref(component("prepared-sushi-rice")), quantity: "1", unit: "portion", role: "rice" },
    ],
    stationSequence: [
      { station: "rolling-mat", action: "layer" },
      { station: "rolling-mat", action: "portion" },
      { station: "rolling-mat", action: "fill" },
      { station: "rolling-mat", action: "roll" },
      { station: "rolling-mat", action: "cut" },
    ],
    deterministicResult: ref(dish("kappa-maki")),
    unlockRule: "available-at-start",
    recovery: "retry-with-corrective-cue",
    seasonalityRuleRefs: [],
    status: "draft",
    reviewId,
  }),
  hashed<RecipeVersion>({
    id: "salmon-nigiri",
    version: 1,
    dishRef: ref(dish("salmon-nigiri")),
    exactComponentAmounts: [
      { componentRef: ref(component("prepared-salmon-topping")), quantity: "1", unit: "portion", role: "topping" },
      { componentRef: ref(component("prepared-sushi-rice")), quantity: "1", unit: "portion", role: "rice" },
    ],
    stationSequence: [
      { station: "prep-sashimi-board", action: "arrange" },
      { station: "nigiri-counter", action: "portion" },
      { station: "nigiri-counter", action: "press" },
      { station: "nigiri-counter", action: "layer" },
    ],
    deterministicResult: ref(dish("salmon-nigiri")),
    unlockRule: "available-at-start",
    recovery: "retry-with-corrective-cue",
    seasonalityRuleRefs: [],
    status: "draft",
    reviewId,
  }),
  hashed<RecipeVersion>({
    id: "tamago-nigiri",
    version: 1,
    dishRef: ref(dish("tamago-nigiri")),
    exactComponentAmounts: [
      { componentRef: ref(component("cooked-tamago")), quantity: "1", unit: "portion", role: "topping" },
      { componentRef: ref(component("nori-sheet")), quantity: "1", unit: "portion", role: "wrapper" },
      { componentRef: ref(component("prepared-sushi-rice")), quantity: "1", unit: "portion", role: "rice" },
    ],
    stationSequence: [
      { station: "nigiri-counter", action: "portion" },
      { station: "nigiri-counter", action: "press" },
      { station: "nigiri-counter", action: "layer" },
      { station: "nigiri-counter", action: "bind" },
    ],
    deterministicResult: ref(dish("tamago-nigiri")),
    unlockRule: "available-at-start",
    recovery: "retry-with-corrective-cue",
    seasonalityRuleRefs: [],
    status: "draft",
    reviewId,
  }),
].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const artAsset = (key: string, nonColorIdentity: string): ArtAsset => ({
  key,
  digest: contentHashFor({ key, nonColorIdentity }),
  nonColorIdentity,
});

const inheritedSalmonArt = salmonSashimiDraftBundle.artAssets.find((asset) => asset.key === inheritedSalmonFlesh.artKey)!;
const artAssets: readonly ArtAsset[] = [
  inheritedSalmonArt,
  artAsset("component-cooked-tamago-v1", "A rectangular cooked-egg component."),
  artAsset("component-cucumber-strip-v1", "A long cucumber strip."),
  artAsset("component-nori-sheet-v1", "A square sheet with one corner notch."),
  artAsset("component-prepared-salmon-topping-v1", "A broad cooked-salmon topping."),
  artAsset("component-prepared-sushi-rice-v1", "A compact prepared-rice mound."),
  artAsset("dish-kappa-maki-v1", "A cut narrow roll with an outer wrapper ring and centered cucumber strip."),
  artAsset("dish-salmon-nigiri-v1", "A broad cooked-salmon topping over a compact rice base."),
  artAsset("dish-tamago-nigiri-v1", "A rectangular cooked-egg topping bound to a compact rice base by a center strip."),
  artAsset("ingredient-cucumber-v1", "A long cucumber silhouette."),
  artAsset("ingredient-nori-v1", "A square sheet silhouette with one corner notch."),
  artAsset("ingredient-rice-vinegar-v1", "A narrow labeled seasoning vessel."),
  artAsset("ingredient-sushi-rice-v1", "A compact rice-grain mound."),
  artAsset("ingredient-tamago-v1", "A rectangular cooked-egg block."),
].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

const reviewReferences = [salmonSashimiDraftBundle.reviewReferences[0]!, reviewId].sort();

const pack = hashed<ContentPack>({
  id: "first-evening-service",
  version: 1,
  schemaVersion: CONTENT_SCHEMA_VERSION,
  speciesRefs: [ref(inheritedSalmon)],
  ingredientRefs: ingredients.map(ref),
  cutStyleRefs: [],
  componentRefs: components.map(ref),
  familyRefs: families.map(ref),
  dishRefs: dishes.map(ref),
  recipeRefs: recipes.map(ref),
  variantRefs: [],
  seasonalityRuleRefs: [],
  contentManifestHash: contentManifestHashFor({
    species: [inheritedSalmon],
    ingredients,
    cutStyles: [],
    components,
    families,
    dishes,
    recipes,
    variants: [],
    seasonalityRules: [],
  }),
  artAssetMapHash: contentHashFor(artAssets),
  archivePolicy: "append-only",
  reviewerSignoffs: [reviewId],
  reviewId,
});

/**
 * Versioned, hash-bound development content for the walletless first service.
 * Review references remain provisional and are not a public-release approval.
 */
export const firstEveningServiceCatalogBundle: ContentBundle = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  pack,
  species: [inheritedSalmon],
  ingredients,
  cutStyles: [],
  components,
  families,
  dishes,
  recipes,
  variants: [],
  seasonalityRules: [],
  artAssets,
  reviewReferences,
};
