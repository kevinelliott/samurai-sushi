# ADR 0001: Application Stack and Network Authority

- Status: adopted for Phase 0
- Date: 2026-07-31
- Scope: workspace, web shell, and development-network command boundary

## Decision

Samurai Sushi uses a pnpm workspace, strict TypeScript, React, and Next.js. The
first code slice is a walletless counter shell plus a pure network-policy
package. It deliberately does not decide persistence, guest identity, wallet
linking, contracts, or content activation.

Ordinary project commands select Localnet. Shadownet is available only through
explicitly named counterparts. Mainnet is absent. The command path has three
authorities, each narrower than the previous one:

1. `.tezos-runtime.json` pins one exact shared-runtime commit and profile
   entrypoint. The project verifies the sibling checkout is at that commit and
   clean before executing its code.
2. The shared runtime injects the selected Localnet or Shadownet profile and
   verifies the live RPC chain identity.
3. `@samurai-sushi/network` revalidates exact server/browser parity, chain, RPC,
   indexer, and secret boundaries inside the project before the raw app command
   can spawn. Tezos keys in project `.env*` files are competing authority and
   fail closed.

Candidate evidence records both the Samurai Sushi commit and the pinned shared
runtime commit. Changing either produces a different candidate.

## Credential boundary

Signing inputs, when a later phase needs them, use only
`SAMURAI_LOCALNET_SIGNER_*` or `SAMURAI_SHADOWNET_SIGNER_*`. The project runner
rejects the inactive profile namespace, rejects browser-visible secret names,
rejects known Localnet fixture material on Shadownet, strips both namespaces,
and maps only the selected values into the child-only `SAMURAI_SIGNER_*`
namespace. The parent shell remains unchanged.

## Generation-bound adoption

This slice has no contract address or manifest. Profile readiness is therefore
sufficient for the walletless shell. Before adding origination, migration,
receipt, address-bearing, or authenticated chain commands, the shared runtime
must register Samurai Sushi as an integrated consumer, initialize its current
generation identity, register an immutable project manifest, and report both
identity and manifest as fresh. A pre-reset generation can never restore
readiness.

## Consequences

- `dev`, `build`, `start`, and integration tests fail if the sibling runtime
  drifts, becomes dirty, or injects a mismatched profile.
- Raw commands are implementation details and still revalidate the injected
  profile and runtime revision.
- The shell can show exact network, chain, and runtime evidence without
  presenting wallet or deployment claims.
- The SS-D-011 persistence/account decision remains open and blocks Phase 1
  persistence work.
