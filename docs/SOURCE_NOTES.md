# Source and Evidence Notes

## Dos Esposas baseline

The product foundation inspected
[`kevinelliott/dos-esposas`](https://github.com/kevinelliott/dos-esposas) at
commit `44761bc2ec8c4b4532214f8e74248ce3b2aa69c6`, branch
`improve/service-pass`. The checkout contained unrelated local modifications,
so source references are design/engineering evidence, not a clean release or
deployment attestation.

Relevant evidence:

- `PRODUCT.md`: pixel restaurant identity, custody clarity, Shadownet rehearsal.
- `README.md`: 57-asset test lab, 22 recipes, eight actions, wallet/inventory,
  market, trade, Replate, and manifest workflow.
- `data/mainnet-assets.json`: dated exact asset identities and decimals.
- `data/kitchen-mechanics.json`: canonical burn/reserve/drop policy.
- `docs/kitchen-economics.md`: atomic accounting, reserve custody, predictable
  testnet randomness, and deployment policy.
- `lib/wallet-operation.ts` and `lib/wallet-runtime.ts`: final-dispatch and
  reconnect-generation patterns.
- `lib/deployment-manifest.ts` and `lib/contract-readiness.ts`: exact deployment
  attestation and fail-closed readiness patterns.

## Team synthesis

The originating Buzz thread received eight independent specialist reviews:

- Anna: Counter Ledger experience and visual design.
- Crypto: economy and interoperability.
- Gustav: security and threat model.
- Billy: architecture and delivery feasibility.
- Mason: normative entities, state machines, invariants, and acceptance gates.
- Sandy: gameplay, worldbuilding, content system, and cultural posture.
- Gertrude: audience, positioning, ethical growth, and claim guardrails.
- Abraham: skeptical MVP scope and cultural/name risk.

The shared conclusion is a service game with optional provenance, not a token
economy. Where recommendations differed, the foundation chose the smaller
first-service experiment—three required dishes/guests—then added salmon sashimi
as an immediate fourth MVP unlock and a finite reviewed catalog path of 12 alpha,
24 public-launch, and 40+ post-launch dishes.

## Working assumptions

Kevin was originally asked to confirm Shadownet-first, future opt-in
interoperability, and web-first Next.js/TypeScript on Tezos. No answer arrived
during the foundation run. On 2026-07-31 he subsequently established Localnet
as the required ordinary development/test environment for the
`project-crypto-*` Tezos projects, with Shadownet reserved for final tests. The
stack and interoperability hypotheses remain reversible.

## Claims this repository does not support

This specification does not prove a playable build, deployment, contract
compatibility, audit, user demand, cultural approval, public availability,
mainnet readiness, asset value, or financial return.
