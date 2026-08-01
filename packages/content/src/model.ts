export const CONTENT_SCHEMA_VERSION = 1 as const;

export interface VersionedRef {
  readonly id: string;
  readonly version: number;
}

export interface VersionedEntity extends VersionedRef {
  readonly contentHash: string;
  readonly reviewId: string;
}

export type Allergen =
  | "egg"
  | "fish"
  | "mollusk"
  | "crustacean"
  | "sesame"
  | "soy"
  | "wheat-gluten";

export type ProductKind = "flesh" | "roe" | "shellfish" | "other";
export type IngredientRole =
  | "aquatic-flesh"
  | "egg"
  | "nori"
  | "produce"
  | "roe"
  | "seasoning"
  | "sushi-rice";

export type ComponentRole = "binding" | "filling" | "garnish" | "rice" | "topping" | "wrapper";
export type DishForm = "sashimi" | "nigiri" | "gunkan" | "hosomaki" | "futomaki" | "uramaki" | "temaki";
export type NoriPlacement = "none" | "outer-wrapper" | "inner-layer" | "rice-wrapper";
export type StationId = "rice-hearth" | "prep-sashimi-board" | "rolling-mat" | "nigiri-counter" | "tea-flame";
export type StationAction =
  | "arrange"
  | "bind"
  | "brush"
  | "cook"
  | "cut"
  | "fill"
  | "fold"
  | "layer"
  | "plate"
  | "portion"
  | "press"
  | "roll"
  | "score"
  | "sear"
  | "season"
  | "slice"
  | "steam"
  | "wash"
  | "wrap";

export interface StationStep {
  readonly station: StationId;
  readonly action: StationAction;
}

export interface SpeciesDefinition extends VersionedEntity {
  readonly scientificName: string;
  readonly localizedCommonNames: Readonly<Record<string, string>>;
  readonly marketNames: readonly string[];
  readonly group: "finfish" | "crustacean" | "mollusk" | "other-aquatic";
}

export interface IngredientDefinition extends VersionedEntity {
  readonly kind: "staple" | "produce" | "egg" | "aquatic-product" | "condiment";
  readonly speciesRef?: VersionedRef;
  readonly productKind?: ProductKind;
  readonly roles: readonly IngredientRole[];
  readonly names: Readonly<Record<string, string>>;
  readonly glossary: string;
  readonly baseContainsAllergens: readonly Allergen[];
  readonly baseMayContainAllergens: readonly Allergen[];
  readonly baseCrossContactTags: readonly string[];
  readonly artKey: string;
}

export interface CutStyle extends VersionedEntity {
  readonly names: Readonly<Record<string, string>>;
  readonly glossary: string;
  readonly compatibleProductKinds: readonly ProductKind[];
  readonly presentationClass: string;
}

export type Treatment = "raw" | "cooked" | "cured" | "smoked" | "surface-seared" | "seasoned" | "plant";

export interface PreparedComponent extends VersionedEntity {
  readonly ingredientRef: VersionedRef;
  readonly cutStyleRef?: VersionedRef;
  readonly treatment: Treatment;
  readonly rawNotice: "none" | "required";
  readonly containsAllergens: readonly Allergen[];
  readonly mayContainAllergens: readonly Allergen[];
  readonly crossContactTags: readonly string[];
  readonly stationSteps: readonly StationStep[];
  readonly artKey: string;
}

export interface DishFamily extends VersionedEntity {
  readonly form: DishForm;
  readonly requiredRoles: readonly ComponentRole[];
  readonly allowedRoles: readonly ComponentRole[];
  readonly noriPlacement: NoriPlacement;
  readonly namingRules: readonly string[];
  readonly platingRules: readonly string[];
}

export interface ComponentSlot {
  readonly role: ComponentRole;
  readonly componentRef: VersionedRef;
}

export interface DishDefinition extends VersionedEntity {
  readonly familyRef: VersionedRef;
  readonly names: Readonly<Record<string, string>>;
  readonly glossary: string;
  readonly componentSlots: readonly ComponentSlot[];
  readonly containsAllergens: readonly Allergen[];
  readonly mayContainAllergens: readonly Allergen[];
  readonly crossContactTags: readonly string[];
  readonly rawProfile: "none" | "notice-required";
  readonly dietaryTags: readonly string[];
  readonly presentationRules: readonly string[];
  readonly nonColorIdentity: string;
  readonly artKey: string;
}

export interface ComponentAmount {
  readonly componentRef: VersionedRef;
  readonly quantity: string;
  readonly unit: "portion";
  readonly role: ComponentRole;
}

export interface RecipeVersion extends VersionedEntity {
  readonly dishRef: VersionedRef;
  readonly exactComponentAmounts: readonly ComponentAmount[];
  readonly stationSequence: readonly StationStep[];
  readonly deterministicResult: string;
  readonly unlockRule: string;
  readonly recovery: string;
  readonly seasonalityRuleRefs: readonly VersionedRef[];
  readonly status: "draft" | "published" | "retired";
}

export interface RecipeSubstitution {
  readonly from: VersionedRef;
  readonly to: VersionedRef;
}

export interface RecipeVariant extends VersionedEntity {
  readonly baseRecipeRef: VersionedRef;
  readonly substitutions: readonly RecipeSubstitution[];
  readonly resultingDishRef: VersionedRef;
  readonly reason: "species" | "cut" | "treatment" | "presentation";
  readonly reviewIds: readonly string[];
  readonly status: "draft" | "published" | "retired";
}

export type SeasonAvailability = "available" | "limited" | "unavailable";

export interface SeasonWindow {
  readonly startLocalDateInclusive: string;
  readonly endLocalDateExclusive: string;
  readonly availability: SeasonAvailability;
}

export type SeasonalSubjectKind = "ingredient" | "component" | "dish" | "recipe";

export interface SeasonalSubjectRef extends VersionedRef {
  readonly kind: SeasonalSubjectKind;
}

export interface SeasonalityRule extends VersionedEntity {
  readonly subjectRef: SeasonalSubjectRef;
  readonly regionId: string;
  readonly ianaTimeZone: string;
  readonly calendar: "iso8601-gregorian";
  readonly tzdbVersion: string;
  readonly windows: readonly SeasonWindow[];
  readonly sourceRef: string;
  readonly reviewedAt: string;
}

export interface ContentPack extends VersionedEntity {
  readonly schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  readonly speciesRefs: readonly VersionedRef[];
  readonly ingredientRefs: readonly VersionedRef[];
  readonly cutStyleRefs: readonly VersionedRef[];
  readonly componentRefs: readonly VersionedRef[];
  readonly familyRefs: readonly VersionedRef[];
  readonly dishRefs: readonly VersionedRef[];
  readonly recipeRefs: readonly VersionedRef[];
  readonly variantRefs: readonly VersionedRef[];
  readonly seasonalityRuleRefs: readonly VersionedRef[];
  readonly artAssetDigests: readonly string[];
  readonly archivePolicy: "append-only";
  readonly reviewerSignoffs: readonly string[];
}

export interface ArtAsset {
  readonly key: string;
  readonly digest: string;
  readonly nonColorIdentity: string;
}

export interface ContentBundle {
  readonly schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  readonly pack: ContentPack;
  readonly species: readonly SpeciesDefinition[];
  readonly ingredients: readonly IngredientDefinition[];
  readonly cutStyles: readonly CutStyle[];
  readonly components: readonly PreparedComponent[];
  readonly families: readonly DishFamily[];
  readonly dishes: readonly DishDefinition[];
  readonly recipes: readonly RecipeVersion[];
  readonly variants: readonly RecipeVariant[];
  readonly seasonalityRules: readonly SeasonalityRule[];
  readonly artAssets: readonly ArtAsset[];
  /** Structural references only. They are not proof of cultural approval. */
  readonly reviewReferences: readonly string[];
}

export type ContentKind =
  | "species"
  | "ingredient"
  | "cut-style"
  | "component"
  | "family"
  | "dish"
  | "recipe"
  | "variant"
  | "seasonality-rule"
  | "pack";

export interface DishFacts {
  readonly containsAllergens: readonly Allergen[];
  readonly mayContainAllergens: readonly Allergen[];
  readonly crossContactTags: readonly string[];
  readonly rawProfile: "none" | "notice-required";
}

export interface CompiledContentPack {
  readonly bundle: ContentBundle;
  readonly indexes: Readonly<Record<Exclude<ContentKind, "pack">, ReadonlyMap<string, VersionedEntity>>>;
  readonly dishFacts: ReadonlyMap<string, DishFacts>;
}

export type SeasonalityResult = SeasonAvailability | "unspecified";
