# Samurai Sushi Product Requirements Document

## 1. Summary

Samurai Sushi is a guest-first, responsive pixel sushi-counter game. Its first
release proves that preparing and serving a short evening shift is enjoyable
without a wallet. After the shift, a player may optionally connect a Tezos
wallet and record one non-financial service keepsake on Shadownet.

## 2. Problem

Many crypto games make custody, acquisition, and speculative inventory the
first interaction. That asks players to understand infrastructure before the
game earns their interest and makes failures capable of erasing the emotional
result. Samurai Sushi reverses the order: a complete service experience first,
optional provenance second.

## 3. Goals

- Deliver a satisfying, comprehensible 8–12 minute service.
- Teach prepare → assemble → plate → serve through play.
- Make accuracy, pacing, presentation, and hospitality legible.
- Preserve progress through wallet rejection, delay, outage, reload, and
  account/network changes.
- Demonstrate one truthful Shadownet receipt after play.
- Establish a distinct, culturally reviewed pixel sushi-counter identity.

## 4. Non-goals

- Mainnet launch or production token economy.
- Marketplace, trading, staking, yield, paid loot, or financial return.
- DER utility or consumptive Dos Esposas interoperability.
- Procedural recipes, public leaderboards, PvP, guilds, or live-ops seasons.
- Native mobile applications.

## 5. Primary journey

1. **Threshold:** the player sees “Your counter opens tonight,” chooses **Start
   first shift**, and enters without a wallet.
2. **Open:** the player lifts the shop curtain, lights the counter, and receives
   a clear three-order service goal.
3. **Prepare:** a forgiving tutorial teaches rice preparation and topping
   selection with select/place controls.
4. **Craft:** the player makes kappa maki, tamago nigiri, and salmon nigiri
   through authored station steps.
5. **Serve:** three guests respond to accuracy, pacing, and one presentation
   choice; feedback is textual and non-punitive.
6. **Close:** the player sees a service ledger, a small restoration choice, and
   replay/continue options.
7. **Optional ownership:** the player may connect a wallet, review exact
   network/contract/data/fee/finality, and record a service keepsake.

## 6. Functional requirements

### SS-FR-001 Guest service

- The player MUST start and complete the full MVP without a wallet.
- The session MUST contain three authored orders and an explicit close state.
- Pause, resume, abandon, retry, and mistake recovery MUST be supported.
- A failed dish MUST become a recoverable staff-meal outcome or retry, never an
  irreversible loss of a foreign or scarce asset.

### SS-FR-002 Orders and preparation

- Every order MUST show dish, required ingredients, station sequence, dietary
  tags, patience/pacing rule, and optional preference before acceptance.
- Every station MUST support keyboard, touch, and pointer without a drag-only
  dependency.
- Duplicate step input MUST be idempotent.
- Timing MAY influence service feedback but MUST NOT use an essential window
  shorter than five seconds in MVP.

### SS-FR-003 Results and progression

- Service feedback MUST separate accuracy, pacing, presentation, and
  hospitality without public scoring or financial value.
- The close ledger MUST persist locally/server-side independently of wallet
  state.
- MVP progression MUST be non-transferable and MUST NOT be redeemable or priced.
- The first restoration choice MUST be cosmetic only.

### SS-FR-004 Optional wallet

- No connect CTA, wallet request, or ownership branch may appear until the
  service reaches `SETTLED`. The opening MAY offer a non-interactive **How
  ownership works** explainer.
- Before signature, the review MUST show account, network, contract, entrypoint,
  exact payload, estimated fee or unavailable reason, reversibility, and what
  the receipt does and does not prove.
- The wallet boundary MUST revalidate the complete dispatch tuple—wallet runtime
  generation, session revision, source account, chain ID, permission scope,
  destination, entrypoint, attached mutez amount, canonical payload bytes,
  manifest hash, intent ID, and expiry—immediately before dispatch with no
  intervening await. Any mismatch produces zero transport/send calls.
- Submission MUST NOT be presented as confirmation.

### SS-FR-005 Receipt lifecycle

Required aggregate/attempt states and legal transitions are normative in
[`DOMAIN_SPEC.md`](DOMAIN_SPEC.md), including `dropped`, `replaced`,
`confirmed`, `finalized`, and compensating `reorged` behavior.

- Only confirmed chain evidence may settle the onchain receipt.
- Reload and reconnect MUST restore the truthful latest state.
- Duplicate user/API/indexer events MUST NOT create duplicate keepsakes.
- Failure copy MUST say what happened, what remains safe, and the next action.

### SS-FR-006 Interoperability

- MVP MUST NOT transfer, burn, lock, wrap, bridge, or consume Dos Esposas
  assets.
- A later read-only recognition pilot MAY accept individually reviewed full
  asset identities.
- Shared name, slug, symbol, image, or culinary meaning MUST NOT enable an item.
- DER MUST NOT be an input, output, fee, gate, score, or progression reward in
  MVP.

## 7. Content requirements

- One shop room, one counter keeper, three guests.
- Three MVP dishes and the ingredients necessary to teach them.
- Three customer story beats and one persistent consequence each.
- Three restoration choices.
- Plain-English glossary on first use of Japanese culinary terms.
- Named cultural/culinary review for title, setting, recipes, terminology,
  clothing, signage, audio, and seasonal imagery before public release.

## 8. Experience requirements

- First meaningful input within ten seconds.
- First successful serve in under three minutes for the median first-time user.
- No page-level horizontal overflow at 320 CSS px or 200% zoom.
- WCAG 2.2 AA; 44×44 CSS px minimum targets; visible focus; reduced-motion
  parity; no color/sound/motion-only state.
- Environment (`Practice`, `Testnet`, `Mainnet`) and wallet truth remain readable
  on every signing-capable screen.

## 9. Metrics

North star: **weekly settled shifts**, paired with sampled post-shift enjoyment
and comprehension. A shift counts only when the service reaches `SETTLED`.

Foundation cohort targets:

- ≥80% start guest mode without assistance.
- ≥80% complete the three-order service without facilitator help.
- ≥60% begin a second shift within 24 hours when replay/harder order is offered.
- ≥75% can explain the core loop in one sentence.
- ≥70% of wallet-path testers explain the optional write and no promised return.
- Zero testers believe Shadownet items promise future value.

Wallet-connect conversion and transaction count are diagnostic only.

The exact cohort, denominator, instrumentation, satisfaction item, and
confidence/reporting rules are normative in
[`RESEARCH_AND_METRICS.md`](RESEARCH_AND_METRICS.md).

## 10. Release gates

- Product gate: completion, comprehension, replay, and cultural review targets.
- Accessibility gate: automated checks plus keyboard, screen reader,
  switch/assistive-input, reduced-motion, control-persistence, 200% zoom,
  safe-area/on-screen-keyboard, and physical-device journeys.
- Wallet gate: account/network/scope/session/payload race tests prove zero stale
  dispatch.
- Contract gate: reproducible build, exact manifest, property/invariant tests,
  no production faucet/test mint, and no unresolved critical/high review finding.
- Deployment gate: exact release commit plus exact Shadownet manifest journey.
- Claim gate: no financial promise or unverified availability/compatibility.

Passing source tests does not establish deployment, authenticated wallet smoke,
mainnet readiness, cultural approval, or physical-device evidence.
