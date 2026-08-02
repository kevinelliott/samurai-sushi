import {
  FIRST_EVENING_CONTENT_VERSION,
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  canonicalEveningServiceBytes,
  createInitialEveningServiceCheckpoint,
  reduceEveningService,
  type EveningServiceCheckpoint,
  type EveningServiceProjectionManifest,
} from "@samurai-sushi/domain/evening-service";
import { createCommandEnvelope, type CommandEnvelope, type GuestSubjectRef, type IdempotencyKey, type JsonObject, type JsonValue } from "@samurai-sushi/domain";
import { compileContentPack } from "./compile";
import { canonicalContentJson, contentHashFor } from "./hash";
import { firstEveningServiceCatalogBundle } from "./fixtures/first-service";
import { salmonSashimiDraftBundle } from "./fixtures/salmon-sashimi";

export interface ServiceVersionedRef extends JsonObject {
  readonly id: string;
  readonly version: number;
}

export interface ServiceCatalogEntityBinding extends JsonObject {
  readonly kind: "component" | "cut-style" | "dish" | "family" | "ingredient" | "recipe" | "species";
  readonly ref: ServiceVersionedRef;
  readonly contentHash: string;
}

export interface ServiceCatalogBinding extends JsonObject {
  readonly packRef: ServiceVersionedRef;
  readonly packContentHash: string;
  readonly contentManifestHash: string;
  readonly artAssetMapHash: string;
  readonly entities: readonly ServiceCatalogEntityBinding[];
}

export interface ServiceArtRequirement extends JsonObject {
  readonly key: string;
  readonly digest: string;
  readonly dimensions: string;
  readonly reviewId: string;
  readonly status: "required-later";
  readonly nonColorIdentity: string;
}

export interface ServiceCopyEntry extends JsonObject {
  readonly key: string;
  readonly text: string;
  readonly reviewId: string;
  readonly status: "review-pending";
}

export interface FirstServiceContentSource {
  readonly schemaVersion: 1;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly reviewReferences: readonly string[];
  readonly firstServiceCatalog: ServiceCatalogBinding;
  readonly salmonSashimiUnlockCatalog: ServiceCatalogBinding;
  readonly copy: readonly ServiceCopyEntry[];
  readonly artRequirements: readonly ServiceArtRequirement[];
  readonly serviceDefinition: typeof FIRST_EVENING_SERVICE_DEFINITION;
}

export interface CompiledFirstServiceContent {
  readonly schemaVersion: 1;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly contentManifestHash: string;
  readonly artAssetMapHash: string;
  readonly serviceHash: string;
  readonly replayHash: string;
  readonly correctiveReplayHash: string;
  readonly abandonmentReplayHash: string;
  readonly newRunReplayHash: string;
  readonly terminalReplayHash: string;
  readonly source: FirstServiceContentSource;
  readonly goldenReplay: readonly JsonObject[];
  readonly correctiveReplay: readonly JsonObject[];
  readonly abandonmentReplay: readonly JsonObject[];
  readonly newRunReplay: readonly JsonObject[];
  readonly terminalReplay: readonly JsonObject[];
  readonly projectionManifest: EveningServiceProjectionManifest;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fixtureEntityBinding(kind: ServiceCatalogEntityBinding["kind"], row: { readonly id: string; readonly version: number; readonly contentHash: string }): ServiceCatalogEntityBinding {
  return { kind, ref: { id: row.id, version: row.version }, contentHash: row.contentHash };
}

const salmonSashimiUnlockCatalog: ServiceCatalogBinding = deepFreeze({
  packRef: { id: salmonSashimiDraftBundle.pack.id, version: salmonSashimiDraftBundle.pack.version },
  packContentHash: salmonSashimiDraftBundle.pack.contentHash,
  contentManifestHash: salmonSashimiDraftBundle.pack.contentManifestHash,
  artAssetMapHash: salmonSashimiDraftBundle.pack.artAssetMapHash,
  entities: [
    ...salmonSashimiDraftBundle.components.map((row) => fixtureEntityBinding("component", row)),
    ...salmonSashimiDraftBundle.cutStyles.map((row) => fixtureEntityBinding("cut-style", row)),
    ...salmonSashimiDraftBundle.dishes.map((row) => fixtureEntityBinding("dish", row)),
    ...salmonSashimiDraftBundle.families.map((row) => fixtureEntityBinding("family", row)),
    ...salmonSashimiDraftBundle.ingredients.map((row) => fixtureEntityBinding("ingredient", row)),
    ...salmonSashimiDraftBundle.recipes.map((row) => fixtureEntityBinding("recipe", row)),
    ...salmonSashimiDraftBundle.species.map((row) => fixtureEntityBinding("species", row)),
  ].sort((left, right) => {
    const leftKey = `${left.kind}:${left.ref.id}@${left.ref.version}`;
    const rightKey = `${right.kind}:${right.ref.id}@${right.ref.version}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }),
});

const compiledFirstServiceCatalog = compileContentPack(firstEveningServiceCatalogBundle);
const firstServiceCatalog: ServiceCatalogBinding = deepFreeze({
  packRef: { id: compiledFirstServiceCatalog.bundle.pack.id, version: compiledFirstServiceCatalog.bundle.pack.version },
  packContentHash: compiledFirstServiceCatalog.bundle.pack.contentHash,
  contentManifestHash: compiledFirstServiceCatalog.bundle.pack.contentManifestHash,
  artAssetMapHash: compiledFirstServiceCatalog.bundle.pack.artAssetMapHash,
  entities: [
    ...compiledFirstServiceCatalog.bundle.components.map((row) => fixtureEntityBinding("component", row)),
    ...compiledFirstServiceCatalog.bundle.dishes.map((row) => fixtureEntityBinding("dish", row)),
    ...compiledFirstServiceCatalog.bundle.families.map((row) => fixtureEntityBinding("family", row)),
    ...compiledFirstServiceCatalog.bundle.ingredients.map((row) => fixtureEntityBinding("ingredient", row)),
    ...compiledFirstServiceCatalog.bundle.recipes.map((row) => fixtureEntityBinding("recipe", row)),
    ...compiledFirstServiceCatalog.bundle.species.map((row) => fixtureEntityBinding("species", row)),
  ].sort((left, right) => {
    const leftKey = `${left.kind}:${left.ref.id}@${left.ref.version}`;
    const rightKey = `${right.kind}:${right.ref.id}@${right.ref.version}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }),
});

function fail(message: string): never { throw new Error(`Invalid first-service content: ${message}`); }

function assertFirstServicePreparationGraph(): void {
  const bundle = compiledFirstServiceCatalog.bundle;
  const preparedRice = bundle.components.find((row) => row.id === "prepared-sushi-rice" && row.version === 1);
  if (!preparedRice || preparedRice.ingredientRef.id !== "sushi-rice" || preparedRice.ingredientRef.version !== 1) {
    fail("prepared sushi rice must bind sushi-rice@1 as its primary ingredient");
  }
  const inputs = preparedRice.preparationInputs ?? [];
  if (inputs.length !== 1
    || inputs[0]?.ingredientRef.id !== "rice-vinegar"
    || inputs[0]?.ingredientRef.version !== 1
    || inputs[0]?.stationStep.station !== "rice-hearth"
    || inputs[0]?.stationStep.action !== "season") {
    fail("prepared sushi rice must bind exactly rice-vinegar@1 to the rice-hearth season action");
  }
  for (const order of FIRST_EVENING_SERVICE_DEFINITION.orders) {
    const recipe = bundle.recipes.find((row) => row.dishRef.id === order.dishId && row.dishRef.version === 1);
    if (!recipe) fail(`order ${order.id} has no exact first-service recipe`);
    const riceAmount = recipe.exactComponentAmounts.find((amount) => amount.componentRef.id === preparedRice.id && amount.componentRef.version === preparedRice.version);
    if (!riceAmount) fail(`order ${order.id} does not resolve the prepared-rice dependency graph`);
  }
}

function assertBoundedContent(input: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 8192 || depth > 32) fail("source exceeds structural bounds");
    if (typeof value === "string" && value.length > 4096) fail("source contains an oversized string");
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) fail("source contains a cycle or object alias");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 512) fail("source contains an oversized array");
      value.forEach((child) => stack.push({ value: child, depth: depth + 1 }));
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("source must contain plain objects");
      const entries = Object.entries(value);
      if (entries.length > 96) fail("source contains an oversized object");
      entries.forEach(([, child]) => stack.push({ value: child, depth: depth + 1 }));
    }
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 524_288) fail("source exceeds the byte bound");
}

function replayCommand(
  subject: GuestSubjectRef,
  idempotencyKey: string,
  revision: number,
  commandName: string,
  payload: JsonObject,
): CommandEnvelope<JsonObject> {
  return createCommandEnvelope({
    schemaVersion: 1,
    subject,
    idempotencyKey: idempotencyKey as IdempotencyKey,
    expectedRevision: revision,
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    commandName,
    payload,
  });
}

export function buildFirstServiceGoldenReplay(): readonly JsonObject[] {
  const subject: GuestSubjectRef = { kind: "guest", guestSessionId: "guest-service-fixture-0001" };
  const sequence: readonly [string, JsonObject][] = [
    ["service.start", {}],
    ["service.prepare-rice", { beat: "wash" }],
    ["service.prepare-rice", { beat: "steam" }],
    ["service.prepare-rice", { beat: "season" }],
    ["service.accept-order", { orderId: "ceramicist-kappa" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "layer-nori" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "portion-rice" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "place-cucumber" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "roll-kappa" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "cut-kappa" }],
    ["service.choose-presentation", { orderId: "ceramicist-kappa", choice: "indigo-rim" }],
    ["service.plate-order", { orderId: "ceramicist-kappa" }],
    ["service.serve-order", { orderId: "ceramicist-kappa" }],
    ["service.accept-order", { orderId: "fishmonger-tamago" }],
    ["service.perform-step", { orderId: "fishmonger-tamago", stepId: "portion-rice" }],
    ["service.perform-step", { orderId: "fishmonger-tamago", stepId: "press-rice" }],
    ["service.perform-step", { orderId: "fishmonger-tamago", stepId: "place-tamago" }],
    ["service.perform-step", { orderId: "fishmonger-tamago", stepId: "bind-tamago" }],
    ["service.plate-order", { orderId: "fishmonger-tamago" }],
    ["service.serve-order", { orderId: "fishmonger-tamago" }],
    ["service.accept-order", { orderId: "courier-salmon" }],
    ["service.perform-step", { orderId: "courier-salmon", stepId: "arrange-salmon" }],
    ["service.perform-step", { orderId: "courier-salmon", stepId: "portion-rice" }],
    ["service.perform-step", { orderId: "courier-salmon", stepId: "press-rice" }],
    ["service.perform-step", { orderId: "courier-salmon", stepId: "place-salmon" }],
    ["service.plate-order", { orderId: "courier-salmon" }],
    ["service.serve-order", { orderId: "courier-salmon" }],
    ["service.close-ledger", {}],
    ["service.choose-restoration", { choice: "mend-counter-stool" }],
  ];
  let checkpoint: EveningServiceCheckpoint = createInitialEveningServiceCheckpoint();
  const replay: JsonObject[] = [checkpoint];
  sequence.forEach(([commandName, payload], index) => {
    const command = replayCommand(subject, `018f47fe-347b-4dac-8f45-a6f3f43b${(600 + index).toString().padStart(4, "0")}`, checkpoint.revision, commandName, payload);
    const decision = reduceEveningService(checkpoint, command);
    checkpoint = decision.checkpoint;
    replay.push({ command: command as unknown as JsonObject, event: decision.event, response: decision.response.payload });
  });
  if (checkpoint.phase !== "SETTLED" || checkpoint.unlocks.length !== 1 || checkpoint.unlocks[0] !== SALMON_SASHIMI_UNLOCK_ID) {
    fail("the golden replay must settle once and unlock salmon sashimi once");
  }
  return deepFreeze(replay);
}

function buildReplayVector(sequence: readonly [string, JsonObject][], keyOffset: number): readonly JsonObject[] {
  const subject: GuestSubjectRef = { kind: "guest", guestSessionId: "guest-service-fixture-0001" };
  let checkpoint: EveningServiceCheckpoint = createInitialEveningServiceCheckpoint();
  const replay: JsonObject[] = [checkpoint];
  sequence.forEach(([commandName, payload], index) => {
    const command = replayCommand(subject, `018f47fe-347b-4dac-8f45-a6f3f43b${(keyOffset + index).toString().padStart(4, "0")}`, checkpoint.revision, commandName, payload);
    const decision = reduceEveningService(checkpoint, command);
    checkpoint = decision.checkpoint;
    replay.push({ command: command as unknown as JsonObject, event: decision.event, response: decision.response.payload });
  });
  return deepFreeze(replay);
}

export function buildFirstServiceCorrectiveReplay(): readonly JsonObject[] {
  const replay = buildReplayVector([
    ["service.start", {}],
    ["service.prepare-rice", { beat: "steam" }],
    ["service.prepare-rice", { beat: "wash" }],
  ], 800);
  const started = (replay[1] as { response: { checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const corrected = (replay[2] as { response: { checkpoint: EveningServiceCheckpoint; accepted: boolean } }).response;
  if (corrected.accepted || canonicalContentJson(started) !== canonicalContentJson(corrected.checkpoint)) fail("corrective replay must conserve the exact checkpoint bytes");
  return replay;
}

export function buildFirstServiceAbandonmentReplay(): readonly JsonObject[] {
  const replay = buildReplayVector([
    ["service.start", {}],
    ["service.prepare-rice", { beat: "wash" }],
    ["service.prepare-rice", { beat: "steam" }],
    ["service.prepare-rice", { beat: "season" }],
    ["service.accept-order", { orderId: "ceramicist-kappa" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "layer-nori" }],
    ["service.perform-step", { orderId: "ceramicist-kappa", stepId: "portion-rice" }],
    ["service.abandon", {}],
  ], 900);
  const terminal = (replay.at(-1) as { response: { checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  if (terminal.phase !== "ABANDONED" || terminal.unlocks.length !== 0 || terminal.components.some((row) => row.placed !== 0)) fail("abandonment replay must discard placed components without settlement");
  return replay;
}

export function buildFirstServiceNewRunReplay(): readonly JsonObject[] {
  const replay = buildReplayVector([
    ["service.start", {}],
    ["service.prepare-rice", { beat: "wash" }],
    ["service.abandon", {}],
    ["service.start-new", {}],
  ], 950);
  const abandoned = (replay.at(-2) as { response: { checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const restarted = (replay.at(-1) as { response: { checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  if (abandoned.phase !== "ABANDONED" || restarted.phase !== "OPEN" || restarted.generation !== abandoned.generation + 1
    || restarted.revision !== abandoned.revision + 1 || restarted.riceBeatIndex !== 0 || restarted.activeOrderIndex !== 0
    || restarted.presentationChoice !== null || restarted.restorationChoice !== null
    || restarted.orders.some((order) => order.state !== "OFFERED" || order.stepIndex !== 0)
    || restarted.components.some((row) => row.placed !== 0 || row.served !== 0 || row.discarded !== 0)) {
    fail("new-run replay must advance generation and reset only the run-scoped service graph");
  }
  return replay;
}

export function buildFirstServiceTerminalReplay(goldenReplay: readonly JsonObject[]): readonly JsonObject[] {
  const settlement = goldenReplay.at(-1)!;
  const response = (settlement as { response: { checkpoint: EveningServiceCheckpoint; settledNow: boolean; unlockedNow: readonly string[] } }).response;
  if (response.checkpoint.phase !== "SETTLED" || !response.settledNow || response.unlockedNow.join("|") !== SALMON_SASHIMI_UNLOCK_ID) fail("terminal replay source must be the exact settlement transition");
  const storedResponse = JSON.parse(canonicalContentJson(response)) as JsonObject;
  return deepFreeze([
    { disposition: "committed", settlementUnlockTransitions: 1, response: storedResponse },
    { disposition: "replayed", settlementUnlockTransitions: 1, response: storedResponse },
  ]);
}

export function compileFirstServiceContent(input: unknown): CompiledFirstServiceContent {
  assertBoundedContent(input);
  assertFirstServicePreparationGraph();
  const source = JSON.parse(canonicalContentJson(input)) as FirstServiceContentSource;
  if (source.schemaVersion !== 1 || source.contentVersion !== FIRST_EVENING_CONTENT_VERSION) fail("schema/content version mismatch");
  if (canonicalContentJson(source.serviceDefinition) !== canonicalContentJson(FIRST_EVENING_SERVICE_DEFINITION)) fail("service definition drift");
  if (canonicalContentJson(source.firstServiceCatalog) !== canonicalContentJson(firstServiceCatalog)) fail("first-service catalog binding drift");
  if (canonicalContentJson(source.salmonSashimiUnlockCatalog) !== canonicalContentJson(salmonSashimiUnlockCatalog)) fail("salmon sashimi catalog binding drift");
  if (!Array.isArray(source.reviewReferences) || source.reviewReferences.length === 0
    || [...source.reviewReferences].sort().join("|") !== source.reviewReferences.join("|")
    || new Set(source.reviewReferences).size !== source.reviewReferences.length) fail("review references must be a sorted non-empty set");
  const catalogKeys = new Set(source.firstServiceCatalog.entities.map((entry) => `${entry.kind}:${entry.ref.id}@${entry.ref.version}`));
  const expectedCatalogKeys = [
    "component:cooked-tamago@1", "component:cucumber-strip@1", "component:nori-sheet@1", "component:prepared-salmon-topping@1", "component:prepared-sushi-rice@1",
    "dish:kappa-maki@1", "dish:salmon-nigiri@1", "dish:tamago-nigiri@1",
    "family:bound-nigiri@1", "family:hosomaki@1", "family:nigiri@1",
    "ingredient:atlantic-salmon-flesh@1", "ingredient:cucumber@1", "ingredient:nori@1", "ingredient:rice-vinegar@1", "ingredient:sushi-rice@1", "ingredient:tamago@1",
    "recipe:kappa-maki@1", "recipe:salmon-nigiri@1", "recipe:tamago-nigiri@1", "species:atlantic-salmon@1",
  ];
  if (expectedCatalogKeys.some((key) => !catalogKeys.has(key)) || catalogKeys.size !== expectedCatalogKeys.length) fail("first-service catalog inventory drift");
  const definitionSequence = FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => order.steps.map((step) => `${step.station}:${step.action}`).join("|")).join("||");
  const expectedSequence = "rolling-mat:layer|rolling-mat:portion|rolling-mat:fill|rolling-mat:roll|rolling-mat:cut||nigiri-counter:portion|nigiri-counter:press|nigiri-counter:layer|nigiri-counter:bind||prep-sashimi-board:arrange|nigiri-counter:portion|nigiri-counter:press|nigiri-counter:layer";
  if (definitionSequence !== expectedSequence) fail("authored station sequence drift");
  const copyKeys = source.copy.map((entry) => entry.key);
  if (new Set(copyKeys).size !== copyKeys.length || [...copyKeys].sort().join("|") !== copyKeys.join("|")) fail("copy entries must be sorted and unique");
  for (const entry of source.copy) {
    if (entry.status !== "review-pending" || !source.reviewReferences.includes(entry.reviewId) || entry.text.length === 0) fail(`invalid copy ${entry.key}`);
  }
  const copyByKey = new Map(source.copy.map((entry) => [entry.key, entry]));
  const definitionRefs = [
    source.serviceDefinition.startPromptRef,
    ...Object.values(source.serviceDefinition.ricePromptRefs),
    source.serviceDefinition.closePromptRef,
    source.serviceDefinition.restorationPromptRef,
    source.serviceDefinition.settledPromptRef,
    source.serviceDefinition.abandonedPromptRef,
    ...source.serviceDefinition.orders.flatMap((order) => [
      order.dialogueRef, order.acceptPromptRef, order.platePromptRef, order.plateFeedbackRef, order.serveFeedbackRef,
      `story-flag.${order.storyFlagId}`, order.persistentConsequenceRef,
      `prompt.serve.${order.id}`,
      ...order.steps.flatMap((step) => [step.promptRef, step.correctiveCueRef]),
    ]),
  ];
  const runtimeRefs = [
    "cue.abandon.invalid", "cue.ledger.orders-incomplete", "cue.orders.complete", "cue.orders.served", "cue.presentation.invalid",
    "cue.restoration.invalid", "cue.rice.complete", "cue.rice.expected.season", "cue.rice.expected.steam", "cue.rice.expected.wash",
    "cue.service.complete", "cue.start-new.invalid", "cue.start.invalid", "feedback.ledger.closed", "feedback.presentation.indigo-rim",
    "feedback.presentation.sand-speckle", "feedback.rice.season.saved", "feedback.rice.steam.saved", "feedback.rice.wash.saved",
    "feedback.service.abandoned", "feedback.service.new-shift", "feedback.service.opened", "feedback.service.settled", "prompt.presentation.choose",
    ...source.serviceDefinition.orders.flatMap((order) => [
      `cue.order.accept.${order.id}`, `cue.order.expected.${order.id}`, `cue.plate.required.${order.id}`, `cue.serve.required.${order.id}`,
    ]),
  ];
  if ([...new Set([...definitionRefs, ...runtimeRefs])].some((ref) => !copyByKey.has(ref))) fail("service definition or runtime references missing pinned copy");
  const artKeys = source.artRequirements.map((asset) => asset.key);
  if (new Set(artKeys).size !== artKeys.length || [...artKeys].sort().join("|") !== artKeys.join("|")) fail("art requirements must be sorted and unique");
  for (const asset of source.artRequirements) {
    if (asset.status !== "required-later" || !source.reviewReferences.includes(asset.reviewId)
      || asset.digest !== contentHashFor({ key: asset.key, dimensions: asset.dimensions, nonColorIdentity: asset.nonColorIdentity })) fail(`invalid art requirement ${asset.key}`);
  }
  const goldenReplay = buildFirstServiceGoldenReplay();
  const correctiveReplay = buildFirstServiceCorrectiveReplay();
  const abandonmentReplay = buildFirstServiceAbandonmentReplay();
  const newRunReplay = buildFirstServiceNewRunReplay();
  const terminalReplay = buildFirstServiceTerminalReplay(goldenReplay);
  const semanticRefs = [
    "dish.kappa-maki", "dish.salmon-nigiri", "dish.tamago-nigiri", "guest.ceramicist", "guest.courier", "guest.fishmonger",
    "ledger.first-evening", "phase.abandoned", "phase.closing", "phase.idle", "phase.open", "phase.settled",
    "rice.season", "rice.steam", "rice.wash", "service.first-evening", "station.nigiri-counter", "station.prep-sashimi-board",
    "station.rice-hearth", "station.rolling-mat", `unlock.${SALMON_SASHIMI_UNLOCK_ID}`,
  ];
  const projectionManifest: EveningServiceProjectionManifest = deepFreeze({
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    serviceDefinition: source.serviceDefinition,
    contentRefs: [...new Set([...copyKeys, ...semanticRefs])].sort(),
  });
  return deepFreeze({
    schemaVersion: 1,
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    contentManifestHash: contentHashFor({
      copy: source.copy,
      firstServiceCatalog: source.firstServiceCatalog,
      reviewReferences: source.reviewReferences,
      salmonSashimiUnlockCatalog: source.salmonSashimiUnlockCatalog,
    }),
    artAssetMapHash: contentHashFor(source.artRequirements),
    serviceHash: contentHashFor(source.serviceDefinition),
    replayHash: contentHashFor(goldenReplay),
    correctiveReplayHash: contentHashFor(correctiveReplay),
    abandonmentReplayHash: contentHashFor(abandonmentReplay),
    newRunReplayHash: contentHashFor(newRunReplay),
    terminalReplayHash: contentHashFor(terminalReplay),
    source,
    goldenReplay,
    correctiveReplay,
    abandonmentReplay,
    newRunReplay,
    terminalReplay,
    projectionManifest,
  });
}

const reviewId = "phase-1-service-review-pending-v1";
function copy(key: string, text: string): ServiceCopyEntry {
  return { key, text, reviewId, status: "review-pending" };
}
function art(key: string, dimensions: string, nonColorIdentity: string): ServiceArtRequirement {
  return {
    key,
    digest: contentHashFor({ key, dimensions, nonColorIdentity }),
    dimensions,
    reviewId,
    status: "required-later",
    nonColorIdentity,
  };
}

export const firstEveningServiceSource: FirstServiceContentSource = deepFreeze({
  schemaVersion: 1,
  contentVersion: FIRST_EVENING_CONTENT_VERSION,
  reviewReferences: [reviewId],
  firstServiceCatalog,
  salmonSashimiUnlockCatalog,
  copy: [
    copy("action.service.start-new", "Start a fresh shift"),
    copy("action.service.abandon", "End shift early"),
    copy("action.presentation.indigo-rim", "Use the double-rim plate"),
    copy("action.presentation.sand-speckle", "Use the speckled-field plate"),
    copy("action.restoration.mend-counter-stool", "Mend the counter stool"),
    copy("action.restoration.polish-display-shelf", "Polish the display shelf"),
    copy("action.restoration.refresh-menu-board", "Refresh the menu board"),
    copy("cue.abandon.invalid", "Open the counter before ending a shift."),
    copy("cue.ledger.orders-incomplete", "Serve all three authored orders before closing the ledger."),
    copy("cue.order.accept.ceramicist-kappa", "Accept the ceramicist's kappa maki order next."),
    copy("cue.order.accept.courier-salmon", "Accept the courier's salmon nigiri order next."),
    copy("cue.order.accept.fishmonger-tamago", "Accept the fishmonger's tamago nigiri order next."),
    copy("cue.order.expected.ceramicist-kappa", "Continue the ceramicist's kappa maki order."),
    copy("cue.order.expected.courier-salmon", "Continue the courier's salmon nigiri order."),
    copy("cue.order.expected.fishmonger-tamago", "Continue the fishmonger's tamago nigiri order."),
    copy("cue.orders.complete", "Every authored order is complete."),
    copy("cue.orders.served", "Every authored order is served."),
    copy("cue.plate.required.ceramicist-kappa", "Complete and plate the kappa maki before serving."),
    copy("cue.plate.required.courier-salmon", "Complete and plate the salmon nigiri before serving."),
    copy("cue.plate.required.fishmonger-tamago", "Complete and plate the tamago nigiri before serving."),
    copy("cue.presentation.invalid", "Choose one available cosmetic presentation for the first plate."),
    copy("cue.restoration.invalid", "Choose one available cosmetic restoration after closing the ledger."),
    copy("cue.rice.complete", "The three rice preparation beats are already complete."),
    copy("cue.rice.expected.season", "Season is the next forgiving rice preparation beat."),
    copy("cue.rice.expected.steam", "Steam is the next forgiving rice preparation beat."),
    copy("cue.rice.expected.wash", "Wash is the next forgiving rice preparation beat."),
    copy("cue.serve.required.ceramicist-kappa", "Plate the kappa maki before serving it."),
    copy("cue.serve.required.courier-salmon", "Plate the salmon nigiri before serving it."),
    copy("cue.serve.required.fishmonger-tamago", "Plate the tamago nigiri before serving it."),
    copy("cue.service.complete", "This service is already complete."),
    copy("cue.start-new.invalid", "Start a fresh shift only after the current shift closes early."),
    copy("cue.start.invalid", "Open the service only from the idle ledger."),
    copy("cue.step.ceramicist-kappa.cut-kappa", "Cut the completed roll only after rolling it."),
    copy("cue.step.ceramicist-kappa.layer-nori", "Layer nori on the rolling mat first."),
    copy("cue.step.ceramicist-kappa.place-cucumber", "Place cucumber after the rice."),
    copy("cue.step.ceramicist-kappa.portion-rice", "Portion prepared sushi rice over the nori."),
    copy("cue.step.ceramicist-kappa.roll-kappa", "Roll after nori, rice, and cucumber are aligned."),
    copy("cue.step.courier-salmon.arrange-salmon", "Arrange the authored salmon topping at the prep board first."),
    copy("cue.step.courier-salmon.place-salmon", "Place the authored salmon topping after shaping the rice."),
    copy("cue.step.courier-salmon.portion-rice", "Portion prepared sushi rice at the nigiri counter."),
    copy("cue.step.courier-salmon.press-rice", "Press the portioned rice before adding the topping."),
    copy("cue.step.fishmonger-tamago.bind-tamago", "Bind the tamago only after placing it."),
    copy("cue.step.fishmonger-tamago.place-tamago", "Place the cooked tamago after shaping the rice."),
    copy("cue.step.fishmonger-tamago.portion-rice", "Portion prepared sushi rice at the nigiri counter."),
    copy("cue.step.fishmonger-tamago.press-rice", "Press the portioned rice before adding the topping."),
    copy("dish.kappa-maki", "Kappa maki"),
    copy("dish.salmon-nigiri", "Salmon nigiri"),
    copy("dish.tamago-nigiri", "Tamago nigiri"),
    copy("feedback.ledger.closed", "The evening ledger is closed."),
    copy("feedback.plate.ceramicist-kappa", "The ceramicist notices the clean, even roll."),
    copy("feedback.plate.courier-salmon", "The courier sees the final plate arrive complete."),
    copy("feedback.plate.fishmonger-tamago", "The fishmonger sees the tamago held neatly in place."),
    copy("feedback.serve.ceramicist-kappa", "The ceramicist accepts the kappa maki with a quiet nod."),
    copy("feedback.serve.courier-salmon", "The courier accepts the salmon nigiri; every order in the ledger is now served."),
    copy("feedback.serve.fishmonger-tamago", "The fishmonger accepts the tamago nigiri and leaves the counter ready for the courier."),
    copy("feedback.presentation.indigo-rim", "The double-rim plate is saved as the cosmetic presentation."),
    copy("feedback.presentation.sand-speckle", "The speckled-field plate is saved as the cosmetic presentation."),
    copy("feedback.rice.season.saved", "The seasoning beat is saved."),
    copy("feedback.rice.steam.saved", "The steaming beat is saved."),
    copy("feedback.rice.wash.saved", "The washing beat is saved."),
    copy("feedback.service.abandoned", "Shift closed early without settlement or unlocks."),
    copy("feedback.service.new-shift", "A fresh shift is open on the same saved service."),
    copy("feedback.service.opened", "The counter is open for the first service."),
    copy("feedback.service.settled", "The counter is restored and salmon sashimi is now available."),
    copy("guest.ceramicist.dialogue", "The ceramicist asks for the authored cucumber roll."),
    copy("guest.ceramicist", "The ceramicist"),
    copy("guest.courier.dialogue", "The courier asks for the authored salmon nigiri."),
    copy("guest.courier", "The courier"),
    copy("guest.fishmonger.dialogue", "The fishmonger asks for the authored cooked-egg nigiri."),
    copy("guest.fishmonger", "The fishmonger"),
    copy("ledger.first-evening", "First evening ledger"),
    copy("order-state.accepted", "Accepted"),
    copy("order-state.discarded", "Closed early"),
    copy("order-state.offered", "Waiting"),
    copy("order-state.plated", "Plated"),
    copy("order-state.preparing", "Preparing"),
    copy("order-state.ready-to-plate", "Ready to plate"),
    copy("order-state.served", "Served"),
    copy("outcome.content", "Content"),
    copy("outcome.delighted", "Delighted"),
    copy("outcome.recoverable-concern", "Recoverable concern"),
    copy("phase.abandoned", "Shift closed early."),
    copy("phase.closing", "Close the evening ledger."),
    copy("phase.idle", "Your counter opens tonight."),
    copy("phase.open", "The counter is open."),
    copy("phase.settled", "Counter closed. Tonight's service is saved."),
    copy("presentation.indigo-rim", "Double-rim plate"),
    copy("presentation.sand-speckle", "Speckled-field plate"),
    copy("restoration.mend-counter-stool", "Mend the counter stool"),
    copy("restoration.polish-display-shelf", "Polish the display shelf"),
    copy("restoration.refresh-menu-board", "Refresh the menu board"),
    copy("prompt.ledger.close", "Close the ledger after all three orders are served."),
    copy("prompt.order.accept.ceramicist-kappa", "Accept the ceramicist's kappa maki order."),
    copy("prompt.order.accept.courier-salmon", "Accept the courier's salmon nigiri order."),
    copy("prompt.order.accept.fishmonger-tamago", "Accept the fishmonger's tamago nigiri order."),
    copy("prompt.plate.ceramicist-kappa", "Plate the kappa maki."),
    copy("prompt.plate.courier-salmon", "Plate the salmon nigiri."),
    copy("prompt.plate.fishmonger-tamago", "Plate the tamago nigiri."),
    copy("prompt.presentation.choose", "Choose one cosmetic presentation for the first plate."),
    copy("prompt.restoration.choose", "Choose one cosmetic restoration."),
    copy("prompt.rice.season", "Season the prepared rice."),
    copy("prompt.rice.steam", "Steam the washed rice."),
    copy("prompt.rice.wash", "Wash the rice."),
    copy("prompt.serve.ceramicist-kappa", "Serve the kappa maki."),
    copy("prompt.serve.courier-salmon", "Serve the salmon nigiri."),
    copy("prompt.serve.fishmonger-tamago", "Serve the tamago nigiri."),
    copy("prompt.service.abandoned", "Shift closed early."),
    copy("prompt.service.settled", "Counter closed. Tonight's service is saved."),
    copy("prompt.service.start", "Start the first shift."),
    copy("prompt.step.ceramicist-kappa.cut-kappa", "Cut the rolled kappa maki."),
    copy("prompt.step.ceramicist-kappa.layer-nori", "Layer nori on the rolling mat."),
    copy("prompt.step.ceramicist-kappa.place-cucumber", "Place cucumber along the center."),
    copy("prompt.step.ceramicist-kappa.portion-rice", "Portion prepared sushi rice over the nori."),
    copy("prompt.step.ceramicist-kappa.roll-kappa", "Roll the aligned kappa maki."),
    copy("prompt.step.courier-salmon.arrange-salmon", "Arrange the authored salmon topping at the prep board."),
    copy("prompt.step.courier-salmon.place-salmon", "Place the authored salmon topping over the rice."),
    copy("prompt.step.courier-salmon.portion-rice", "Portion prepared sushi rice at the nigiri counter."),
    copy("prompt.step.courier-salmon.press-rice", "Press the rice into its authored nigiri shape."),
    copy("prompt.step.fishmonger-tamago.bind-tamago", "Bind the tamago and rice with nori."),
    copy("prompt.step.fishmonger-tamago.place-tamago", "Place the cooked tamago over the rice."),
    copy("prompt.step.fishmonger-tamago.portion-rice", "Portion prepared sushi rice at the nigiri counter."),
    copy("prompt.step.fishmonger-tamago.press-rice", "Press the rice into its authored nigiri shape."),
    copy("rice.season", "Seasoned rice"),
    copy("rice.steam", "Steamed rice"),
    copy("rice.wash", "Washed rice"),
    copy("service.first-evening", "First evening service"),
    copy("station.nigiri-counter", "Nigiri counter"),
    copy("station.prep-sashimi-board", "Prep and sashimi board"),
    copy("station.rice-hearth", "Rice hearth"),
    copy("station.rolling-mat", "Rolling mat"),
    copy("story.ceramicist.first-service", "The ceramicist remembers the neatly served first plate."),
    copy("story.courier.first-service", "The courier remembers that the counter completed the evening ledger."),
    copy("story.fishmonger.first-service", "The fishmonger remembers the carefully bound tamago nigiri."),
    copy("story-flag.ceramicist-first-service-served", "Ceramicist first-service order served"),
    copy("story-flag.courier-first-service-served", "Courier first-service order served"),
    copy("story-flag.fishmonger-first-service-served", "Fishmonger first-service order served"),
    copy("unlock.atlantic-salmon-sashimi@1", "Salmon sashimi unlocked: a rice-free preparation."),
  ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  artRequirements: [
    art("counter-curtain-closed", "320x180", "A closed curtain silhouette with a plainly labeled counter threshold."),
    art("counter-curtain-open", "320x180", "An open curtain silhouette with the same counter geometry."),
    art("counter-lamp-lit", "64x64", "A lit counter lamp with a distinct radiant outline."),
    art("dish-kappa-maki-build", "48x48", "Layered nori, rice, and cucumber build silhouette."),
    art("dish-kappa-maki", "48x48", "A sliced cucumber roll with an outer nori ring."),
    art("dish-kappa-maki-plated", "64x48", "The sliced cucumber roll centered on a plainly outlined plate."),
    art("dish-salmon-nigiri-build", "48x48", "Layered broad salmon topping and compact rice build silhouette."),
    art("dish-salmon-nigiri", "48x48", "A broad salmon topping over a compact rice base."),
    art("dish-salmon-nigiri-plated", "64x48", "The salmon nigiri centered on a plainly outlined plate."),
    art("dish-salmon-sashimi-locked", "48x48", "A locked tile around a rice-free three-slice silhouette."),
    art("dish-salmon-sashimi", "48x48", "Three rice-free broad salmon slices in a staggered fan."),
    art("dish-tamago-nigiri-build", "48x48", "Layered rectangular egg, center binding, and rice build silhouette."),
    art("dish-tamago-nigiri", "48x48", "A rectangular cooked egg topping bound to rice by a center nori strip."),
    art("dish-tamago-nigiri-plated", "64x48", "The tamago nigiri centered on a plainly outlined plate."),
    art("guest-ceramicist-content", "32x48", "Ceramicist role portrait with a relaxed open-hand silhouette."),
    art("guest-ceramicist-delighted", "32x48", "Ceramicist role portrait with an upright open-hand silhouette."),
    art("guest-ceramicist-neutral", "32x48", "Ceramicist role portrait with a relaxed closed-hand silhouette."),
    art("guest-ceramicist-recoverable", "32x48", "Ceramicist role portrait with a plainly marked concern bubble."),
    art("guest-courier-content", "32x48", "Courier role portrait with parcel held at the side."),
    art("guest-courier-delighted", "32x48", "Courier role portrait with parcel lifted once."),
    art("guest-courier-neutral", "32x48", "Courier role portrait with parcel centered."),
    art("guest-courier-recoverable", "32x48", "Courier role portrait with a plainly marked concern bubble."),
    art("guest-fishmonger-content", "32x48", "Fishmonger role portrait with apron panel relaxed."),
    art("guest-fishmonger-delighted", "32x48", "Fishmonger role portrait with apron panel and open hands."),
    art("guest-fishmonger-neutral", "32x48", "Fishmonger role portrait with apron panel centered."),
    art("guest-fishmonger-recoverable", "32x48", "Fishmonger role portrait with a plainly marked concern bubble."),
    art("ingredient-cucumber", "24x24", "A long cut cucumber silhouette."),
    art("ingredient-nori", "24x24", "A square sheet silhouette with a corner notch."),
    art("ingredient-salmon", "24x24", "A broad prepared salmon component silhouette."),
    art("ingredient-sushi-rice", "24x24", "A compact rice mound silhouette."),
    art("ingredient-tamago", "24x24", "A rectangular cooked egg silhouette."),
    art("ingredient-vinegar", "24x24", "A narrow labeled seasoning vessel silhouette."),
    art("presentation-indigo-rim", "64x32", "A plate backplate identified by a double rim, not color alone."),
    art("presentation-sand-speckle", "64x32", "A plate backplate identified by a speckled field, not color alone."),
    art("restoration-counter-stool", "64x64", "A repaired counter stool overlay."),
    art("restoration-display-shelf", "64x64", "A polished display shelf overlay."),
    art("restoration-menu-board", "64x64", "A refreshed menu board overlay with no invented script."),
    art("rice-cooked", "32x32", "A cooked rice silhouette with a rounded steam marker."),
    art("rice-seasoned", "32x32", "A seasoned rice silhouette with a mixing paddle marker."),
    art("rice-washed", "32x32", "A washed rice silhouette with a water-line marker."),
    art("station-nigiri-counter", "24x24", "A low shaping counter glyph."),
    art("station-prep-board", "24x24", "A rectangular preparation board glyph."),
    art("station-rice-hearth", "24x24", "A lidded rice vessel and hearth glyph."),
    art("station-rolling-mat", "24x24", "A parallel-slat rolling mat glyph."),
  ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  serviceDefinition: FIRST_EVENING_SERVICE_DEFINITION,
});

export const compiledFirstEveningService = compileFirstServiceContent(firstEveningServiceSource);
export const firstEveningServiceCanonicalBytes = canonicalEveningServiceBytes(compiledFirstEveningService as unknown as JsonValue);
