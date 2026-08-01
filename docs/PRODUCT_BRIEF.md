# Samurai Sushi Product Brief

## Purpose

Create a small, joyful sushi-service game whose play stands on its own and
whose optional chain layer makes provenance more legible rather than more
speculative.

## Player promise

> In ten minutes, I can prepare, serve, and remember a tiny meal that feels
> like mine.

## Product thesis

The product is a service game with optional verifiable keepsakes, not an
onchain crafting interface with a service wrapper. The player learns a readable
rhythm—prepare, assemble, plate, serve, reflect—before any wallet prompt.

## Initial audience

1. Craft-and-service players who like compact management and recipe mastery.
2. Pixel-world collectors motivated by meaning and completion rather than
   price.
3. Wallet-curious indie players who value plain-language consent.
4. Tezos and Dos Esposas players as an initial testing community, not the
   long-term product center.

## The first product: Evening Service

One responsive counter experience lasting 8–12 minutes:

1. Enter as a guest and open the counter.
2. Prepare rice and toppings through forgiving station interactions.
3. Fulfill three authored customer orders with escalating constraints.
4. Receive readable feedback on accuracy, pacing, and hospitality.
5. Personalize one small part of the shop.
6. Close the service and inspect the recap.
7. Optionally connect a wallet and record one Shadownet chef's stamp/service
   receipt. Declining never invalidates the completed game.

## Differentiation

- A working sushi counter, not a collectible dashboard.
- Skill and hospitality outcomes, not purchasable randomness.
- Guest-first play, not a wallet wall.
- Exact chain and custody disclosures, not food metaphors hiding consequences.
- A shared culinary-universe possibility with Dos Esposas, but a distinct
  visual world, story, menu, and game loop.

## MVP scope

- One counter, one player character, three guests.
- A three-dish first service—kappa maki, tamago nigiri, and salmon nigiri—plus
  salmon sashimi as an immediate post-service MVP unlock.
- Three essential interaction groups: rice preparation, topping preparation,
  and roll/nigiri assembly plus plating.
- Pause, retry, recovery, reduced-motion, and input parity.
- Local/service recap that survives wallet failure.
- One optional, deterministic, non-financial Shadownet receipt.

A 12-dish alpha and 24-dish public-launch catalog spanning sashimi, nigiri,
gunkan, hosomaki, futomaki, uramaki, temaki, and composed dishes; more guests;
a persistent cookbook; a memento gallery; and read-only Dos Esposas recognition
follow only after the first loop passes its gates. Catalog rules and candidate
ingredients are defined in [`SUSHI_CONTENT_CATALOG.md`](SUSHI_CONTENT_CATALOG.md).

## Success

- At least 80% of the defined 24-person validation cohort complete all three
  orders without facilitator help.
- Median time to first successful serve is under three minutes.
- At least 60% begin a second shift within 24 hours when offered replay or a
  harder order.
- At least 70% can explain the optional onchain write and its lack of promised
  financial return before signing.
- Wallet rejection, wrong network, delay, reload, or indexer lag never erases
  service progress or falsely reports success.
- Cultural review reports no launch-blocking naming, imagery, language, audio,
  or food-practice issues.

Sampling, instrumentation, denominators, and reporting follow
[`RESEARCH_AND_METRICS.md`](RESEARCH_AND_METRICS.md).

## Guardrails

Never promise appreciation, yield, liquidity, resale, scarcity-derived value,
or future utility. Never call an external ingredient or DER compatible until
its full identity and policy are reviewed and pinned. Do not optimize for wallet
connect rate, transaction count, or traded volume as the product north star.
