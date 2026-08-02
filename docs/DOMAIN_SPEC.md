# Normative Domain Specification

The terms MUST, SHOULD, and MAY are used in their RFC sense.

## 1. Authority

- Transferable assets and balances are chain-authoritative only after the
  configured confirmation threshold.
- Service sessions, order timing, mastery, tutorials, feedback, and ordinary
  cosmetics are game-authoritative and non-transferable.
- Indexed chain data is a projection with source, block, observed time, account,
  chain, contract, and token identity.
- Where onchain recipes exist, their economics are immutable/versioned and
  identified by chain, contract, code hash, policy hash, and deployment
  manifest hash. The MVP receipt uses a separate receipt-policy manifest.

## 2. Receipt intent and operation-attempt state

```text
Intent: DRAFT -> REVIEWED -> AWAITING_SIGNATURE -> SUBMITTED -> INCLUDED
          \-> EXPIRED         \-> CANCELLED     -> CONFIRMED -> FINALIZED
                 \-> EXPIRED  \-> REJECTED          \-> REORGED
                                \-> EXPIRED

Attempt: SUBMITTED -> INCLUDED -> CONFIRMED -> FINALIZED
                  \-> FAILED      \-> REORGED -> INCLUDED
                  \-> DROPPED                  \-> DROPPED
                  \-> REPLACED
```

`ReceiptIntent` owns one or more operation attempts. Wallet rejection is not
chain failure. Submitted is not included. Included is provisional. Confirmed is
reached after the manifest-configured confirmation threshold and may settle the
normal projection. Finalized is reached only after the manifest-configured
finality/cemented-block policy and is terminal.

`DRAFT`, `REVIEWED`, and `AWAITING_SIGNATURE` become `EXPIRED` exactly when
PostgreSQL `clock_timestamp() >= expires_at`; equality is expired. No other
state gains an expiry transition. The named
`localnet-two-confirmation-rehearsal-v1` evaluator derives confirmations as
`canonicalHeadLevel - includedLevel + 1`, treats inclusion as confirmation one,
and satisfies both confirmation and rehearsal finality at confirmation two only
when exact canonical head/block evidence is valid. Adapter-supplied confirmation
counts or finalized booleans have no authority. When one observation reaches
both boundaries, the ordered `CONFIRMED` and `FINALIZED` lifecycle facts commit
atomically.

An old attempt marked `REPLACED` records the replacement hash; a new attempt
starts at `SUBMITTED` under the same intent. Contract uniqueness ensures at most
one can issue. If two attempts reach chain inclusion, the later mutation fails
with duplicate nonce/commitment and projects as `FAILED`, never a second receipt.

`REORGED` is a compensating state allowed from `INCLUDED` or `CONFIRMED`. The
projection removes the provisional/settled onchain receipt, preserves the
offchain `SETTLED` service, records the orphaned block, and observes the same
attempt until it is re-included or dropped. Re-inclusion reapplies idempotently.
A finalized receipt does not transition; an event contradicting the finality
assumption enters incident handling rather than being hidden as a normal state.

UI language: `SUBMITTED` “Sent”; `INCLUDED` “Included, waiting for
confirmations”; `CONFIRMED` “Recorded”; `FINALIZED` “Finalized”; `REORGED`
“Chain reorganized; your service is safe and the public receipt is being
rechecked”; `DROPPED/FAILED/REJECTED` state that no receipt was recorded.

### Legal transition table

| From | To | Condition |
| --- | --- | --- |
| DRAFT | REVIEWED | canonical permit and dispatch preview accepted |
| DRAFT | EXPIRED | PostgreSQL clock is at or after permit expiry |
| REVIEWED | AWAITING_SIGNATURE | wallet request begins after final preflight |
| REVIEWED | EXPIRED | PostgreSQL clock is at or after permit expiry |
| AWAITING_SIGNATURE | CANCELLED/REJECTED/EXPIRED | user/system terminal pre-submission result |
| AWAITING_SIGNATURE | SUBMITTED | wallet returns an operation hash |
| SUBMITTED | INCLUDED | RPC evidence places attempt in canonical block |
| SUBMITTED | FAILED/DROPPED/REPLACED | terminal evidence or replacement hash |
| INCLUDED | CONFIRMED/FAILED/REORGED | threshold, chain failure, or orphaned block |
| CONFIRMED | FINALIZED/REORGED | finality policy or compensating orphan evidence |
| REORGED | INCLUDED/DROPPED | same attempt reappears or expires from observation |

## 3. Invariants

1. Asset identity is the full chain/contract/token tuple.
2. Every token amount is a natural number in raw units.
3. Recipe ID + version + policy hash deterministically defines all effects.
4. Atomic mutation changes every declared input/output or none.
5. Burn owner delta equals total-supply delta.
6. Reserve owner delta equals custodian delta with opposite sign; supply is
   unchanged.
7. Guaranteed output equals declared display amount × quantity × unit scale.
8. `(chainId, operationHash)` is idempotent in projection.
9. A receipt binds one account and one service and is issued at most once.
10. Code/policy/deployment/network/account/accepted-asset drift fails closed.
11. Metadata authority cannot mint, transfer, rewrite economics, or enable
    foreign assets.
12. Non-transferable progression is not redeemable or priced.
13. Timed-out/abandoned service does not mutate chain state unless an independent
    reviewed operation was already confirmed.
14. MVP has no random economic reward.
15. The final dispatch tuple is canonically equal to the reviewed tuple across
    wallet generation, session revision, source, chain, permission scope,
    destination, entrypoint, mutez amount, payload bytes, manifest, intent, and
    expiry; otherwise transport calls equal zero.
16. Species, culinary ingredient, cut, prepared component, dish family, dish,
    recipe, provenance claim, and asset binding are distinct versioned,
    append-only identities; all transitive references pin `{id, version}`.
17. Every aquatic ingredient resolves to exactly one reviewed species; every
    roe product identifies its source species. Uni is not roe.
18. Every recipe references exact prepared components and one dish family;
    runtime wildcards such as `any fish`, `any roe`, or `any filling` are invalid.
19. Sashimi contains no sushi rice. Nigiri, gunkan, and each roll subtype satisfy
    their versioned structural-slot grammar.
20. Raw-food notice and `contains`, `mayContain`, and `crossContact` profiles
    derive independently and monotonically from exact prepared-component
    versions. Overrides cannot remove or downgrade a contained allergen.
21. Recipe variants are finite, explicit, acyclic, review-addressable, and
    resolve to a concrete dish. Published recipe versions are immutable.
22. Seasonality uses pinned ISO-8601 local dates, IANA zone/tzdb version, exact
    subject-version and region matching, and half-open `[start, end)` windows.
    No matching rule means `unspecified`; invalid or contradictory matching
    rules produce `SEASONALITY_UNRESOLVED`.
23. Only the manifest-verified `AssetBinding` registry authorizes recognition,
    escrow, or consumption. Semantic identity or projection disagreement fails
    closed.
24. Updating content cannot alter a historical order's component identities,
    allergen/raw profile, recovery, art, output, or content hash.
25. A first-evening checkpoint has exactly one nonnegative safe-integer
    revision and one valid phase/order/component shape; no client or database
    clock, random input, wallet, RPC, indexer, bearer, or key metadata may alter
    a reducer decision.
26. Accepted service commands advance revision by exactly one. Corrective
    decisions preserve byte-identical checkpoint and revision while remaining
    exactly replayable through their command receipt.
27. Component accounting conserves `total = available + placed + served +
    discarded` at every representable checkpoint. Service/order phases never
    move backward.
28. `SETTLED` is reachable only after the three authored orders are served in
    order, ledger close, and one allowed restoration. Its salmon-sashimi unlock
    is one idempotent set member committed with the settlement checkpoint,
    event, receipt, and outbox write; `ABANDONED` cannot contain it.
29. A service command identity is scoped by server-resolved subject kind,
    subject ID, and idempotency key. Exact retry precedes revision rejection;
    any changed command name, revision, content version, or canonical payload
    rejects without mutation.

## 4. Stable failure codes

```text
WALLET_NOT_CONNECTED
WALLET_ACCOUNT_CHANGED
WALLET_SCOPE_MISSING
WRONG_NETWORK
CONTRACT_NOT_READY
POLICY_MISMATCH
INTENT_EXPIRED
UNKNOWN_RECIPE
RECIPE_VERSION_INACTIVE
CONTENT_VERSION_DRIFT
UNKNOWN_SPECIES
UNKNOWN_COMPONENT
DISH_FAMILY_MISMATCH
AMBIGUOUS_VARIANT
ALLERGEN_CONFLICT
RAW_PROFILE_CONFLICT
SEASONALITY_UNRESOLVED
PROVENANCE_UNVERIFIED
ASSET_BINDING_MISMATCH
INVALID_QUANTITY
UNKNOWN_ASSET
FOREIGN_ASSET_NOT_APPROVED
INEXACT_UNIT_CONVERSION
INSUFFICIENT_INGREDIENTS
USER_REJECTED
OPERATION_FAILED
OPERATION_BACKTRACKED
CONFIRMATION_TIMEOUT
RECEIPT_OWNER_MISMATCH
RECEIPT_ALREADY_USED
ORDER_EXPIRED
INVALID_STATE_TRANSITION
```

Raw provider/indexer details MAY be attached for diagnostics but MUST NOT
replace stable, user-safe failure codes.

## 5. Verification properties

- Schema tests reject malformed identity, negative/non-integer quantity,
  duplicate accepted refs, missing digests, and inexact conversion.
- Content graph tests reject dangling/cyclic variants, wildcard components,
  species/product/cut mismatch, family-slot violations, missing raw notices,
  weakened allergens, contradictory seasonality, evidence-free provenance, and
  semantic IDs used as asset authorization.
- Identity fixtures keep salmon species, salmon flesh, a salmon sashimi
  component, salmon sashimi dish, and a lookalike `SALMON` token non-equal;
  ikura/tobiko/masago remain distinct and uni-as-roe is rejected.
- Historical-content fixtures create new component/dish versions and prove an
  old order retains its pinned allergen/raw profile, recovery, art, output, and
  content hash.
- Allergen fixtures reject contains-to-may/cross-contact downgrade. Binding
  fixtures reject a stale or disagreeing accepted-asset projection.
- Seasonality fixtures cover below/at/above half-open boundaries, invalid
  duration, leap date, DST instant-to-local-date conversion, region mismatch,
  contradictory overlap, unknown zone/tzdb, and no-rule `unspecified`.
- Event replay twice produces byte-equivalent projection.
- Failed/backtracked/skipped operations never settle.
- Account A→B, network, scope, disconnect/reconnect, multi-tab, and payload drift
  produce zero final dispatch.
- Deferred parameter mapping tests cover drift in every dispatch-tuple field
  and assert byte equality plus zero Beacon transport/send/broadcast calls on
  mismatch.
- Lifecycle tests cover included→reorged, confirmed→reorged, re-inclusion,
  dropped, replaced, replacement collision, and exactly-once projection.
- Receipt-manifest verification reconstructs indexed origination, roles,
  issuer key-policy registry, code/schema, receipt policy, and initial empty
  nonce/record state.
  Future FA2 manifests separately verify complete ledger/supply equality,
  metadata, and economic policy.
- End-to-end rehearsal reloads at every state boundary without false success or
  duplicate receipt.
