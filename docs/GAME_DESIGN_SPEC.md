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

## 3. MVP content ceiling

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

The alpha content target may expand to avocado maki, inari sushi, and an
ochazuke closing bowl after MVP play gates pass.

### Stations

| Station | Verbs | Purpose |
| --- | --- | --- |
| Rice hearth | wash, steam, season | shared base preparation and batch planning |
| Prep board | slice, portion | topping transformation and accuracy |
| Rolling/nigiri counter | roll, press, brush, plate | assembly and finishing |

Station interactions are short decisions, not dexterity gates. Animation
confirms state; it never hides the next action.

## 4. First session

1. Lift the curtain and light the counter.
2. Prepare rice through three forgiving beats; the tutorial cannot fail.
3. Make and serve kappa maki to the first guest.
4. Choose one plate/garnish presentation.
5. Make tamago and salmon orders with less guidance.
6. Close the ledger and choose one shop-restoration cosmetic.
7. Choose **Keep playing** or the secondary optional wallet receipt.

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
- Knife & Form: cuts, rolls, nigiri, presentation.
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
Ingredient { id, names, glossary, tags, allergens, provenanceClass, artKey, compatibility }
Recipe { id, version, inputs, stations, output, dietaryTags, plateRules, unlock, recovery }
Guest { id, portraits, preferences, accessibleTell, dialogue, storyFlags }
Service { id, menuRules, guestSequence, constraints, outcomes }
Quest { id, prerequisites, serviceMutation, consequence, keepsake, replayPolicy }
```

Validation rejects missing glossary text, art keys, dietary tags, recipe
version, recovery result, replay policy, or required cultural signoff.

## 10. Gameplay acceptance

- First dish in ≤3 median minutes; full shift in 8–12 minutes.
- Player can identify the next station and ingredient from label, icon, and
  silhouette without color alone.
- Every dish has deterministic input/output preview and a recovery result.
- No connect CTA, wallet request, or ownership branch before the service reaches
  `SETTLED`; a pre-play informational ownership explainer is allowed.
- Reduced motion removes looping/action animation while preserving every state.
- No random reward controls progression.
- Foreign assets cannot be consumed until full identity, custody, and
  disposition review is surfaced before signature.
