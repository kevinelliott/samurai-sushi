# ADR 0004: First-Evening Service Authority

- Status: adopted for Phase 1
- Date: 2026-08-01
- Scope: walletless first-service content, reducer, persistence, and HTTP authority

## Decision

The first evening is a bounded, deterministic server-authoritative service. Its
canonical state is a deeply frozen schema-v1 checkpoint governed by the pure
`@samurai-sushi/domain/evening-service` reducer. The reducer admits only the
pinned finite command vocabulary, advances accepted decisions by one safe
revision, preserves byte-identical state for corrective decisions, conserves
components, and permits only `IDLE -> OPEN -> CLOSING -> SETTLED` or
`OPEN/CLOSING -> ABANDONED`.

`@samurai-sushi/content` compiles the exact review-pending service definition,
a complete versioned/hash-bound first-service `ContentBundle`, the existing
salmon-sashimi catalog binding, copy and art inventories, projection manifest,
and four golden replay families. The service bundle reuses the exact salmon
species/product identity instead of duplicating it. Prepared sushi rice binds
both `sushi-rice@1` and `rice-vinegar@1` through an exact versioned preparation
input at the authored seasoning station; the compiler rejects missing,
orphaned, duplicated, action-drifted, and free-string preparation authority.
Literal SHA-256 expectations make one-byte drift a review event.

PostgreSQL is canonical. `EveningServiceAuthority` resolves the existing guest
or active acknowledged player cookie, locks the subject parent first, then the
subject/idempotency and progress authority, performs replay lookup before
revision CAS, resamples time and key authority, and atomically commits accepted
checkpoint, event, outbox, and receipt writes. A correction stores only its
repeatable receipt. Claim transfers the existing rows; deletion removes them.
For an existing-player claim, the claimed guest checkpoint remains one coherent
active service history and is rebased to the exact committed player revision;
existing player and guest unlock facts are unioned monotonically. Presentation,
restoration, ledger, and story facts are never spliced from incompatible
histories. PostgreSQL and the service authority fail closed unless the outer
progress revision and decoded checkpoint revision are identical safe integers.

The two exact Node routes reuse the established raw Origin/Host/target/header,
cookie, and streaming-JSON guard. They never accept identity, wallet, proof,
chain, clock, random, bearer, digest, or key authority from JSON. Query and
command responses contain canonical checkpoint and a manifest-derived
projection with an explicit disposition.

## First-evening invariant

Settlement requires the authored ceramicist/kappa, fishmonger/tamago, and
courier/salmon order sequence, one of two cosmetic presentation choices, ledger
close, and one of three cosmetic restorations. The same revision transaction
adds exactly one `atlantic-salmon-sashimi@1` unlock. Replay cannot add a second
event, outbox row, receipt, or unlock. Abandonment never settles or unlocks.

## Evidence and limits

Unit golden vectors cover happy, corrective, partial-abandonment, and terminal
replay. Disposable PostgreSQL tests cover duplicate/changed replay, stale and
concurrent commands, statement-boundary rollback, observed command-versus-claim
and command-versus-deletion parent-lock winners, claim continuation, deletion
inventory, unequal existing-player revision rebases, both same-key command
winners, stale new-key contention, and settlement/unlock atomicity. The locally
built production server proves guest start, signed claim, acknowledged player
continuation, settlement, exact replay, and browser-chunk separation.

This ADR does not claim a browser service UI, reviewed final copy/art, wallet
SDK or network integration, keepsake contract, worker, analytics, rate-limit
infrastructure, durable TLS/proxy deployment, device proof, human usability, or
public availability.
