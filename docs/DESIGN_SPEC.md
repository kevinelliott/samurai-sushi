# Experience and Visual Design Specification

## 1. Direction: The Counter Ledger

Samurai Sushi is an operate-mode pixel service game. The interface feels like a
working kitchen pass: order chits, ingredient trays, a prep plane, service
stamps, a bell, and a restrained ledger. It must never read as a crypto
dashboard wearing Japanese decoration.

The first viewport is the counter itself: order rail, active prep surface, and
tray/receipt rail. **Start first shift** is unmistakable. Wallet/network truth is
visible but secondary until relevant.

This design specification is pre-implementation. A durable root `DESIGN.md`
must be documented from the built and visually reviewed system, not from intent
alone.

## 2. Relationship to Dos Esposas

Inherit family grammar, not skin.

Keep strong pixel silhouettes, hard-edged structure, tactile press states,
restaurant-specific language, candid network/custody truth, explicit review,
receipts, keyboard access, and reduced-motion parity.

Replace the cantina palette, food-machine hero, exact navigation/cards,
Mexican imagery, voice, logo, mascot, texture, and page composition. With
wordmarks hidden, the two products MUST remain distinguishable.

## 3. First-session UX

1. **Threshold:** “Your counter opens tonight.” Primary: **Start first shift**.
   Secondary: **How ownership works**. No wallet connection action appears.
2. **Order:** one pinned order chit shows customer need, ingredients, station
   sequence, and success condition. No lore modal.
3. **Mise en place:** relevant ingredients begin on the tray. Teach
   select → inspect → place; no drag-only interaction.
4. **Craft:** discrete station animation confirms each choice and exposes the
   next state.
5. **Serve:** a short authored pass animation leads to guest feedback.
6. **Close:** the service ledger, restoration choice, replay, and continue.
7. **Wallet doorway:** only after the service reaches `SETTLED`, local play
   remains primary. The optional write uses literal review and a distinct
   confirmation lifecycle.

Targets: input in ten seconds, first serve in under three median minutes, full
MVP in 8–12 minutes.

## 4. Information architecture

Primary navigation:

1. **Counter** — order, prep, plate, serve, result.
2. **Stores** — ingredients and dishes, filterable by family, species/product,
   dietary/allergen tag, season, provenance, and readiness.
3. **Recipes** — learned recipes, dish families, exact components, raw/cooked
   state, allergen facts, and station sequences.
4. **Ledger** — service records, pending operations, receipts, failures.

Market is deferred from MVP. A future Market may replace Recipes in the primary
four only after acquisition is a validated feature.

Persistent status on signing-capable surfaces: environment/network, wallet plus
short account with copy affordance, pending-operation count, and current order.

Desktop ≥1180 px: 240–280 px order rail / fluid 560–760 px prep plane /
280–340 px tray rail. Tablet 768–1179 px: order + prep, tray as sheet. Mobile
<768 px: single task plane, sticky order strip, four-item bottom navigation.
At ≤480 px, review and receipt are full-width sheets above safe-area insets.

## 5. Cultural stance

Express discipline, hospitality, timing, and ingredient care. Avoid random
kanji, faux calligraphy, rising-sun fields, katana controls, helmets, geisha
imagery, “honor” meters, exoticized mysticism, and costume-Japan shorthand.

English is the source of truth until reviewed. Japanese terms are accurate,
useful, and glossed on first use. Language, seals, garments, architecture,
food depiction, signage, seasonal references, and audio require named review.

## 6. Color

Full-palette strategy for a warm evening counter:

| Token | Value | Role |
| --- | --- | --- |
| Sumi | `#171611` | text, rules, deepest shadow |
| Washi | `#F4E9D2` | main field |
| Rice | `#FFF8E8` | raised working surface |
| Nori | `#163A2A` | primary action, confirmed state |
| Vermilion | `#C83B2D` | active order, destructive warning |
| Indigo | `#24445E` | focus, links, information |
| Salmon | `#EF7D64` | food-art accent, not default UI text |
| Brass | `#D6A43B` | earned/progression accent, not currency hype |

Key reviewed contrast pairs from the design lane meet AA for their intended
roles; implementation MUST recalculate actual component/state combinations.
Color never carries meaning alone.

## 7. Typography and material

Body/live UI: highly legible system sans with `Noto Sans JP` fallback. Tabular
data: true monospace. A custom bitmap face may appear only in short labels at
≥18 px. Body copy, addresses, probabilities, and errors are never pixel-font.

Materials: dark lacquer rails, pale cutting-board planes, washi chits,
nori-green action blocks, 2 px sumi borders, 4 px step shadows, 0–4 px radii.
No gradients, glass, floating SaaS cards, neon chain motifs, or generic samurai
ornaments.

## 8. Pixel asset grammar

- Author on a 16 px base grid; UI icons 16/24, ingredients 32×32, dishes 64×64,
  characters 64×64 or 96×96, environment tiles 16×16.
- Export lossless PNG/WebP with alpha; render only at integer scale with
  nearest-neighbor interpolation; UI text stays vector.
- Top-left light source, one-pixel source outline, two or three value steps per
  material, controlled family palette.
- Every ingredient is recognizable by silhouette at 1× and by a text label.
- Sashimi uses cut geometry plus skin/fat/texture cues; roe uses bead size,
  clustering, vessel, and label; hosomaki, futomaki, uramaki, and temaki use
  distinct cross-section or fold silhouettes. None may be a color-only swap.
- Core components: order chit, ingredient tile, prep slot, serving tray, recipe
  strip, service stamp, network plaque, wallet seal, receipt drawer, status
  lantern.

## 9. Motion

Ingredients step onto the board, prep resolves in 3–5 frames, the dish slides
to the pass, and the service stamp lands once. UI feedback is 80–160 ms; serve
moments 400–700 ms. Indeterminate waits pair limited motion with text and elapsed
state. Reduced motion uses immediate swaps and a static result stamp.

Sashimi uses a rice-free slice → arrange → plate sequence. Gunkan wraps then
fills; temaki folds then fills; neither reuses a cylindrical roll animation.
Reduced motion presents the same ordered states as labeled static swaps.

## 10. State and copy contract

Design all of: first-run, guest, disconnected, connecting, wrong network, empty,
loading, partial data, ready, insufficient ingredients, review, wallet requested,
submitted, included, confirming, success, cancelled, rejected, timeout,
contract mismatch, stale indexer, reorg, and unavailable.

Food language frames tasks but never hides chain facts. Errors say what happened,
what remains safe, and what to do next. Example: “Wallet request cancelled.
Nothing was spent. Review and try again.”

Ingredient and recipe facts show full common name, dish family, species/product
and cut/preparation when relevant, raw/cooked game state, contains/may-contain
allergens, season/availability evidence state, and provenance/compatibility.
They state that game content is not real-world food-safety guidance.

Receipts include account, network, contract/version, exact payload or asset
deltas, fee, operation hash, timestamps, confirmations, manifest, and finality.

## 11. Accessibility and responsive requirements

- WCAG 2.2 AA; keyboard, switch, touch, and pointer parity.
- Drag has select/place alternatives.
- Focus order follows order → ingredients → prep → review → serve.
- Dialogs/sheets trap focus and return it to the invoker.
- Targets ≥44×44 CSS px; visible 3 px Indigo focus with contrasting offset.
- Live regions announce wallet/submission/result once; decorative frames are
  hidden from assistive technology.
- 200% zoom and user font scaling; addresses/hashes wrap and copy safely.
- Independent controls for sound, music, shake, flashing, and motion.
- No horizontal page overflow or safe-area obstruction at 320 px.

## 12. Design acceptance IDs

- `SS-UX-001`: walletless first service completes in 8–12 minutes.
- `SS-UX-002`: all eight formative participants identify next action,
  environment, and whether anything will be spent; the 24-person validation
  cohort uses the thresholds in `RESEARCH_AND_METRICS.md`.
- `SS-UX-003`: no wallet request precedes complete literal review.
- `SS-UX-004`: pending action cannot duplicate; reload restores truth.
- `SS-IA-001`: Counter, Stores, Recipes, Ledger are one action away.
- `SS-VIS-001`: wordmark-hidden distinction from Dos Esposas.
- `SS-VIS-002`: integer pixel scaling and silhouette tests pass.
- `SS-VIS-003`: at 1× and without color, players can distinguish sashimi from
  nigiri, roe vessels, and hosomaki/futomaki/uramaki/temaki structures by
  silhouette plus label.
- `SS-CONTENT-001`: ingredient and recipe facts expose raw/cooked state,
  allergens, exact culinary identity, and unknown/unsupported evidence states
  without presenting real-world food-safety instruction.
- `SS-CULT-001`: culturally specific production assets have recorded signoff.
- `SS-A11Y-001`: no serious/critical automated issues plus manual journeys.
- `SS-A11Y-002`: contrast, targets, zoom, 320 px, and non-color state pass.
- `SS-A11Y-003`: switch/assistive input, reduced-motion parity, persisted
  controls, 200% zoom, on-screen keyboard/safe areas, and physical-device
  journeys pass the matrix in `RESEARCH_AND_METRICS.md`.
- `SS-RWD-001`: no overflow, clipped identity, or safe-area overlap at 320,
  390, 768, 1024, and 1440 px.
- `SS-PERF-001`: first-service sprites preload without layout shift; other
  rooms/items lazy-load.
