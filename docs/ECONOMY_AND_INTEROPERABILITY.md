# Economy and Interoperability Policy

## 1. Economy thesis

Samurai Sushi is a craft-and-service game with optional onchain provenance,
not a token-yield game. Orders, timing, reputation, mastery, ordinary pantry
inventory, and shop restoration are game-authoritative and non-transferable.
Onchain state is reserved for deliberate ownership and provenance where
permanence adds player meaning.

## 2. Asset taxonomy

- Staples: rice, vinegar, nori.
- Proteins: salmon, tuna, tamago, tofu.
- Produce/garnish: cucumber, avocado, scallion, ginger, sesame, citrus.
- Prepared components: sushi rice, sliced topping, tamago block, garnish tray.
- Finished dishes: nigiri, maki, hand rolls, bowls, composed plates.
- Progress: recipe mastery, station proficiency, neighborhood trust;
  non-transferable and non-redeemable.
- Provenance: verified foreign holdings, festival stamps, cosmetics, and
  commemorative service receipts; optional and distinctly labeled.

All asset math uses raw natural-number units. `raw = display × 10^decimals`.
Inexact conversion is rejected, never rounded.

## 3. Sources and sinks

MVP ordinary pantry sources are authored service fixtures and deterministic
game grants. Progress sinks are service preparation and cosmetic restoration.
There is no rent, involuntary spoilage, durability decay, token gate, paid
randomness, staking, referral emission, or wallet-wealth reward.

If onchain crafting later ships:

- each recipe version pins all inputs, quantities, dispositions, output, batch
  bounds, and policy hash;
- every craft is atomic;
- burns reduce owner balance and total supply by the same raw amount;
- reserves move balance to a named custodian without changing supply and MUST
  never be described as burned;
- outputs equal the declared recipe version exactly;
- batch splitting cannot improve expected per-unit value.

## 4. Interoperability levels

1. **Semantic:** two games recognize the concept `rice`; no asset permission.
2. **Read-only recognition:** a full allowlisted foreign asset identity unlocks
   lore or a cosmetic variant without transfer, yield, or progression advantage.
3. **Escrow receipt:** a reviewed same-chain adapter locks an exact asset and
   represents it 1:1 with a non-transferable game receipt; redemption remains
   available unless an independent consume action was explicitly approved.
4. **Consumptive import:** an exact foreign asset can be irreversibly used only
   after audit, caps, incident controls, reconciliation, and user review.

MVP implements none. The first eligible experiment is level 2.

## 5. Full asset identity

An accepted foreign asset is keyed by:

```text
chain_id + contract_address + token_id
```

The reviewed registry additionally pins standard/entrypoints, decimals, code
hash, metadata digest policy, issuer/admin and mint/burn powers, current supply
consistency, custody behavior, pause/upgrade powers, intended Samurai use,
policy version, start/end conditions, and caps.

Name, ticker, slug, image, culinary meaning, or client-supplied metadata are
never sufficient.

## 6. Dos Esposas evidence candidates

The inspected dated Dos Esposas snapshot identifies:

- Rice: Tezos mainnet contract
  `KT1Wa2ncR8GbeQrW6Dbtpc8uTrK7q5CH4F2Q`, token `0`, 2 decimals.
- Dos Esposas Restaurante Credits (`DER`): Tezos mainnet contract
  `KT1Kp2ZhSvNzzwYpF6pYvdjfd17hYRXjqe9Y`, token `0`, 6 decimals.
- In the Dos Esposas Shadownet replacement, Rice is token `10` and DER token
  `38`; these are not atomically interchangeable with mainnet.

These values are evidence candidates, not an allowlist. They MUST be refreshed
from chain evidence and reviewed before any compatibility claim.

## 7. DER policy

DER is not Samurai Sushi currency. It MUST NOT buy power, gate recipes,
accelerate progression, pay fees, receive promised redemption, or be a reward.
The MVP does not read or use it.

A later read-only pilot MAY let verified DER ownership alter a tip-jar cosmetic
or grant one non-economic stamp. Any spend path requires Dos Esposas issuer
authorization, full identity verification, published sink/caps, custody UX,
legal review, and no implied price peg or future value.

## 8. Integrity guardrails

- No presale, APY/yield, bonding curve, buyback, referral emissions, or paid
  randomized rewards.
- No transferable reward for wallet wealth alone.
- Changes to recipes, compatibility, or caps create a new version with public
  diff and timelock; admins cannot silently rewrite live policy.
- Emergency pause stops new mutations and preserves read-only state and safe
  redemption.
- Actor-scoped idempotency and nonces prevent replay and wallet cycling.
- Valuable randomness does not ship without an audited protocol; deterministic
  skill outcomes are the default.

## 9. Interoperability gates

- Wrong chain, lookalike symbol, wrong token, decimals mismatch, metadata drift,
  admin/code change, malicious FA2, duplicate import, revoked operator, partial
  failure, and replay all fail closed.
- Registry drift disables mutation.
- Import/redemption reconcile 1:1 under duplicate events, indexer delay, reorg,
  partial RPC failure, account switching, and repeated submission.
- A published manifest and independent review cover each enabled row.
- Mainnet and cross-chain support are separate gated products.
