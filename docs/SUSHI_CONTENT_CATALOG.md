# Sushi Content Catalog

## 1. Purpose

Samurai Sushi supports a broad, data-authored sushi menu without making the
first service carry the whole catalog. Sashimi is a first-class dish family,
not a nigiri variant with the rice hidden. Fish, shellfish, mollusks, roe, cuts,
preparations, and dish forms have separate canonical identities so content can
grow without name-based substitutions or combinatorial recipes.

This is a product-content taxonomy, not real-world food-safety instruction.
Every animal-derived raw-service item, culinary term, sourcing claim, and dish
construction requires named culinary review and the applicable jurisdictional
food-safety review before public release.

## 2. Supported dish families

| Family | Product rule | Representative forms |
| --- | --- | --- |
| Sashimi | sliced seafood served without sushi rice; cut, portion, service state, garnish, and plating are explicit | single-item sashimi, paired tasting, moriawase assortment |
| Nigiri | formed sushi rice with a reviewed topping and optional binding/finish | salmon, tuna, yellowtail, sea bream, tamago, shrimp |
| Gunkan | rice wrapped with nori to hold a loose topping | ikura, tobiko, reviewed chopped-fish mixtures |
| Hosomaki | thin roll with a small, legible filling set | kappa, tekka, kanpyo, oshinko, salmon |
| Futomaki | thicker authored roll with several disclosed fillings | reviewed vegetable, tamago, and seafood combinations |
| Uramaki | rice-outside roll with authored coating and filling | salmon-avocado, cucumber-avocado, reviewed contemporary rolls |
| Temaki | hand roll assembled to order | salmon-cucumber, tuna-scallion, ikura |
| Composed | bowl, assortment, pocket, or closing dish with a fixed authored composition | chirashi, sashimi moriawase, inari sushi, ochazuke |

“Roll” is not one recipe generator. Each hosomaki, futomaki, uramaki, or temaki
is an authored, versioned dish with exact ingredients, station sequence,
allergen/dietary derivation, recovery result, art, and review record.

## 3. Ingredient breadth

The content system MUST be able to represent these reviewed candidate groups;
listing a candidate does not approve sourcing, raw service, availability, or a
token identity.

### Finfish and cuts

- salmon;
- tuna with explicit cut/grade variants such as akami, chutoro, and otoro;
- yellowtail/amberjack with season-appropriate naming reviewed in context;
- sea bream;
- mackerel;
- horse mackerel;
- sardine;
- cooked eel preparations.

### Shellfish and mollusks

- shrimp;
- scallop;
- squid;
- octopus.

### Roe

- ikura (salmon roe);
- tobiko (flying-fish roe);
- masago (capelin roe);
- kazunoko (herring roe).

Roe species, product form, color treatment, seasoning, and serving form remain
separate fields. Uni is not roe and MUST be modeled independently if later
added. Display names never collapse biologically or culinarily distinct items.

### Plant, egg, and pantry support

Rice, vinegar, nori, cucumber, avocado, scallion, kanpyo, oshinko, daikon,
ginger, wasabi, sesame, tamago, inari tofu, soy-based finishes, and tea support
seafood-free dishes and complete authored recipes. Dietary and allergen claims
derive from exact ingredient composition rather than the dish name.

## 4. Delivery tiers

### MVP content library

The required first service remains three orders: kappa maki, tamago nigiri, and
salmon nigiri. Settling that service immediately unlocks **salmon sashimi** as a
fourth MVP dish and teaches that sashimi uses no sushi rice. This adds a real
sashimi path without weakening the three-order usability experiment.

### Alpha catalog — 12 total dishes

Retain the onboarding three, then add:

- sashimi: salmon, tuna akami, and yellowtail;
- nigiri/gunkan: tuna nigiri, cooked shrimp nigiri, and ikura gunkan;
- rolls: tekka hosomaki, one reviewed vegetable/tamago futomaki, and
  salmon-avocado uramaki.

Alpha therefore proves real sashimi, distinct roe/gunkan, and hosomaki,
futomaki, and uramaki construction without lengthening the first service.

### Public-launch catalog — 24 total dishes

Add twelve reviewed dishes:

- sashimi/seared plates: sea-bream sashimi, scallop sashimi, and katsuo tataki;
- nigiri/cooked sushi: yellowtail nigiri, scallop nigiri, cooked eel nigiri,
  and inari sushi;
- roe gunkan: tobiko and masago;
- rolls: negitoro temaki, oshinko hosomaki, and a clearly labeled
  modern/international-style rainbow uramaki.

This target supports at least eight seafood identities, three distinct roe
products, four roll structures, and meaningful cooked/plant-forward choices.
It is a coverage floor, not permission to ship an item lacking art,
accessibility, sourcing, culinary, cultural, or performance evidence.

### Post-launch catalog — 40+ dishes

Expand through small named packs into silver/oily fish and cured preparations,
white fish and texture, advanced shellfish, additional roe/soft toppings, more
roll forms, and cooked/plant-forward recipes. New rows ship in versioned packs;
they do not silently mutate live recipes or availability.

## 5. Progression and menu composition

- Rice mastery unlocks nigiri, rolls, gunkan, and composed rice dishes.
- Knife & Form branches into sashimi cuts, nigiri toppings, roll forms, and
  assortment composition.
- Hospitality unlocks guest-specific substitutions only when an authored,
  reviewed recipe permits them.
- Season mastery changes visible menu availability and story context; it never
  implies that a species is sustainably or safely sourced without evidence.
- A service menu remains small—normally three to five choices—even when the
  cookbook is large. Forecasting, guest preference, and station capacity drive
  selection rather than scrolling through the full catalog during service.

No procedural “choose any fish + any form” generator ships. Recipe families may
share templates for authoring and validation, but every playable result has a
stable reviewed dish ID and version.

## 6. Canonical content model

```text
SpeciesDefinition {
  id, version, contentHash, scientificName, localizedCommonNames,
  marketNames, group, reviewId
}
IngredientDefinition {
  id, version, contentHash, kind, speciesRef?,
  productKind?: flesh|roe|shellfish|other, roles, names, glossary,
  baseContainsAllergens, baseMayContainAllergens, baseCrossContactTags,
  artKey, reviewId
}
CutStyle {
  id, version, contentHash, names, glossary, compatibleProductKinds,
  presentationClass, reviewId
}
PreparedComponent {
  id, version, contentHash, ingredientRef, cutStyleRef?,
  treatment: raw|cooked|cured|smoked|surface-seared|seasoned|plant,
  rawNotice, containsAllergens, mayContainAllergens,
  crossContactTags, stationSteps, artKey, reviewId
}
DishFamily {
  id, version, contentHash, form, requiredRoles, allowedRoles,
  noriPlacement, namingRules, platingRules, reviewId
}
DishDefinition {
  id, version, contentHash, familyRef, names, glossary,
  componentSlots:{role,componentRef,noriPlacement?},
  containsAllergens, mayContainAllergens, crossContactTags, rawProfile,
  dietaryTags, presentationRules, nonColorIdentity, artKey, reviewId
}
RecipeVersion {
  id, version, dishRef, exactComponentAmounts:{componentRef,quantity,unit,role},
  stationSequence, deterministicResult:VersionedRef,
  unlockRule: available-at-start|first-service-settled,
  recovery: retry-with-corrective-cue|staff-meal|return-components,
  seasonalityRuleRefs, contentHash, reviewId, status
}
RecipeVariant {
  id, version, contentHash, reviewId, baseRecipeRef, substitutions,
  resultingDishRef, reason, reviewIds, status
}
SeasonWindow {
  startLocalDateInclusive, endLocalDateExclusive,
  availability: available|limited|unavailable
}
SeasonalityRule {
  id, version, contentHash, reviewId, subjectRef:{kind,id,version},
  regionId, ianaTimeZone, calendar: iso8601-gregorian,
  tzdbVersion, windows:[SeasonWindow],
  sourceRef, reviewedAt
}
ProvenanceProfile {
  id, version, contentHash, semanticSubjectRef, claimType, claimValue,
  evidenceRef, validFrom?, validUntil?, reviewStatus
}
AssetBinding {
  bindingId, version, semanticSubjectRef, assetRef,
  use: recognition|escrow|consumption, policyVersion, manifestHash,
  enabledFrom?, disabledAt?, reviewIds, enabled
}
ContentPack {
  id, version, contentHash, reviewId, schemaVersion, speciesRefs,
  ingredientRefs, cutStyleRefs, componentRefs, familyRefs, dishRefs,
  recipeRefs, variantRefs, seasonalityRuleRefs, contentManifestHash,
  artAssetMapHash, archivePolicy, reviewerSignoffs
}
```

Commercial/display names are labels, not identity. Species, culinary product,
prepared component, dish, recipe, provenance claim, and asset binding remain
distinct, versioned, and append-only once published. Every transitive reference
is `{id, version}`; editing content creates a new version and hash rather than
reinterpreting historical orders. `contentManifestHash` binds every supplied
row key to its exact row hash, and `artAssetMapHash` binds every art key to its
digest and non-color identity. Game-content identity also does not authorize an
onchain asset:
foreign compatibility still requires the
full chain/contract/token registry defined in
[`ECONOMY_AND_INTEROPERABILITY.md`](ECONOMY_AND_INTEROPERABILITY.md).

## 7. Validation invariants

1. Sashimi recipes contain no sushi-rice component.
2. Gunkan and roll subtypes declare nori placement on the family and the exact
   nori wrapper slot; the two placements must agree.
3. Every aquatic ingredient references exactly one reviewed species; every roe
   ingredient declares `productKind = roe` and its source species.
4. Every recipe input references a `PreparedComponent`, never a species,
   free-form tag, display name, or asset.
5. Every animal-derived prepared component declares treatment and raw-food
   notice policy; omission fails validation rather than defaulting to allowed.
6. Every dish’s `containsAllergens`, `mayContainAllergens`, and
   `crossContactTags` are derived independently as monotonic unions from its
   exact component versions. A contained allergen cannot be removed or
   downgraded to may-contain/cross-contact.
7. A roe ingredient names its source species and product form; color or display
   name cannot substitute for identity.
8. Species, cut, preparation, and ingredient substitutions are opt-in authored
   variants, never automatic fuzzy matches.
9. Variant expansion is finite, acyclic, duplicate-free, and points to a
   concrete resulting dish; runtime wildcards such as “any fish” are invalid.
10. Every playable dish has a glossary, station sequence, exact pinned dish
    result, closed unlock and recovery outcomes, non-color visual identity, and
    required reviewer signoff. Schema v1 rejects non-empty dietary claims until
    they can be derived rather than asserted.
11. Every sprite depicts the actual component roles; garnish cannot imply an
   ingredient absent from the recipe.
12. Every recipe and order pins all transitive `{id, version}` references.
   Updating a component cannot change historical allergens, raw notice,
   recovery, art, or content hash.
13. Content-pack activation is atomic and version-pinned; the content manifest
   binds every row to its hash and the art map binds key, digest, and non-color
   identity. Broken references, duplicate IDs, missing art, or missing review
   reject the whole pack.
14. Seasonality uses ISO-8601 local dates in a pinned IANA zone/tzdb version and
   half-open `[start, end)` windows. The service pins its derived local date at
   open. Exact subject-version and region rules only; no match means valid
   `unspecified`. Activation also requires the pinned tzdb version to match the
   compiler runtime. Historical replay validates the archived `YYYYx` pin but
   does not re-activate it against a newer host tzdb. Invalid windows, unknown
   zones, or overlapping contradictory availability produce
   `SEASONALITY_UNRESOLVED` and reject the pack.
15. Only the manifest-verified `AssetBinding` registry can authorize
   recognition, escrow, or consumption. A projection disagreement fails closed.
16. No content term, species name, or culinary equivalence authorizes foreign
    token use.

## 8. Experience requirements

Stores and Recipes filter by dish family, ingredient class, dietary/allergen
tags, mastery, season, and review/availability state. Item facts expose common
name, culinary form, cut/preparation where relevant, allergens, whether the
dish is served raw in game fiction, source/provenance class, and compatibility
status. They never present the game as food-safety guidance.

Fish, roe, and roll sprites must remain distinguishable by silhouette and label
at gameplay scale. Roe cannot rely on hue alone; cut/fat variants require a
text marker and shape/texture cue. Screen-reader names use the full dish and
ingredient form rather than an unexplained Japanese abbreviation.
