# ADR 0002: Versioned Content Compiler

- Status: adopted and extended for Phase 1
- Date: 2026-07-31
- Scope: authored sushi content before persistence or asset interoperability

## Decision

`@samurai-sushi/content` is the sole Phase 0 compiler for playable culinary
content. Its TypeScript model is the executable field-name authority for schema
version 1 and the matching entity summaries in `TECHNICAL_SPEC.md` and
`SUSHI_CONTENT_CATALOG.md` use those names.

The compiler accepts unknown input, rejects unknown or missing fields, and
validates the complete bundle before returning any content. Every row carries
`{id, version, contentHash, reviewId}`. References always carry `{id, version}`;
the pack enumerates every supplied row exactly once. Hashes use canonical JSON
under the domain `samurai-sushi:content-row:v1` so repeated builds are byte
stable and a field change cannot masquerade as the same version.

The pack also binds the exact `{kind,id,version,contentHash}` manifest and the
exact ordered art records `{key,digest,nonColorIdentity}`. Membership therefore
cannot preserve a pack hash while swapping row hashes, art digests, or visual
identity between keys.

The package derives dish allergen and raw profiles from exact prepared-component
versions, validates typed family roles and nori placement, rejects wildcard or
cyclic variants, requires immutable art digests and non-color identities, and
uses pinned subject, region, IANA zone, tzdb version, and half-open dates for
seasonality. Activation compilation rejects rules whose tzdb version differs
from the compiler runtime; historical replay validates the archived `YYYYx`
pin without re-activating it against a newer host tzdb. Historical recipe
snapshots contain their transitive component, ingredient, cut, family,
seasonality, art-key, recovery, and exact result meaning.

Diagnostic issue codes remain precise for authors. `ContentValidationError`
also exposes one existing stable domain failure code: structural/hash/atomicity
issues map to `CONTENT_VERSION_DRIFT`; species/roe/cut issues to
`UNKNOWN_SPECIES`; family and dish-input issues to `DISH_FAMILY_MISMATCH`;
variant issues to `AMBIGUOUS_VARIANT`; allergen/raw/seasonality/review issues to
their corresponding stable codes; and invalid quantities to
`INVALID_QUANTITY`. No new public failure vocabulary is introduced.

## Boundaries

This pure package does not authorize tokens, custody, escrow, consumption, or a
deployment. `AssetBinding` remains the only future semantic-to-onchain bridge
and belongs behind the separately reviewed interoperability boundary.
`reviewReferences` prove only that a named record is present. The bundled
salmon-sashimi data uses explicit `fixture-*` review references and is not
evidence of production culinary, cultural, sourcing, or food-safety approval.

`ProvenanceProfile` remains a documented later boundary rather than being
silently collapsed into ingredient identity. Production activation that makes
origin, tradition, sourcing, or seasonality claims must add evidence-backed
provenance records and named review before release.

Schema v1 rejects non-empty dietary claims until their derivation is modeled.
Recipe results must resolve to the exact pinned dish, and unlock/recovery values
come from closed enums so runtime code cannot silently interpret new prose.

## Consequences

- Persistence and guest/account decisions remain outside this slice.
- The walletless tutorial still has exactly three orders; the fixture exercises
  the immediate post-service salmon-sashimi unlock schema only.
- Pack compilation is all-or-nothing and returns a deeply frozen result.
- New content versions cannot reinterpret historical orders.
- The first-evening extension compiles a complete schema-v1 `ContentBundle`
  for every ingredient, component, family, dish, and recipe, reuses the exact
  salmon species/product row, binds the sashimi unlock to the existing compiled
  salmon species/cut/raw/allergen/dish/recipe graph, and pins separate literal
  hashes for content, art, service, happy, corrective, abandonment, and
  terminal replay bytes.
- The projection manifest is the only authority for prompts, choices, guest and
  dish labels, outcome, feedback, story consequence, presentation,
  restoration, and unlock references. Browser code may not derive copy or game
  rules from enum spelling.
- Cultural approval, live network readiness, and onchain manifests remain
  separate evidence categories.
