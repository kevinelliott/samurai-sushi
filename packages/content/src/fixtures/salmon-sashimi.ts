import { contentHashFor, contentManifestHashFor } from "../hash";
import {
  CONTENT_SCHEMA_VERSION,
  type ContentBundle,
  type ContentPack,
  type CutStyle,
  type DishDefinition,
  type DishFamily,
  type IngredientDefinition,
  type PreparedComponent,
  type RecipeVersion,
  type SpeciesDefinition,
  type VersionedEntity,
} from "../model";

type Unhashed<T extends VersionedEntity> = Omit<T, "contentHash">;

function hashed<T extends VersionedEntity>(row: Unhashed<T>): T {
  return { ...row, contentHash: contentHashFor(row) } as T;
}

const reviewId = "fixture-culinary-review-v1";

const salmon = hashed<SpeciesDefinition>({
  id: "atlantic-salmon",
  version: 1,
  scientificName: "Salmo salar",
  localizedCommonNames: { en: "Atlantic salmon" },
  marketNames: ["salmon"],
  group: "finfish",
  reviewId,
});

const salmonFlesh = hashed<IngredientDefinition>({
  id: "atlantic-salmon-flesh",
  version: 1,
  kind: "aquatic-product",
  speciesRef: { id: salmon.id, version: salmon.version },
  productKind: "flesh",
  roles: ["aquatic-flesh"],
  names: { en: "Atlantic salmon flesh" },
  glossary: "A version-pinned culinary ingredient used only by authored recipes in this fixture.",
  baseContainsAllergens: ["fish"],
  baseMayContainAllergens: [],
  baseCrossContactTags: [],
  artKey: "atlantic-salmon-flesh-v1",
  reviewId,
});

const sashimiSlice = hashed<CutStyle>({
  id: "sashimi-slice",
  version: 1,
  names: { en: "Sashimi slice" },
  glossary: "A fixture-only authored cut identity; it is not real-world food-safety instruction.",
  compatibleProductKinds: ["flesh"],
  presentationClass: "broad-slice",
  reviewId,
});

const rawSalmonSlice = hashed<PreparedComponent>({
  id: "raw-atlantic-salmon-sashimi-slice",
  version: 1,
  ingredientRef: { id: salmonFlesh.id, version: salmonFlesh.version },
  cutStyleRef: { id: sashimiSlice.id, version: sashimiSlice.version },
  treatment: "raw",
  rawNotice: "required",
  containsAllergens: ["fish"],
  mayContainAllergens: [],
  crossContactTags: [],
  stationSteps: [
    { station: "prep-sashimi-board", action: "slice" },
    { station: "prep-sashimi-board", action: "arrange" },
    { station: "prep-sashimi-board", action: "plate" },
  ],
  artKey: "raw-atlantic-salmon-sashimi-slice-v1",
  reviewId,
});

const sashimiFamily = hashed<DishFamily>({
  id: "sashimi",
  version: 1,
  form: "sashimi",
  requiredRoles: ["topping"],
  allowedRoles: ["garnish", "topping"],
  noriPlacement: "none",
  namingRules: ["Name the exact aquatic ingredient; do not imply rice."],
  platingRules: ["Keep the rice-free silhouette legible without relying on color."],
  reviewId,
});

const salmonSashimi = hashed<DishDefinition>({
  id: "atlantic-salmon-sashimi",
  version: 1,
  familyRef: { id: sashimiFamily.id, version: sashimiFamily.version },
  names: { en: "Atlantic salmon sashimi" },
  glossary: "A rice-free, explicitly authored sashimi dish in the development fixture.",
  componentSlots: [{ role: "topping", componentRef: { id: rawSalmonSlice.id, version: rawSalmonSlice.version } }],
  containsAllergens: ["fish"],
  mayContainAllergens: [],
  crossContactTags: [],
  rawProfile: "notice-required",
  dietaryTags: [],
  presentationRules: ["Broad slices remain identifiable by outline and label."],
  nonColorIdentity: "Three broad slices arranged in a staggered fan.",
  artKey: "atlantic-salmon-sashimi-v1",
  reviewId,
});

const salmonSashimiRecipe = hashed<RecipeVersion>({
  id: "atlantic-salmon-sashimi",
  version: 1,
  dishRef: { id: salmonSashimi.id, version: salmonSashimi.version },
  exactComponentAmounts: [{
    componentRef: { id: rawSalmonSlice.id, version: rawSalmonSlice.version },
    quantity: "3",
    unit: "portion",
    role: "topping",
  }],
  stationSequence: [
    { station: "prep-sashimi-board", action: "slice" },
    { station: "prep-sashimi-board", action: "arrange" },
    { station: "prep-sashimi-board", action: "plate" },
  ],
  deterministicResult: { id: salmonSashimi.id, version: salmonSashimi.version },
  unlockRule: "first-service-settled",
  recovery: "retry-with-corrective-cue",
  seasonalityRuleRefs: [],
  status: "draft",
  reviewId,
});

const artAssets = [
  {
    key: "atlantic-salmon-flesh-v1",
    digest: contentHashFor({ key: "atlantic-salmon-flesh-v1", fixture: true }),
    nonColorIdentity: "A labeled broad salmon fillet silhouette.",
  },
  {
    key: "atlantic-salmon-sashimi-v1",
    digest: contentHashFor({ key: "atlantic-salmon-sashimi-v1", fixture: true }),
    nonColorIdentity: "Three broad slices arranged in a staggered fan.",
  },
  {
    key: "raw-atlantic-salmon-sashimi-slice-v1",
    digest: contentHashFor({ key: "raw-atlantic-salmon-sashimi-slice-v1", fixture: true }),
    nonColorIdentity: "A single broad sashimi slice with a clear cut edge.",
  },
] as const;

const pack = hashed<ContentPack>({
  id: "salmon-sashimi-draft",
  version: 1,
  schemaVersion: CONTENT_SCHEMA_VERSION,
  speciesRefs: [{ id: salmon.id, version: salmon.version }],
  ingredientRefs: [{ id: salmonFlesh.id, version: salmonFlesh.version }],
  cutStyleRefs: [{ id: sashimiSlice.id, version: sashimiSlice.version }],
  componentRefs: [{ id: rawSalmonSlice.id, version: rawSalmonSlice.version }],
  familyRefs: [{ id: sashimiFamily.id, version: sashimiFamily.version }],
  dishRefs: [{ id: salmonSashimi.id, version: salmonSashimi.version }],
  recipeRefs: [{ id: salmonSashimiRecipe.id, version: salmonSashimiRecipe.version }],
  variantRefs: [],
  seasonalityRuleRefs: [],
  contentManifestHash: contentManifestHashFor({
    species: [salmon],
    ingredients: [salmonFlesh],
    cutStyles: [sashimiSlice],
    components: [rawSalmonSlice],
    families: [sashimiFamily],
    dishes: [salmonSashimi],
    recipes: [salmonSashimiRecipe],
    variants: [],
    seasonalityRules: [],
  }),
  artAssetMapHash: contentHashFor(artAssets),
  archivePolicy: "append-only",
  reviewerSignoffs: [reviewId],
  reviewId,
});

/**
 * Structurally complete development data. `fixture-*` review references are
 * synthetic and MUST NOT be interpreted as named cultural/culinary approval.
 */
export const salmonSashimiDraftBundle: ContentBundle = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  pack,
  species: [salmon],
  ingredients: [salmonFlesh],
  cutStyles: [sashimiSlice],
  components: [rawSalmonSlice],
  families: [sashimiFamily],
  dishes: [salmonSashimi],
  recipes: [salmonSashimiRecipe],
  variants: [],
  seasonalityRules: [],
  artAssets,
  reviewReferences: [reviewId],
};
