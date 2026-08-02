# Localnet Service Receipt Authority

Phase 2A defines `SAMURAI_SUSHI_RECEIPT_V1`, a narrow Localnet rehearsal
contract and pure TypeScript permit model. It is a non-transferable,
non-financial service keepsake ledger. It is not FA2, a currency, a reward,
progression, custody, ownership, rarity, a marketplace asset, or DER.

This source slice does not add wallet connection, browser review, signing,
dispatch, receipt intents, a worker/indexer, Shadownet origination, or Mainnet
commands. The merged walletless service remains byte-separate and primary.

## Exact claim

The strongest claim an accepted record supports is:

> This contract accepted one issuer-authorized, unexpired, single-use permit
> for the submitting wallet and the displayed opaque service commitment,
> content version, nonce, payload hash, manifest identity, issuer policy, and
> validity window.

It does not independently verify or reveal the private service. It does not
prove human identity, authorship, skill, score, a real-world purchase or
service, originality, scarcity, rarity, monetary value, or ownership of the
restaurant, dishes, recipes, ingredients, art, or game content. The opaque
commitment is not retrievable content or an availability promise.

`owner` means only the wallet that submitted and holds the immutable ledger
record. Non-transferability is structural: the artifact exposes only
`submit_receipt`, `set_paused`, and `revoke_issuer`. There is no transfer,
operator, approval, balance, burn, delegate, migration, admin reassignment,
mutable metadata, economic, referral, random, or DER entrypoint.

## Private commitment boundary

The server derives `serviceCommitment` only after an exact `SETTLED` first
service:

```text
BLAKE2b-256(
  "SAMURAI_SUSHI_SERVICE_COMMITMENT_V1\\0" ||
  32-byte server nonce ||
  canonical private settled checkpoint bytes
)
```

Only the 32-byte output crosses the public boundary. The nonce, checkpoint,
guest/player identity, orders, choices, dialogue, score, wallet proof, browser
state, accessibility settings, and persistence identifiers remain offchain and
must not enter contract storage, events, public metadata, DOM, logs, browser
storage, bundles, HTML, or RSC output.

## Signed payload and policy

The exact right-combed Michelson payload contains domain/schema, Localnet chain
ID, equal owner/source, destination, entrypoint, zero attached mutez, opaque
commitment, content version, nonce, issuance/expiry, authority-manifest hash,
issuer key ID, and issuer policy version. `PACK(payload)` and BLAKE2b-256 are
pinned by the TypeScript/SmartPy golden vector in
`packages/receipt-authority/fixtures/receipt-permit-v1.json`. The Tezos
signature covers the payload hash.

Admission fails closed on sender, chain, destination, entrypoint, manifest,
mutez, payload hash, signature, pause, revocation, nonce replay, or
`(owner, serviceCommitment)` replay. Time boundaries are half-open:

- `activatesAt <= issuedAt < retiresAt`;
- `issuedAt <= now + 30 seconds`;
- `issuedAt < expiry`, with at most 15 minutes lifetime;
- `now < expiry`; and
- `now < verifyUntil`.

Emergency revocation invalidates outstanding permits immediately. Routine key
retirement stops new issuance but preserves bounded verification until the
pinned `verifyUntil` boundary.

## Public facts

The immutable record contains only owner, opaque commitment, content version,
nonce, payload hash, manifest identity, issuer key/policy identity, and the
issuance/expiry values needed to inspect validation. The `service_receipt`
event is smaller: owner, opaque commitment, content version, nonce, and payload
hash. Uniqueness is replay prevention only; it must never be described as
one-of-one, rare, exclusive, or an edition size.

## Manifest and evidence layers

`contracts/receipt/authority-manifest.json` is the immutable authority identity
used by contract storage and signed permits. It pins chain/profile, privileged
addresses, issuer-policy registry, entrypoint, lifetime/skew, confirmation
threshold, and finality policy. The payload separately signs the exact contract
destination, avoiding any hidden address substitution.

`contracts/receipt/build/deployment-manifest.json` is a source-candidate
envelope. It pins the authority identity plus exact source, Michelson artifact,
initial storage, parameter schema, public fact sets, and forbidden surface. It
states `source-only-not-originated` and therefore contains no address or
operation claim. The generated source binding also holds `null` for both.

After the exact pushed commit is registered and current-generation readiness
passes, the Localnet lifecycle may create a separate runtime deployment binding
that records the registered candidate commit/manifest, generation, address,
origination operation, and verified invocation. Later checkout drift or a new
generation cannot make old evidence current.

## Future player review input, not UI

This model supplies facts for a later post-`SETTLED` review panel: exact account,
Localnet chain, destination/entrypoint, payload and packed bytes/hash, 0 mutez
attached, manifest and issuer identities, validity, confirmation threshold, and
finality policy. Fee estimate/unavailability, wallet runtime, dispatch tuple,
and lifecycle UI belong to a later slice. Phase 2A renders no review drawer,
connect control, fee, signing action, or success ceremony.
