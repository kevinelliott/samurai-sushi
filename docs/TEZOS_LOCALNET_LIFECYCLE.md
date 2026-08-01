# Tezos Localnet Lifecycle

This is the normative network-development contract for Samurai Sushi. The
shared runtime lives in the sibling workspace repository
`REPOS/project-crypt-tezos-localnet`. Samurai Sushi is currently specification
only, so the command names below are implementation acceptance requirements,
not claims that an application or contract already exists.

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

When the Samurai Sushi application is scaffolded, preserve the framework
commands behind explicit raw names and wrap every ordinary chain-aware command:

```json
{
  "scripts": {
    "dev": "node ../project-crypt-tezos-localnet/scripts/profile.mjs localnet -- npm run dev:raw",
    "build": "node ../project-crypt-tezos-localnet/scripts/profile.mjs localnet -- npm run build:raw",
    "start": "node ../project-crypt-tezos-localnet/scripts/profile.mjs localnet -- npm run start:raw",
    "test:integration": "node ../project-crypt-tezos-localnet/scripts/profile.mjs localnet -- npm run test:integration:raw",
    "dev:shadownet": "node ../project-crypt-tezos-localnet/scripts/profile.mjs shadownet -- npm run dev:raw",
    "build:shadownet": "node ../project-crypt-tezos-localnet/scripts/profile.mjs shadownet -- npm run build:raw",
    "test:shadownet": "node ../project-crypt-tezos-localnet/scripts/profile.mjs shadownet -- npm run test:shadownet:raw"
  }
}
```

There must be no Mainnet development script. Contract origination and migration
commands follow the same split: Localnet by default, Shadownet only by an
explicit final-test name.

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

After reset, re-originate Samurai Sushi contracts and regenerate its Localnet
manifest. Never reuse discarded addresses as current evidence.

## Promote an exact candidate to Shadownet

1. Record the exact Samurai Sushi commit and require a clean worktree.
2. Run its full local tests, build, contract scenarios, and Localnet journey.
3. Verify the shared Localnet and the read-only Shadownet identity:

   ```bash
   cd REPOS/project-crypt-tezos-localnet
   npm test
   npm run localnet:verify
   npm run shadownet:verify
   ```

4. Run only the explicit Samurai Sushi Shadownet commands. Supply a separate
   test-only wallet to the individual command that needs it.
5. Record chain ID `NetXsqzbfFenSTS`, the exact deployment manifest, contract
   addresses, operation hashes, tests, and authenticated wallet journey.

A local green build, read-only chain check, source commit, deployed runtime,
and authenticated wallet journey are different evidence. Report each
separately. Never infer Mainnet readiness from Shadownet success.

## Return to Localnet

Stop the explicit Shadownet process, remove command-scoped test credentials
from the shell, resume the shared chain, and launch the ordinary command:

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
- explicit final-test commands select the pinned Shadownet profile;
- Mainnet, missing, unknown, or mismatched configuration stops before startup;
- server/browser-visible environment values match exactly;
- every Localnet indexer-backed path fails closed and leaks no public endpoint;
- stop/resume preserves Samurai Sushi state and a coordinated reset regenerates
  its exact Localnet manifest; and
- returning from Shadownet restores the Localnet identity without copied public
  addresses or credentials.
