# Samurai Sushi

Samurai Sushi is a guest-first pixel sushi-counter game with optional, legible
onchain provenance. The first product goal is simple: let a player prepare and
serve a satisfying three-order evening shift without a wallet, then optionally
record a non-financial service keepsake on Tezos. Development and ordinary
testing use the shared loopback-only Localnet; Shadownet is reserved for an
explicit final rehearsal of the exact candidate.

> **Foundation status:** specification only. No playable build, deployed
> contract, compatible Dos Esposas asset, DER utility, mainnet path, or public
> availability is claimed by this repository yet.

## Product promise

**Build a tiny sushi counter, master its rhythm, and make every plate your own.**

The game takes inspiration from Dos Esposas' pixel restaurant craft, ingredient
grammar, explicit transaction review, and inspectable receipts. It is not a
reskin and does not inherit Dos Esposas assets or token behavior by name.

## Foundation documents

- [Product record](PRODUCT.md)
- [Product brief](docs/PRODUCT_BRIEF.md)
- [Product requirements](docs/PRD.md)
- [Feature catalog](docs/FEATURES.md)
- [Game design specification](docs/GAME_DESIGN_SPEC.md)
- [Sushi content catalog](docs/SUSHI_CONTENT_CATALOG.md)
- [Normative domain specification](docs/DOMAIN_SPEC.md)
- [Economy and interoperability policy](docs/ECONOMY_AND_INTEROPERABILITY.md)
- [Technical specification](docs/TECHNICAL_SPEC.md)
- [Tezos Localnet lifecycle](docs/TEZOS_LOCALNET_LIFECYCLE.md)
- [Security and trust model](docs/SECURITY_AND_TRUST.md)
- [Experience and visual design specification](docs/DESIGN_SPEC.md)
- [Content and cultural review](docs/CONTENT_AND_CULTURAL_REVIEW.md)
- [Delivery plan](docs/DELIVERY_PLAN.md)
- [Research and metrics protocol](docs/RESEARCH_AND_METRICS.md)
- [Decision register](docs/DECISIONS.md)
- [Source and evidence notes](docs/SOURCE_NOTES.md)

## MVP in one line

One responsive web counter, three authored customers, a three-dish tutorial
service plus an immediately unlocked sashimi dish, three compact interaction
areas, an 8–12 minute guest-mode service, and one optional Shadownet service
receipt only after the service reaches `SETTLED`. The schema separately
supports a reviewed 12/24/40+ dish path across fish, roe, sashimi, and distinct
roll families.

## Explicitly out of MVP

Mainnet, a marketplace, trading, paid loot, random economic rewards, staking,
yield, public rankings, token-gated play, DER spend, foreign-asset custody,
bridging, migration, and consumptive Dos Esposas interoperability.

## Network development rule

Samurai Sushi implementation must default to the shared
`REPOS/project-crypt-tezos-localnet` runtime. Missing or unknown network state,
Mainnet, chain mismatches, mixed server/browser values, and a public indexer in
Localnet mode must stop startup. Shadownet commands are explicit final-test
commands and do not replace local development. See the
[complete lifecycle](docs/TEZOS_LOCALNET_LIFECYCLE.md).
