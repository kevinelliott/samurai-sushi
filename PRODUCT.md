# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Working assumption: Next.js, React, and TypeScript on Tezos, with Shadownet as
the first chain environment. The user was asked to confirm this direction; the
foundation proceeded after no response, so it remains reversible until the
first implementation decision.

## Users

Primary users are players who enjoy short-session craft, service, cozy
management, pixel food art, and recipe mastery. They want an expressive,
complete game without needing a wallet.

Secondary users are wallet-curious indie players and the Tezos/Dos Esposas
community. They need optional ownership to be understandable, non-coercive, and
truthful about network, contract, custody, fees, and finality.

Yield seekers and users primarily motivated by expected financial return are
not the design center.

## Product Purpose

Samurai Sushi lets a player feel the focused rhythm of preparing and serving a
tiny neighborhood sushi counter, then optionally preserve one earned service
memento onchain. Success means the craft-and-service loop is satisfying before
wallet mechanics are introduced.

## Positioning

Samurai Sushi is a compact pixel service game in which preparation, timing,
hospitality, and presentation create the result. Unlike speculative crypto
games, the first fun arrives before a wallet does; onchain actions are optional,
previewed in plain language, and attached to understandable provenance.

## Operating Context

Players enter in guest mode, open a short evening service, prepare ingredients,
assemble dishes, serve authored guests, and close the ledger with readable
feedback. Wallet connection is offered only after a complete play result.

The first chain rehearsal is assumed to use Tezos Shadownet. Any indexed chain
data is a projection; confirmed chain state remains authoritative for onchain
assets and receipts.

## Capabilities and Constraints

- The MVP is a responsive web experience with an 8–12 minute evening shift.
- A complete first service MUST work without a wallet, faucet, marketplace, or
  crypto vocabulary.
- MVP gameplay outcomes are deterministic; no random economic reward ships.
- Local/game-authoritative progression is non-transferable and cannot be
  redeemed for financial value.
- The optional MVP chain action records one service keepsake after play.
- DER and Dos Esposas ingredient support are post-MVP hypotheses. Shared names,
  symbols, slugs, images, or culinary meaning never establish asset identity.
- Mainnet, foreign-asset custody, consumption, bridging, and marketplaces are
  outside the MVP.
- The name, setting language, sushi content, art, and audio require Japanese
  cultural and culinary review before public release.

## Brand Commitments

The product name is Samurai Sushi, subject to cultural and naming validation.
It is Japanese sushi-counter themed and related to Dos Esposas through strong
pixel silhouettes, tactile restaurant interactions, candid chain state, and
inspectable receipts. It must not reuse the Dos Esposas palette, cantina voice,
logo, mascot, page composition, or Mexican cultural imagery.

The word “samurai” represents discipline, readiness, restraint, care for tools,
and service under pressure—not combat, costume, faux-feudal ranks, or weaponry.

## Evidence on Hand

- Dos Esposas product and source evidence at observed commit
  `44761bc2ec8c4b4532214f8e74248ce3b2aa69c6`; the checkout was dirty, so this is
  design evidence rather than a clean release attestation.
- Verified-in-source Dos Esposas asset identities include Rice and DER, but
  they are compatibility candidates only and are not approved for Samurai
  Sushi.
- Eight specialist reviews in the originating Buzz project thread cover
  product, design, gameplay, economy, security, engineering, formal
  specification, and skeptical scope.

No Samurai Sushi implementation, art library, production contract, deployment,
audit, user research, commercial proof, or cultural signoff exists yet.

## Product Principles

- Fun before wallet.
- Craft and hospitality before financialization.
- Full asset identity before interoperability.
- Receipts over optimistic success states.
- Cultural specificity with review, never decorative shorthand.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Every core path must support keyboard, touch, and pointer;
drag interactions require select/place alternatives. State cannot depend on
color, motion, sound, or pixel art. Reduced motion is full functional parity.
Text must work at 200% zoom and the experience must remain usable at 320 CSS px.

