# Tezos Localnet Lifecycle

This is the normative network-development contract for Samurai Sushi. The
shared runtime lives in the sibling workspace repository
`REPOS/project-crypt-tezos-localnet`. Samurai Sushi pins its accepted runtime
commit and entrypoint in `.tezos-runtime.json`; the application refuses to run
an unapproved or dirty sibling checkout. The walletless Phase 0 shell exists,
but no application contract or deployment manifest exists yet.

## Environment boundary

| Environment | Use | Selection | Indexer |
|---|---|---|---|
| Localnet | ordinary development, contract iteration, builds, and integration tests | default project commands | none in the base runtime |
| Shadownet | final rehearsal of an exact locally verified candidate | explicit `*:shadownet` commands | pinned Shadownet TzKT |
| Mainnet | outside the development harness and outside MVP | unsupported | unsupported |

The application must reject missing or unknown networks, Mainnet, unexpected
chain IDs, non-loopback Localnet RPCs, competing environment files, and any
server/browser-visible mismatch. Localnet indexer-dependent features must
return a controlled unavailable state unless a genuinely local indexer is
added and independently validated.

Project `.env*` files may hold unrelated application values but must not define
`TEZOS_*` or `NEXT_PUBLIC_TEZOS_*`; `.env.example` is documentation only. The
project runner scans the repository and app root before every raw child and
revalidates the injected profile in application code.

The web route renders dynamically from the validated start-process environment.
A production artifact built under one supported profile must display the other
profile when explicitly started there; a baked build-time network identity is a
release-blocking profile mismatch.

## One-time workstation setup

```bash
cd REPOS/project-crypt-tezos-localnet
npm test
npm run localnet:up
npm run localnet:verify
```

Expected Localnet identity:

- RPC: `http://127.0.0.1:8732`
- chain: `NetXtJqPyJGB6Pc`
- deterministic fixtures: `alice` and `bob`
- public indexer: none

Never fund or import the sandbox fixture keys on Shadownet or Mainnet.

## Required implementation commands

Framework commands remain behind raw names. Every public project command first
checks the exact clean runtime pin, then invokes the shared profile wrapper;
every raw child performs the project-side validation again:

```json
{
  "scripts": {
    "dev": "tsx scripts/run-network-command.ts localnet dev",
    "build": "tsx scripts/run-network-command.ts localnet build",
    "start": "tsx scripts/run-network-command.ts localnet start",
    "test:integration": "tsx scripts/run-network-command.ts localnet test:integration",
    "dev:shadownet": "tsx scripts/run-network-command.ts shadownet dev",
    "build:shadownet": "tsx scripts/run-network-command.ts shadownet build",
    "start:shadownet": "tsx scripts/run-network-command.ts shadownet start",
    "test:shadownet": "tsx scripts/run-network-command.ts shadownet test:integration"
  }
}
```

There must be no Mainnet development script. Contract origination and migration
commands follow the same split: Localnet by default, Shadownet only by an
explicit final-test name.

No contract/address command may be added until the shared consumer registry
marks Samurai Sushi integrated, `namespace-init samurai-sushi` has bound its
identity to the current Localnet generation, and `manifest-register` has
recorded an immutable project manifest. Runtime readiness must report that
identity and manifest fresh. Reset makes all earlier addresses and manifests
stale before Docker state changes.

The application adapter is registered as integrated in shared runtime revision
`617eb06a8a5a04b6c0b2446ac1f19764fb30de66`, but address-bearing readiness is
intentionally false while no contract exists. Before any such command ships,
run `node scripts/consumers.mjs ready samurai-sushi` from that exact clean
shared-runtime checkout; it must pass against the live loopback chain.

## Daily development

```bash
cd REPOS/project-crypt-tezos-localnet
npm run localnet:up
npm run localnet:verify

cd ../samurai-sushi
npm run dev
```

The application must display `localnet` and the expected chain identity.
Contract addresses, manifests, generated bindings, and fixtures belong under a
Samurai Sushi Localnet namespace; another project's local address is not valid
Samurai Sushi deployment evidence.

## Preserve, inspect, or reset

```bash
cd REPOS/project-crypt-tezos-localnet
./scripts/localnet health
./scripts/localnet accounts
./scripts/localnet stop
./scripts/localnet up
./scripts/localnet verify
```

`stop` preserves chain state. The sandbox is shared by supported restaurant
projects, so an intentional reset discards every consumer's local contracts and
operations. Coordinate first, then use:

```bash
./scripts/localnet reset --yes
./scripts/localnet up
./scripts/localnet verify-genesis
```

After reset, the shared generation authority first invalidates every prior
consumer identity and manifest. Reinitialize the Samurai Sushi namespace,
re-originate its contracts, and register a new manifest for the new generation.
Never reuse discarded addresses as current evidence.

## Promote an exact candidate to Shadownet

1. Record the exact Samurai Sushi commit and require a clean worktree.
2. Record the `.tezos-runtime.json` commit, require that sibling checkout exact
   and clean, and include both commits in candidate evidence.
3. Run its full local tests, build, contract scenarios, and Localnet journey.
4. Verify the shared Localnet and the read-only Shadownet identity:

   ```bash
   cd REPOS/project-crypt-tezos-localnet
   npm test
   npm run localnet:verify
   npm run shadownet:verify
   ```

5. Run only the explicit Samurai Sushi Shadownet commands. Supply signing input
   only as `SAMURAI_SHADOWNET_SIGNER_*` to the individual command. The runner
   rejects Localnet signer variables, generic child-only signer variables, and
   known sandbox fixture keys. The shared profile maps only the selected
   Shadownet namespace into the child process.
6. Record chain ID `NetXsqzbfFenSTS`, both source/runtime commits, the exact
   deployment manifest, contract addresses, operation hashes, tests, and
   authenticated wallet journey.

A local green build, read-only chain check, source commit, deployed runtime,
and authenticated wallet journey are different evidence. Report each
separately. Never infer Mainnet readiness from Shadownet success.

## Return to Localnet

Stop the explicit Shadownet process, remove command-scoped
`SAMURAI_SHADOWNET_SIGNER_*` values from the shell, resume the shared chain, and
launch the ordinary command. A Localnet command rejects any remaining
Shadownet signer variable before the shared runner or app starts:

```bash
cd REPOS/project-crypt-tezos-localnet
npm run localnet:up

cd ../samurai-sushi
npm run dev
```

Before continuing, confirm the UI and logs show Localnet and contain no
Shadownet RPC, TzKT endpoint, contract address, or credential.

## Adoption acceptance tests

Implementation is not considered adopted until tests prove:

- ordinary `dev`, `build`, `start`, deployment, and integration commands select
  Localnet;
- explicit `dev`, `build`, `start`, and test final-test commands select the
  pinned Shadownet profile;
- Mainnet, missing, unknown, or mismatched configuration stops before startup;
- server/browser-visible environment values match exactly;
- an unapproved or dirty shared runtime revision stops before its profile code
  runs; approved code executes from an archived exact-commit tree so checkout
  drift after validation cannot change it; candidate evidence records that
  runtime revision;
- production build/start pairs in both cross-profile directions render only the
  start-time network and chain identity;
- project `.env*` Tezos keys stop the raw child; cross-profile signers, browser
  secrets, and Localnet fixture material on Shadownet fail before spawn;
- every Localnet indexer-backed path fails closed and leaks no public endpoint;
- before contract work, integrated consumer readiness requires a current
  generation identity plus fresh registered manifest; a coordinated reset
  invalidates every earlier manifest/address and only reinitialization plus a
  re-originated registered manifest restores readiness; and
- returning from Shadownet restores the Localnet identity without copied public
  addresses or credentials.
