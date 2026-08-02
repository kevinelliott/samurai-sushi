import { ContentValidationError, sortedIssues, type ContentIssue } from "./errors";
import type { ContentBundle } from "./model";

type UnknownRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "pack",
  "species",
  "ingredients",
  "cutStyles",
  "components",
  "families",
  "dishes",
  "recipes",
  "variants",
  "seasonalityRules",
  "artAssets",
  "reviewReferences",
] as const;

const ENTITY_FIELDS = ["id", "version", "contentHash", "reviewId"] as const;

const ROW_KEYS = {
  species: [...ENTITY_FIELDS, "scientificName", "localizedCommonNames", "marketNames", "group"],
  ingredients: [
    ...ENTITY_FIELDS,
    "kind",
    "speciesRef",
    "productKind",
    "roles",
    "names",
    "glossary",
    "baseContainsAllergens",
    "baseMayContainAllergens",
    "baseCrossContactTags",
    "artKey",
  ],
  cutStyles: [...ENTITY_FIELDS, "names", "glossary", "compatibleProductKinds", "presentationClass"],
  components: [
    ...ENTITY_FIELDS,
    "ingredientRef",
    "preparationInputs",
    "cutStyleRef",
    "treatment",
    "rawNotice",
    "containsAllergens",
    "mayContainAllergens",
    "crossContactTags",
    "stationSteps",
    "artKey",
  ],
  families: [
    ...ENTITY_FIELDS,
    "form",
    "requiredRoles",
    "allowedRoles",
    "noriPlacement",
    "namingRules",
    "platingRules",
  ],
  dishes: [
    ...ENTITY_FIELDS,
    "familyRef",
    "names",
    "glossary",
    "componentSlots",
    "containsAllergens",
    "mayContainAllergens",
    "crossContactTags",
    "rawProfile",
    "dietaryTags",
    "presentationRules",
    "nonColorIdentity",
    "artKey",
  ],
  recipes: [
    ...ENTITY_FIELDS,
    "dishRef",
    "exactComponentAmounts",
    "stationSequence",
    "deterministicResult",
    "unlockRule",
    "recovery",
    "seasonalityRuleRefs",
    "status",
  ],
  variants: [
    ...ENTITY_FIELDS,
    "baseRecipeRef",
    "substitutions",
    "resultingDishRef",
    "reason",
    "reviewIds",
    "status",
  ],
  seasonalityRules: [
    ...ENTITY_FIELDS,
    "subjectRef",
    "regionId",
    "ianaTimeZone",
    "calendar",
    "tzdbVersion",
    "windows",
    "sourceRef",
    "reviewedAt",
  ],
} as const;

const PACK_KEYS = [
  ...ENTITY_FIELDS,
  "schemaVersion",
  "speciesRefs",
  "ingredientRefs",
  "cutStyleRefs",
  "componentRefs",
  "familyRefs",
  "dishRefs",
  "recipeRefs",
  "variantRefs",
  "seasonalityRuleRefs",
  "contentManifestHash",
  "artAssetMapHash",
  "archivePolicy",
  "reviewerSignoffs",
] as const;

function issue(issues: ContentIssue[], path: string, message: string): void {
  issues.push({ code: "INVALID_CONTENT_SHAPE", path, message });
}

function record(value: unknown, path: string, issues: ContentIssue[]): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    issue(issues, path, "Expected a plain object.");
    return undefined;
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: ContentIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${path}.${key}`, "Unknown field.");
  }
  for (const key of required) {
    if (!(key in value)) issue(issues, `${path}.${key}`, "Required field is missing.");
  }
}

function nonEmptyString(value: unknown, path: string, issues: ContentIssue[]): void {
  if (typeof value !== "string" || value.trim() === "") issue(issues, path, "Expected a non-empty string.");
}

function enumValue(value: unknown, allowed: readonly string[], path: string, issues: ContentIssue[]): void {
  nonEmptyString(value, path, issues);
  if (typeof value === "string" && !allowed.includes(value)) issue(issues, path, `Expected one of: ${allowed.join(", ")}.`);
}

function enumArray(value: unknown, allowed: readonly string[], path: string, issues: ContentIssue[], allowEmpty = true): void {
  stringArray(value, path, issues, allowEmpty);
  if (Array.isArray(value)) value.forEach((entry, index) => enumValue(entry, allowed, `${path}[${index}]`, issues));
}

function stringArray(value: unknown, path: string, issues: ContentIssue[], allowEmpty = true): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "Expected an array.");
    return;
  }
  if (!allowEmpty && value.length === 0) issue(issues, path, "Expected at least one entry.");
  value.forEach((entry, index) => nonEmptyString(entry, `${path}[${index}]`, issues));
}

function names(value: unknown, path: string, issues: ContentIssue[]): void {
  const item = record(value, path, issues);
  if (!item) return;
  if (Object.keys(item).length === 0) issue(issues, path, "Expected at least one localized name.");
  for (const [locale, label] of Object.entries(item)) {
    nonEmptyString(locale, `${path}.${locale}`, issues);
    nonEmptyString(label, `${path}.${locale}`, issues);
  }
}

function ref(value: unknown, path: string, issues: ContentIssue[], tagged = false): void {
  const item = record(value, path, issues);
  if (!item) return;
  exactKeys(item, tagged ? ["kind", "id", "version"] : ["id", "version"], tagged ? ["kind", "id", "version"] : ["id", "version"], path, issues);
  nonEmptyString(item.id, `${path}.id`, issues);
  if (!Number.isSafeInteger(item.version) || (item.version as number) <= 0) issue(issues, `${path}.version`, "Expected a positive safe integer.");
  if (tagged) nonEmptyString(item.kind, `${path}.kind`, issues);
}

function refArray(value: unknown, path: string, issues: ContentIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "Expected an array.");
    return;
  }
  value.forEach((entry, index) => ref(entry, `${path}[${index}]`, issues));
}

function stationSteps(value: unknown, path: string, issues: ContentIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "Expected an array.");
    return;
  }
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath, issues);
    if (!item) return;
    exactKeys(item, ["station", "action"], ["station", "action"], itemPath, issues);
    enumValue(item.station, ["rice-hearth", "prep-sashimi-board", "rolling-mat", "nigiri-counter", "tea-flame"], `${itemPath}.station`, issues);
    enumValue(item.action, ["arrange", "bind", "brush", "cook", "cut", "fill", "fold", "layer", "plate", "portion", "press", "roll", "score", "sear", "season", "slice", "steam", "wash", "wrap"], `${itemPath}.action`, issues);
  });
}

function baseEntity(item: UnknownRecord, path: string, issues: ContentIssue[]): void {
  nonEmptyString(item.id, `${path}.id`, issues);
  if (!Number.isSafeInteger(item.version) || (item.version as number) <= 0) issue(issues, `${path}.version`, "Expected a positive safe integer.");
  nonEmptyString(item.contentHash, `${path}.contentHash`, issues);
  nonEmptyString(item.reviewId, `${path}.reviewId`, issues);
}

function decodeRows(bundle: UnknownRecord, key: keyof typeof ROW_KEYS, issues: ContentIssue[]): void {
  const rows = bundle[key];
  if (!Array.isArray(rows)) {
    issue(issues, `$.${key}`, "Expected an array.");
    return;
  }
  rows.forEach((entry, index) => {
    const path = `$.${key}[${index}]`;
    const item = record(entry, path, issues);
    if (!item) return;
    const allowed = ROW_KEYS[key];
    const optional = key === "ingredients" ? ["speciesRef", "productKind"] : key === "components" ? ["cutStyleRef", "preparationInputs"] : [];
    const required = allowed.filter((field) => !optional.includes(field));
    exactKeys(item, allowed, required, path, issues);
    baseEntity(item, path, issues);

    switch (key) {
      case "species":
        nonEmptyString(item.scientificName, `${path}.scientificName`, issues);
        names(item.localizedCommonNames, `${path}.localizedCommonNames`, issues);
        stringArray(item.marketNames, `${path}.marketNames`, issues);
        enumValue(item.group, ["finfish", "crustacean", "mollusk", "other-aquatic"], `${path}.group`, issues);
        break;
      case "ingredients":
        enumValue(item.kind, ["staple", "produce", "egg", "aquatic-product", "condiment"], `${path}.kind`, issues);
        if (item.speciesRef !== undefined) ref(item.speciesRef, `${path}.speciesRef`, issues);
        if (item.productKind !== undefined) enumValue(item.productKind, ["flesh", "roe", "shellfish", "other"], `${path}.productKind`, issues);
        enumArray(item.roles, ["aquatic-flesh", "egg", "nori", "produce", "roe", "seasoning", "sushi-rice"], `${path}.roles`, issues, false);
        names(item.names, `${path}.names`, issues);
        nonEmptyString(item.glossary, `${path}.glossary`, issues);
        enumArray(item.baseContainsAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.baseContainsAllergens`, issues);
        enumArray(item.baseMayContainAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.baseMayContainAllergens`, issues);
        stringArray(item.baseCrossContactTags, `${path}.baseCrossContactTags`, issues);
        nonEmptyString(item.artKey, `${path}.artKey`, issues);
        break;
      case "cutStyles":
        names(item.names, `${path}.names`, issues);
        nonEmptyString(item.glossary, `${path}.glossary`, issues);
        enumArray(item.compatibleProductKinds, ["flesh", "roe", "shellfish", "other"], `${path}.compatibleProductKinds`, issues, false);
        nonEmptyString(item.presentationClass, `${path}.presentationClass`, issues);
        break;
      case "components":
        ref(item.ingredientRef, `${path}.ingredientRef`, issues);
        if (item.preparationInputs !== undefined) {
          if (!Array.isArray(item.preparationInputs)) issue(issues, `${path}.preparationInputs`, "Expected an array.");
          else item.preparationInputs.forEach((input, inputIndex) => {
            const inputPath = `${path}.preparationInputs[${inputIndex}]`;
            const inputRecord = record(input, inputPath, issues);
            if (!inputRecord) return;
            exactKeys(inputRecord, ["ingredientRef", "stationStep"], ["ingredientRef", "stationStep"], inputPath, issues);
            ref(inputRecord.ingredientRef, `${inputPath}.ingredientRef`, issues);
            stationSteps([inputRecord.stationStep], `${inputPath}.stationStep`, issues);
          });
        }
        if (item.cutStyleRef !== undefined) ref(item.cutStyleRef, `${path}.cutStyleRef`, issues);
        enumValue(item.treatment, ["raw", "cooked", "cured", "smoked", "surface-seared", "seasoned", "plant"], `${path}.treatment`, issues);
        enumValue(item.rawNotice, ["none", "required"], `${path}.rawNotice`, issues);
        enumArray(item.containsAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.containsAllergens`, issues);
        enumArray(item.mayContainAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.mayContainAllergens`, issues);
        stringArray(item.crossContactTags, `${path}.crossContactTags`, issues);
        stationSteps(item.stationSteps, `${path}.stationSteps`, issues);
        nonEmptyString(item.artKey, `${path}.artKey`, issues);
        break;
      case "families":
        enumValue(item.form, ["sashimi", "nigiri", "gunkan", "hosomaki", "futomaki", "uramaki", "temaki"], `${path}.form`, issues);
        enumArray(item.requiredRoles, ["binding", "filling", "garnish", "rice", "topping", "wrapper"], `${path}.requiredRoles`, issues);
        enumArray(item.allowedRoles, ["binding", "filling", "garnish", "rice", "topping", "wrapper"], `${path}.allowedRoles`, issues, false);
        enumValue(item.noriPlacement, ["none", "outer-wrapper", "inner-layer", "rice-wrapper"], `${path}.noriPlacement`, issues);
        stringArray(item.namingRules, `${path}.namingRules`, issues, false);
        stringArray(item.platingRules, `${path}.platingRules`, issues, false);
        break;
      case "dishes":
        ref(item.familyRef, `${path}.familyRef`, issues);
        names(item.names, `${path}.names`, issues);
        nonEmptyString(item.glossary, `${path}.glossary`, issues);
        if (!Array.isArray(item.componentSlots)) issue(issues, `${path}.componentSlots`, "Expected an array.");
        else item.componentSlots.forEach((slot, slotIndex) => {
          const slotPath = `${path}.componentSlots[${slotIndex}]`;
          const slotRecord = record(slot, slotPath, issues);
          if (!slotRecord) return;
          exactKeys(slotRecord, ["role", "componentRef", "noriPlacement"], ["role", "componentRef"], slotPath, issues);
          enumValue(slotRecord.role, ["binding", "filling", "garnish", "rice", "topping", "wrapper"], `${slotPath}.role`, issues);
          ref(slotRecord.componentRef, `${slotPath}.componentRef`, issues);
          if (slotRecord.noriPlacement !== undefined) enumValue(slotRecord.noriPlacement, ["outer-wrapper", "inner-layer", "rice-wrapper"], `${slotPath}.noriPlacement`, issues);
        });
        enumArray(item.containsAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.containsAllergens`, issues);
        enumArray(item.mayContainAllergens, ["egg", "fish", "mollusk", "crustacean", "sesame", "soy", "wheat-gluten"], `${path}.mayContainAllergens`, issues);
        stringArray(item.crossContactTags, `${path}.crossContactTags`, issues);
        enumValue(item.rawProfile, ["none", "notice-required"], `${path}.rawProfile`, issues);
        stringArray(item.dietaryTags, `${path}.dietaryTags`, issues);
        stringArray(item.presentationRules, `${path}.presentationRules`, issues, false);
        nonEmptyString(item.nonColorIdentity, `${path}.nonColorIdentity`, issues);
        nonEmptyString(item.artKey, `${path}.artKey`, issues);
        break;
      case "recipes":
        ref(item.dishRef, `${path}.dishRef`, issues);
        if (!Array.isArray(item.exactComponentAmounts)) issue(issues, `${path}.exactComponentAmounts`, "Expected an array.");
        else item.exactComponentAmounts.forEach((amount, amountIndex) => {
          const amountPath = `${path}.exactComponentAmounts[${amountIndex}]`;
          const amountRecord = record(amount, amountPath, issues);
          if (!amountRecord) return;
          exactKeys(amountRecord, ["componentRef", "quantity", "unit", "role"], ["componentRef", "quantity", "unit", "role"], amountPath, issues);
          ref(amountRecord.componentRef, `${amountPath}.componentRef`, issues);
          nonEmptyString(amountRecord.quantity, `${amountPath}.quantity`, issues);
          enumValue(amountRecord.unit, ["portion"], `${amountPath}.unit`, issues);
          enumValue(amountRecord.role, ["binding", "filling", "garnish", "rice", "topping", "wrapper"], `${amountPath}.role`, issues);
        });
        stationSteps(item.stationSequence, `${path}.stationSequence`, issues);
        ref(item.deterministicResult, `${path}.deterministicResult`, issues);
        enumValue(item.unlockRule, ["available-at-start", "first-service-settled"], `${path}.unlockRule`, issues);
        enumValue(item.recovery, ["retry-with-corrective-cue", "staff-meal", "return-components"], `${path}.recovery`, issues);
        refArray(item.seasonalityRuleRefs, `${path}.seasonalityRuleRefs`, issues);
        enumValue(item.status, ["draft", "published", "retired"], `${path}.status`, issues);
        break;
      case "variants":
        ref(item.baseRecipeRef, `${path}.baseRecipeRef`, issues);
        if (!Array.isArray(item.substitutions)) issue(issues, `${path}.substitutions`, "Expected an array.");
        else item.substitutions.forEach((substitution, substitutionIndex) => {
          const substitutionPath = `${path}.substitutions[${substitutionIndex}]`;
          const substitutionRecord = record(substitution, substitutionPath, issues);
          if (!substitutionRecord) return;
          exactKeys(substitutionRecord, ["from", "to"], ["from", "to"], substitutionPath, issues);
          ref(substitutionRecord.from, `${substitutionPath}.from`, issues);
          ref(substitutionRecord.to, `${substitutionPath}.to`, issues);
        });
        ref(item.resultingDishRef, `${path}.resultingDishRef`, issues);
        enumValue(item.reason, ["species", "cut", "treatment", "presentation"], `${path}.reason`, issues);
        stringArray(item.reviewIds, `${path}.reviewIds`, issues, false);
        enumValue(item.status, ["draft", "published", "retired"], `${path}.status`, issues);
        break;
      case "seasonalityRules":
        ref(item.subjectRef, `${path}.subjectRef`, issues, true);
        nonEmptyString(item.regionId, `${path}.regionId`, issues);
        nonEmptyString(item.ianaTimeZone, `${path}.ianaTimeZone`, issues);
        enumValue((item.subjectRef as UnknownRecord | undefined)?.kind, ["ingredient", "component", "dish", "recipe"], `${path}.subjectRef.kind`, issues);
        enumValue(item.calendar, ["iso8601-gregorian"], `${path}.calendar`, issues);
        nonEmptyString(item.tzdbVersion, `${path}.tzdbVersion`, issues);
        if (!Array.isArray(item.windows)) issue(issues, `${path}.windows`, "Expected an array.");
        else item.windows.forEach((window, windowIndex) => {
          const windowPath = `${path}.windows[${windowIndex}]`;
          const windowRecord = record(window, windowPath, issues);
          if (!windowRecord) return;
          exactKeys(windowRecord, ["startLocalDateInclusive", "endLocalDateExclusive", "availability"], ["startLocalDateInclusive", "endLocalDateExclusive", "availability"], windowPath, issues);
          nonEmptyString(windowRecord.startLocalDateInclusive, `${windowPath}.startLocalDateInclusive`, issues);
          nonEmptyString(windowRecord.endLocalDateExclusive, `${windowPath}.endLocalDateExclusive`, issues);
          enumValue(windowRecord.availability, ["available", "limited", "unavailable"], `${windowPath}.availability`, issues);
        });
        nonEmptyString(item.sourceRef, `${path}.sourceRef`, issues);
        nonEmptyString(item.reviewedAt, `${path}.reviewedAt`, issues);
        break;
    }
  });
}

export function decodeContentBundle(input: unknown): ContentBundle {
  const issues: ContentIssue[] = [];
  const bundle = record(input, "$", issues);
  if (!bundle) throw new ContentValidationError(sortedIssues(issues));
  exactKeys(bundle, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS, "$", issues);
  if (bundle.schemaVersion !== 1) issue(issues, "$.schemaVersion", "Only content schema version 1 is supported.");

  const pack = record(bundle.pack, "$.pack", issues);
  if (pack) {
    exactKeys(pack, PACK_KEYS, PACK_KEYS, "$.pack", issues);
    baseEntity(pack, "$.pack", issues);
    if (pack.schemaVersion !== 1) issue(issues, "$.pack.schemaVersion", "Only content schema version 1 is supported.");
    for (const key of ["speciesRefs", "ingredientRefs", "cutStyleRefs", "componentRefs", "familyRefs", "dishRefs", "recipeRefs", "variantRefs", "seasonalityRuleRefs"] as const) {
      refArray(pack[key], `$.pack.${key}`, issues);
    }
    nonEmptyString(pack.contentManifestHash, "$.pack.contentManifestHash", issues);
    nonEmptyString(pack.artAssetMapHash, "$.pack.artAssetMapHash", issues);
    enumValue(pack.archivePolicy, ["append-only"], "$.pack.archivePolicy", issues);
    stringArray(pack.reviewerSignoffs, "$.pack.reviewerSignoffs", issues, false);
  }

  for (const key of Object.keys(ROW_KEYS) as (keyof typeof ROW_KEYS)[]) decodeRows(bundle, key, issues);

  if (!Array.isArray(bundle.artAssets)) issue(issues, "$.artAssets", "Expected an array.");
  else bundle.artAssets.forEach((asset, index) => {
    const path = `$.artAssets[${index}]`;
    const item = record(asset, path, issues);
    if (!item) return;
    exactKeys(item, ["key", "digest", "nonColorIdentity"], ["key", "digest", "nonColorIdentity"], path, issues);
    nonEmptyString(item.key, `${path}.key`, issues);
    nonEmptyString(item.digest, `${path}.digest`, issues);
    nonEmptyString(item.nonColorIdentity, `${path}.nonColorIdentity`, issues);
  });
  stringArray(bundle.reviewReferences, "$.reviewReferences", issues, false);

  if (issues.length > 0) throw new ContentValidationError(sortedIssues(issues));
  return input as ContentBundle;
}
