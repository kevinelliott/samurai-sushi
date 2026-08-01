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
                                             \-> CANCELLED     -> CONFIRMED -> FINALIZED
                                             \-> REJECTED          \-> REORGED
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
| REVIEWED | AWAITING_SIGNATURE | wallet request begins after final preflight |
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
  issuer key, code/schema, receipt policy, and initial empty nonce/record state.
  Future FA2 manifests separately verify complete ledger/supply equality,
  metadata, and economic policy.
- End-to-end rehearsal reloads at every state boundary without false success or
  duplicate receipt.
