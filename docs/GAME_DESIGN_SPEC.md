# Game Design Specification

## 1. Fantasy and setting

The player restores and runs a tiny eight-seat neighborhood counter. The
provisional in-world shop is **Moonwake Sushi** on fictional **Shiokaze Row**.
The emotional arc is apprentice → reliable craftsperson → trusted host →
steward of a living neighborhood counter.

“Samurai” refers to discipline, readiness, restraint, tool care, and service
under pressure. There is no combat, conquest, honor meter, faux-feudal ranking,
or weapon-as-control metaphor.

## 2. Core loop

```text
open menu -> prepare pantry -> accept order -> perform station steps
-> plate -> serve -> receive readable feedback -> close ledger -> improve one thing
```

An MVP service lasts 8–12 minutes and has three sequential guest tickets. Costs
and success conditions are visible before commitment. Presentation affects
guest delight and expression, never token yield.

## 3. MVP onboarding vertical and scalable catalog

### Ingredients

- sushi rice
- rice vinegar
- nori
- cucumber
- tamago
- salmon

Soy glaze, ginger, sesame, and tea may be non-token pantry details when useful;
they MUST NOT silently alter economic recipes.

### Dishes

| Dish | Inputs | Station sequence | Learning goal |
| --- | --- | --- | --- |
| Kappa maki | sushi rice, nori, cucumber | prep → rolling mat | layering and roll order |
| Tamago nigiri | sushi rice, tamago, nori | prep → nigiri counter | portion and binding |
| Salmon nigiri | sushi rice, salmon | prep → nigiri counter | topping preparation and finishing |
| Salmon sashimi | salmon | prep/sashimi board → plating | rice-free cut, portion, and presentation |

The first three rows form the required first service. Salmon sashimi unlocks
immediately after that service reaches `SETTLED`; it is MVP content but not a
fourth tutorial order. Alpha expands to the multi-family catalog in
[`SUSHI_CONTENT_CATALOG.md`](SUSHI_CONTENT_CATALOG.md) after MVP play gates pass.

### Stations

| Capability | Verbs | Purpose | Availability |
| --- | --- | --- | --- |
| Rice hearth | wash, steam, season, portion | shared base preparation and batch planning | MVP |
| Prep/sashimi board | slice, portion, score, arrange | topping transformation, sashimi cuts, and accuracy | MVP |
| Rolling mat | layer, roll, cut | hosomaki, futomaki, and uramaki form | MVP; advanced forms later |
| Nigiri counter | press, bind, wrap, fill, fold, brush, plate | nigiri, gunkan, and temaki form | MVP; gunkan/temaki later |
| Tea & flame | brew, cook, sear | cooked ingredients, tea/soup, and reviewed seared dishes | Alpha |

The UI may group these into three compact interaction areas during MVP, but the
content schema preserves five capability IDs so sashimi, gunkan, temaki, and
cooked/seared dishes do not require a later migration. Station interactions are
short decisions, not dexterity gates. Animation confirms state; it never hides
the next action. These are game abstractions, not real-world handling guidance.

## 4. First session

1. Lift the curtain and light the counter.
2. Prepare rice through three forgiving beats; the tutorial cannot fail.
3. Make and serve kappa maki to the first guest.
4. Choose one plate/garnish presentation.
5. Make tamago and salmon orders with less guidance.
6. Close the ledger and choose one shop-restoration cosmetic.
7. Unlock salmon sashimi and choose **Keep playing** or the secondary optional
   wallet receipt.

## 5. Guest system

Each guest has a stable ID, portrait states, a readable non-color preference
cue, dietary tags, a small dialogue pool, and at least one continuing story flag.
MVP guests should include a ceramicist, a dawn fishmonger, and a closing-time
courier, subject to cultural review.

Outcomes are authored as `delighted`, `content`, or `recoverable concern` with
specific feedback. No star ratings, public leaderboards, or wealth display.

## 6. State machines

```text
Service: IDLE -> OPEN -> CLOSING -> SETTLED
                    \-> ABANDONED

Order: OFFERED -> ACCEPTED -> PREPARING -> READY_TO_PLATE -> PLATED -> SERVED
                 \-> EXPIRED         \-> FAILED       \-> DISCARDED
```

No state moves backward. An abandoned session closes outstanding orders without
changing chain inventory. A timed-out service never consumes an onchain asset
unless a separately reviewed chain operation was already confirmed.

## 7. Progression

Four private mastery threads:

- Rice: preparation and batch planning.
- Knife & Form: sashimi cuts, fish/cut recognition, rolls, nigiri, gunkan, and
  presentation.
- Hospitality: preference accuracy and pacing.
- Season: menu composition and neighborhood events.

Unlocks are recipes, story visits, plates, shop fixtures, music layers, and
animation variants—not yield multipliers. A service advances at most one
clearly previewed milestone.

## 8. Failure and recovery

- Wrong assembly becomes a staff meal or explicit retry with a corrective cue.
- Late service changes feedback, not ownership.
- Pause/reload restores the last durable service boundary.
- Wallet or network failure cannot erase local service results.
- No essential timing window is under five seconds.
- Every action supports pointer, touch, and keyboard.

## 9. Content schema

Content is data-authored:

```text
VersionedRef { id, version }
Species { id, version, contentHash, scientificName, names, marketNames, group, reviewId }
Ingredient { id, version, contentHash, kind, speciesRef?, productKind?, names, glossary, allergenSets, artKey, reviewId }
PreparedComponent { id, version, contentHash, ingredientRef, cutStyleRef?, treatment, rawNotice, allergenSets, stationSteps, artKey, reviewId }
DishFamily { id, version, contentHash, structuralSlots, forbiddenSlots, namingRules, platingRules, reviewId }
Dish { id, version, contentHash, familyRef, componentSlots, rawProfile, allergenSets, dietaryTags, artKey, reviewId }
RecipeVersion { id, version, dishRef, exactComponentAmounts, stations, unlock, recovery, seasonalityRuleRefs, contentHash }
RecipeVariant { id, version, contentHash, baseRecipeRef, exactSubstitutions, resultingDishRef, reviewIds, status }
Guest { id, portraits, preferences, accessibleTell, dialogue, storyFlags }
Service { id, menuRules, guestSequence, constraints, outcomes }
Quest { id, prerequisites, serviceMutation, consequence, keepsake, replayPolicy }
```

Validation rejects missing glossary text, art keys, derived dietary/allergen
tags, raw-service policy, recipe version, recovery result, replay policy, or
required cultural signoff. Species, cut, roe, roll-form, and content-pack rules
are normative in [`SUSHI_CONTENT_CATALOG.md`](SUSHI_CONTENT_CATALOG.md).

## 10. Gameplay acceptance

- First dish in ≤3 median minutes; full shift in 8–12 minutes.
- Player can identify the next station and ingredient from label, icon, and
  silhouette without color alone.
- Every dish has deterministic input/output preview and a recovery result.
- The MVP includes a real sashimi path after the first settled service; sashimi
  contains no sushi rice and cannot be generated from an arbitrary fish name.
- No connect CTA, wallet request, or ownership branch before the service reaches
  `SETTLED`; a pre-play informational ownership explainer is allowed.
- Reduced motion removes looping/action animation while preserving every state.
- No random reward controls progression.
- Foreign assets cannot be consumed until full identity, custody, and
  disposition review is surfaced before signature.
