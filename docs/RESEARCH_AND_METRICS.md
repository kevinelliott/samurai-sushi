# Research and Metrics Protocol

## 1. Metric contract

- **Started shift:** `service_started` after the threshold screen, unique by
  participant and study session.
- **First successful serve:** first `order_served` with valid recipe and no
  facilitator intervention; duration begins at `service_started`.
- **Settled shift:** `service_settled` after all three authored orders reach a
  terminal served/recovered state and the close ledger renders.
- **Independent completion:** settled shift with no facilitator action after the
  initial scripted introduction. Clarifying a study question does not count;
  pointing to a control or explaining a rule does.
- **Second-shift behavior:** a new `service_started` by the same participant
  within 24 hours after the replay/harder-order offer. CTA click alone does not
  count.
- **Enjoyment:** post-shift response to “I enjoyed this shift” on a five-point
  scale. Report distribution and share ≥4; do not merge it into completion.
- **Comprehension:** participant explains prepare → assemble → plate → serve and,
  for wallet tests, identifies network, public data, fee, finality, and no
  promised financial return from a scored rubric.

Production north star is weekly unique players with at least one settled shift,
reported alongside repeat-shift rate, recipe breadth, sampled enjoyment, and
comprehension. Wallet connection, transaction count, volume, and time spent are
diagnostics, never primary success measures.

## 2. Formative study

Eight first-time participants:

- two cozy/service-game players;
- two pixel/indie-game players;
- two crypto-curious players with little Tezos experience;
- two participants who regularly use screen reader, switch/assistive input,
  magnification, reduced motion, or another relevant access setup.

Categories may overlap, but the study report states the actual mix, devices,
prior wallet experience, recruitment source, exclusions, compensation, and any
facilitator intervention. All eight must identify the next action, environment,
and spend/no-spend state in the formative flow; failures drive iteration rather
than statistical claims.

## 3. Validation study

Twenty-four first-time participants, recruited outside the immediate project
team:

- at least eight cozy/service/crafting players;
- at least six pixel/indie players;
- at least six wallet-naive or wallet-curious players;
- at least four participants using relevant assistive technology;
- at least eight mobile-primary and eight desktop-primary participants.

One person may satisfy multiple cells. Report every denominator and missing/
abandoned session; do not silently exclude failures. Targets:

- at least 20/24 independently settle the shift;
- median time to first successful serve <3 minutes;
- at least 15/24 begin a second shift within 24 hours;
- at least 18/24 explain the core loop correctly;
- all 24 participants receive the same post-`SETTLED` ownership review and count
  in the comprehension denominator, including abandonment or refusal; at least
  17/24 (the ceiling of 70%) pass the onchain comprehension rubric and 24/24
  state that test assets have no promised value. A preregistered, balanced 12
  participants may continue to actual test-wallet signature for transaction
  lifecycle research, but signature participation does not change the 24-person
  comprehension denominator.

Small samples are directional. Publish raw counts and confidence intervals where
appropriate; do not present them as market validation.

## 4. Instrumentation

Events carry pseudonymous study/session ID, content version, device class,
accessibility settings category, event name, monotonic client time, server time
when available, order/step ID, result code, and facilitator-intervention flag.
Do not collect wallet address in gameplay analytics. Wallet study data uses a
separate consented join key and minimum retention.

Required events: threshold viewed, service started, order offered/accepted,
step attempted/completed/recovered, order served, ledger viewed, service settled,
replay offered, second service started, ownership explainer viewed, wallet review
opened, request submitted/rejected/cancelled, included/confirmed/finalized/
failed/reorged, comprehension scored, and enjoyment response.

## 5. Accessibility matrix

Verify at minimum:

- keyboard-only and visible focus;
- screen reader on one desktop and one mobile combination;
- switch/assistive input on a physical device or representative hardware;
- reduced motion with functional parity;
- persisted sound, music, shake, flashing, and motion controls;
- 200% browser zoom and OS text scaling;
- 320 and 390 CSS px plus on-screen keyboard and safe-area insets;
- touch target and pointer alternatives;
- one physical iOS-class and one physical Android-class mobile rehearsal.

Automated axe/contrast/overflow tests supplement but do not replace these
journeys. Record device/OS/browser/assistive-technology versions and exact
release commit.

## 6. Catalog comprehension study

Before the 12-dish alpha gate, run a separate eight-person content study using
grayscale and reduced-motion variants. All eight must distinguish sashimi from
nigiri, locate raw/cooked state and contains/may-contain allergen facts, and
explain that the game is not food-safety guidance. At least seven of eight must
distinguish the tested roe vessels and roll-family structures using label plus
silhouette rather than hue. Record every confusion pair and revise art/copy;
this formative threshold is not market validation.

Before the 24-dish public-launch gate, repeat with the defined 24-person
validation cohort. Report family/species/cut confusion matrices, raw/allergen
fact-finding success, assistive-technology results, and performance with the
full cookbook. Catalog breadth MUST NOT worsen first-service completion or
median first-serve time beyond the existing product gates.

## 7. Reporting

The report includes protocol deviations, recruitment, sample, denominators, raw
counts, medians/distributions, intervention log, accessibility matrix, failed
journeys, participant quotes within consent, and exact build/deployment state.
Source/build evidence, deployed runtime, authenticated wallet proof, cultural
review, and device evidence remain separate.
