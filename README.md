# Samurai Sushi

Samurai Sushi is a guest-first pixel sushi-counter game with optional, legible
onchain provenance. The first product goal is simple: let a player prepare and
serve a satisfying three-order evening shift without a wallet, then optionally
record a non-financial service keepsake on Tezos. Development and ordinary
testing use the shared loopback-only Localnet; Shadownet is reserved for an
explicit final rehearsal of the exact candidate.

> **Phase 0 status:** the repository now contains a walletless counter shell and
> a fail-closed network-environment spine. It is not the playable three-order
> service. No deployed contract, compatible Dos Esposas asset, DER utility,
> mainnet path, cultural approval, or public availability is claimed.

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
- [Application stack and network authority ADR](docs/ADR/0001_APPLICATION_STACK_AND_NETWORK_AUTHORITY.md)

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

## Phase 0 commands

Install dependencies with Node 22+ and pnpm 10:

```bash
pnpm install
pnpm validate
```

Ordinary `dev`, `build`, `start`, and `test:integration` commands first verify
the exact shared runtime revision in `.tezos-runtime.json`, require its worktree
to be clean, load the Localnet profile, and revalidate the resulting values in
the project before a child becomes ready. Shadownet has explicit
`dev:shadownet`, `build:shadownet`, `start:shadownet`, and `test:shadownet`
counterparts. There is no Mainnet command.

The app rejects Tezos keys in project `.env*` files. Profile values come from
the shared runtime only. If signing is later needed, use the profile-specific
`SAMURAI_LOCALNET_SIGNER_*` or `SAMURAI_SHADOWNET_SIGNER_*` namespace for the
single command; the runner rejects cross-profile material and never maps signer
values to `NEXT_PUBLIC_*`.
