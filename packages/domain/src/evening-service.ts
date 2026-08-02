import { canonicalJson } from "./canonical-json";
import { validateCommandEnvelope } from "./commands";
import { PersistenceDomainError } from "./errors";
import type { CommandEnvelope, JsonObject, JsonValue } from "./model";

export const EVENING_SERVICE_SCHEMA_VERSION = 1 as const;
export const FIRST_EVENING_SERVICE_ID = "first-evening-service" as const;
export const FIRST_EVENING_CONTENT_VERSION = "phase-1-evening-service-v1" as const;
export const SALMON_SASHIMI_UNLOCK_ID = "atlantic-salmon-sashimi@1" as const;

export type ServicePhase = "IDLE" | "OPEN" | "CLOSING" | "SETTLED" | "ABANDONED";
export type ServiceOrderState =
  | "OFFERED" | "ACCEPTED" | "PREPARING" | "READY_TO_PLATE" | "PLATED" | "SERVED"
  | "EXPIRED" | "FAILED" | "DISCARDED";
export type OrderOutcomeClass = "delighted" | "content" | "recoverable-concern";
export type PresentationChoice = "indigo-rim" | "sand-speckle";
export type RestorationChoice = "mend-counter-stool" | "polish-display-shelf" | "refresh-menu-board";
export type RiceBeatId = "wash" | "steam" | "season";
export type FirstServiceOrderId = "ceramicist-kappa" | "fishmonger-tamago" | "courier-salmon";

export interface AuthoredServiceStep {
  readonly id: string;
  readonly station: "rice-hearth" | "prep-sashimi-board" | "rolling-mat" | "nigiri-counter";
  readonly action: string;
  readonly promptRef: string;
  readonly correctiveCueRef: string;
  readonly componentRef?: "prepared-sushi-rice" | "nori-sheet" | "cucumber-strip" | "cooked-tamago" | "prepared-salmon-topping";
}

export interface FirstServiceOrderDefinition {
  readonly id: FirstServiceOrderId;
  readonly guestRole: "ceramicist" | "fishmonger" | "courier";
  readonly dishId: "kappa-maki" | "tamago-nigiri" | "salmon-nigiri";
  readonly dialogueRef: string;
  readonly outcomeClass: OrderOutcomeClass;
  readonly acceptPromptRef: string;
  readonly steps: readonly AuthoredServiceStep[];
  readonly platePromptRef: string;
  readonly plateFeedbackRef: string;
  readonly serveFeedbackRef: string;
  readonly storyFlagId: string;
  readonly persistentConsequenceRef: string;
}

export interface FirstEveningServiceDefinition {
  readonly schemaVersion: typeof EVENING_SERVICE_SCHEMA_VERSION;
  readonly id: typeof FIRST_EVENING_SERVICE_ID;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly startPromptRef: string;
  readonly ricePromptRefs: Readonly<Record<RiceBeatId, string>>;
  readonly closePromptRef: string;
  readonly restorationPromptRef: string;
  readonly settledPromptRef: string;
  readonly abandonedPromptRef: string;
  readonly riceBeats: readonly RiceBeatId[];
  readonly presentationChoices: readonly PresentationChoice[];
  readonly restorationChoices: readonly RestorationChoice[];
  readonly orders: readonly FirstServiceOrderDefinition[];
  readonly settlementUnlock: typeof SALMON_SASHIMI_UNLOCK_ID;
}

export interface ServiceOrderCheckpoint extends JsonObject {
  readonly id: FirstServiceOrderId;
  readonly state: ServiceOrderState;
  readonly stepIndex: number;
  readonly plateFeedbackRef: string | null;
  readonly serveFeedbackRef: string | null;
}

export interface ServiceComponentCheckpoint extends JsonObject {
  readonly id: "cooked-tamago" | "cucumber-strip" | "nori-sheet" | "prepared-salmon-topping" | "prepared-sushi-rice";
  readonly total: number;
  readonly available: number;
  readonly placed: number;
  readonly served: number;
  readonly discarded: number;
}

export interface EveningServiceCheckpoint extends JsonObject {
  readonly schemaVersion: typeof EVENING_SERVICE_SCHEMA_VERSION;
  readonly serviceId: typeof FIRST_EVENING_SERVICE_ID;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly revision: number;
  readonly phase: ServicePhase;
  readonly riceBeatIndex: number;
  readonly presentationChoice: PresentationChoice | null;
  readonly restorationChoice: RestorationChoice | null;
  readonly activeOrderIndex: number;
  readonly orders: readonly ServiceOrderCheckpoint[];
  readonly components: readonly ServiceComponentCheckpoint[];
  readonly storyFlags: readonly string[];
  readonly unlocks: readonly string[];
}

export type EveningServiceCommandName =
  | "service.start" | "service.prepare-rice" | "service.accept-order" | "service.perform-step"
  | "service.choose-presentation" | "service.plate-order" | "service.serve-order"
  | "service.close-ledger" | "service.choose-restoration" | "service.abandon";

export interface EveningServiceEvent extends JsonObject {
  readonly eventRef: string;
  readonly eventType: "service.transitioned" | "service.corrective-cue";
  readonly schemaVersion: typeof EVENING_SERVICE_SCHEMA_VERSION;
  readonly payload: JsonObject;
}

export interface EveningServiceResponse extends JsonObject {
  readonly accepted: boolean;
  readonly checkpoint: EveningServiceCheckpoint;
  readonly feedbackRef: string;
  readonly correctiveCueId: string | null;
  readonly settledNow: boolean;
  readonly unlockedNow: readonly string[];
  readonly outcomeClass: OrderOutcomeClass | null;
}

export interface EveningServiceDecision {
  readonly checkpointSchemaVersion: typeof EVENING_SERVICE_SCHEMA_VERSION;
  readonly checkpoint: EveningServiceCheckpoint;
  readonly event: EveningServiceEvent;
  readonly response: { readonly schemaVersion: typeof EVENING_SERVICE_SCHEMA_VERSION; readonly payload: EveningServiceResponse };
}

export type ServiceProjectionDisposition = "query" | "committed" | "replayed" | "restored";

export interface EveningServiceProjectionManifest {
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly serviceDefinition: FirstEveningServiceDefinition;
  readonly contentRefs: readonly string[];
}

export interface EveningServiceProjectionContext {
  readonly disposition: ServiceProjectionDisposition;
  readonly correctiveCueId: string | null;
}

export interface EveningServiceLedgerRow extends JsonObject {
  readonly orderId: FirstServiceOrderId;
  readonly guestRef: string;
  readonly dishRef: string;
  readonly outcomeRef: string;
  readonly plateFeedbackRef: string;
  readonly serveFeedbackRef: string;
  readonly storyFlagRef: string;
  readonly persistentConsequenceRef: string;
}

export interface EveningServiceProjection extends JsonObject {
  readonly currentPromptId: string;
  readonly allowedChoiceIds: readonly string[];
  readonly primaryCommand: EveningServiceCommandName | null;
  readonly correctiveCueId: string | null;
  readonly displayRefs: readonly string[];
  readonly ledgerRows: readonly EveningServiceLedgerRow[];
  readonly disposition: ServiceProjectionDisposition;
  readonly announceCeremony: boolean;
}

const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(message: string): never { throw new PersistenceDomainError("INVALID_SERVICE_STATE", message); }

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${path} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(`${path} must contain exactly: ${expected.join(", ")}.`);
}

function safeRevision(value: unknown, path: string, incrementable = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (incrementable && value === MAX_SAFE_REVISION)) invalid(`${path} must be a non-negative${incrementable ? " safely incrementable" : ""} revision.`);
  return value as number;
}

function assertBoundedJson(input: unknown, path: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > 4096 || depth > 32) invalid(`${path} exceeds the structural limit.`);
    if (typeof value === "string" && value.length > 2048) invalid(`${path} contains an oversized string.`);
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) invalid(`${path} must not contain cycles or aliases.`);
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256) invalid(`${path} contains an oversized array.`);
      value.forEach((child) => stack.push({ value: child, depth: depth + 1 }));
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(`${path} must contain plain JSON objects.`);
      const entries = Object.entries(value);
      if (entries.length > 64 || entries.some(([key]) => key.length > 128)) invalid(`${path} contains an oversized object.`);
      entries.forEach(([, child]) => stack.push({ value: child, depth: depth + 1 }));
    }
  }
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { invalid(`${path} is not serializable JSON.`); }
  if (new TextEncoder().encode(encoded!).byteLength > 262_144) invalid(`${path} exceeds the canonical byte limit.`);
}

export const FIRST_EVENING_SERVICE_DEFINITION: FirstEveningServiceDefinition = deepFreeze({
  schemaVersion: EVENING_SERVICE_SCHEMA_VERSION,
  id: FIRST_EVENING_SERVICE_ID,
  contentVersion: FIRST_EVENING_CONTENT_VERSION,
  startPromptRef: "prompt.service.start",
  ricePromptRefs: { wash: "prompt.rice.wash", steam: "prompt.rice.steam", season: "prompt.rice.season" },
  closePromptRef: "prompt.ledger.close",
  restorationPromptRef: "prompt.restoration.choose",
  settledPromptRef: "prompt.service.settled",
  abandonedPromptRef: "prompt.service.abandoned",
  riceBeats: ["wash", "steam", "season"],
  presentationChoices: ["indigo-rim", "sand-speckle"],
  restorationChoices: ["mend-counter-stool", "polish-display-shelf", "refresh-menu-board"],
  orders: [
    {
      id: "ceramicist-kappa", guestRole: "ceramicist", dishId: "kappa-maki",
      dialogueRef: "guest.ceramicist.dialogue", outcomeClass: "delighted",
      acceptPromptRef: "prompt.order.accept.ceramicist-kappa",
      steps: [
        { id: "layer-nori", station: "rolling-mat", action: "layer", promptRef: "prompt.step.ceramicist-kappa.layer-nori", correctiveCueRef: "cue.step.ceramicist-kappa.layer-nori", componentRef: "nori-sheet" },
        { id: "portion-rice", station: "rolling-mat", action: "portion", promptRef: "prompt.step.ceramicist-kappa.portion-rice", correctiveCueRef: "cue.step.ceramicist-kappa.portion-rice", componentRef: "prepared-sushi-rice" },
        { id: "place-cucumber", station: "rolling-mat", action: "fill", promptRef: "prompt.step.ceramicist-kappa.place-cucumber", correctiveCueRef: "cue.step.ceramicist-kappa.place-cucumber", componentRef: "cucumber-strip" },
        { id: "roll-kappa", station: "rolling-mat", action: "roll", promptRef: "prompt.step.ceramicist-kappa.roll-kappa", correctiveCueRef: "cue.step.ceramicist-kappa.roll-kappa" },
        { id: "cut-kappa", station: "rolling-mat", action: "cut", promptRef: "prompt.step.ceramicist-kappa.cut-kappa", correctiveCueRef: "cue.step.ceramicist-kappa.cut-kappa" },
      ],
      platePromptRef: "prompt.plate.ceramicist-kappa",
      plateFeedbackRef: "feedback.plate.ceramicist-kappa",
      serveFeedbackRef: "feedback.serve.ceramicist-kappa",
      storyFlagId: "ceramicist-first-service-served",
      persistentConsequenceRef: "story.ceramicist.first-service",
    },
    {
      id: "fishmonger-tamago", guestRole: "fishmonger", dishId: "tamago-nigiri",
      dialogueRef: "guest.fishmonger.dialogue", outcomeClass: "content",
      acceptPromptRef: "prompt.order.accept.fishmonger-tamago",
      steps: [
        { id: "portion-rice", station: "nigiri-counter", action: "portion", promptRef: "prompt.step.fishmonger-tamago.portion-rice", correctiveCueRef: "cue.step.fishmonger-tamago.portion-rice", componentRef: "prepared-sushi-rice" },
        { id: "press-rice", station: "nigiri-counter", action: "press", promptRef: "prompt.step.fishmonger-tamago.press-rice", correctiveCueRef: "cue.step.fishmonger-tamago.press-rice" },
        { id: "place-tamago", station: "nigiri-counter", action: "layer", promptRef: "prompt.step.fishmonger-tamago.place-tamago", correctiveCueRef: "cue.step.fishmonger-tamago.place-tamago", componentRef: "cooked-tamago" },
        { id: "bind-tamago", station: "nigiri-counter", action: "bind", promptRef: "prompt.step.fishmonger-tamago.bind-tamago", correctiveCueRef: "cue.step.fishmonger-tamago.bind-tamago", componentRef: "nori-sheet" },
      ],
      platePromptRef: "prompt.plate.fishmonger-tamago",
      plateFeedbackRef: "feedback.plate.fishmonger-tamago",
      serveFeedbackRef: "feedback.serve.fishmonger-tamago",
      storyFlagId: "fishmonger-first-service-served",
      persistentConsequenceRef: "story.fishmonger.first-service",
    },
    {
      id: "courier-salmon", guestRole: "courier", dishId: "salmon-nigiri",
      dialogueRef: "guest.courier.dialogue", outcomeClass: "content",
      acceptPromptRef: "prompt.order.accept.courier-salmon",
      steps: [
        { id: "arrange-salmon", station: "prep-sashimi-board", action: "arrange", promptRef: "prompt.step.courier-salmon.arrange-salmon", correctiveCueRef: "cue.step.courier-salmon.arrange-salmon" },
        { id: "portion-rice", station: "nigiri-counter", action: "portion", promptRef: "prompt.step.courier-salmon.portion-rice", correctiveCueRef: "cue.step.courier-salmon.portion-rice", componentRef: "prepared-sushi-rice" },
        { id: "press-rice", station: "nigiri-counter", action: "press", promptRef: "prompt.step.courier-salmon.press-rice", correctiveCueRef: "cue.step.courier-salmon.press-rice" },
        { id: "place-salmon", station: "nigiri-counter", action: "layer", promptRef: "prompt.step.courier-salmon.place-salmon", correctiveCueRef: "cue.step.courier-salmon.place-salmon", componentRef: "prepared-salmon-topping" },
      ],
      platePromptRef: "prompt.plate.courier-salmon",
      plateFeedbackRef: "feedback.plate.courier-salmon",
      serveFeedbackRef: "feedback.serve.courier-salmon",
      storyFlagId: "courier-first-service-served",
      persistentConsequenceRef: "story.courier.first-service",
    },
  ],
  settlementUnlock: SALMON_SASHIMI_UNLOCK_ID,
});

const COMPONENT_IDS = ["cooked-tamago", "cucumber-strip", "nori-sheet", "prepared-salmon-topping", "prepared-sushi-rice"] as const;

function conservedComponents(orders: readonly ServiceOrderCheckpoint[]): readonly ServiceComponentCheckpoint[] {
  return COMPONENT_IDS.map((id) => {
    let total = 0;
    let placed = 0;
    let served = 0;
    let discarded = 0;
    FIRST_EVENING_SERVICE_DEFINITION.orders.forEach((definition, orderIndex) => {
      const order = orders[orderIndex]!;
      const componentSteps = definition.steps.filter((step) => step.componentRef === id);
      total += componentSteps.length;
      const completed = definition.steps.slice(0, order.stepIndex).filter((step) => step.componentRef === id).length;
      if (order.state === "SERVED") served += completed;
      else if (order.state === "DISCARDED") discarded += completed;
      else placed += completed;
    });
    return { id, total, available: total - placed - served - discarded, placed, served, discarded };
  });
}

export function createInitialEveningServiceCheckpoint(): EveningServiceCheckpoint {
  const orders = FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => ({ id: order.id, state: "OFFERED" as const, stepIndex: 0, plateFeedbackRef: null, serveFeedbackRef: null }));
  return deepFreeze({
    schemaVersion: EVENING_SERVICE_SCHEMA_VERSION,
    serviceId: FIRST_EVENING_SERVICE_ID,
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    revision: 0,
    phase: "IDLE",
    riceBeatIndex: 0,
    presentationChoice: null,
    restorationChoice: null,
    activeOrderIndex: 0,
    orders,
    components: conservedComponents(orders),
    storyFlags: [],
    unlocks: [],
  });
}

export function decodeEveningServiceCheckpoint(input: unknown): EveningServiceCheckpoint {
  assertBoundedJson(input, "$checkpoint");
  const detached = JSON.parse(canonicalJson(input)) as unknown;
  const row = plainObject(detached, "$checkpoint");
  exactKeys(row, ["activeOrderIndex", "components", "contentVersion", "orders", "phase", "presentationChoice", "restorationChoice", "revision", "riceBeatIndex", "schemaVersion", "serviceId", "storyFlags", "unlocks"], "$checkpoint");
  if (row.schemaVersion !== 1 || row.serviceId !== FIRST_EVENING_SERVICE_ID || row.contentVersion !== FIRST_EVENING_CONTENT_VERSION) invalid("The checkpoint is not the pinned first-service schema.");
  const revision = safeRevision(row.revision, "$checkpoint.revision");
  if (!["IDLE", "OPEN", "CLOSING", "SETTLED", "ABANDONED"].includes(row.phase as string)) invalid("Invalid service phase.");
  if (!Number.isSafeInteger(row.riceBeatIndex) || (row.riceBeatIndex as number) < 0 || (row.riceBeatIndex as number) > 3) invalid("Invalid rice beat index.");
  if (!Number.isSafeInteger(row.activeOrderIndex) || (row.activeOrderIndex as number) < 0 || (row.activeOrderIndex as number) > 3) invalid("Invalid active order index.");
  if (row.presentationChoice !== null && !FIRST_EVENING_SERVICE_DEFINITION.presentationChoices.includes(row.presentationChoice as PresentationChoice)) invalid("Invalid presentation choice.");
  if (row.restorationChoice !== null && !FIRST_EVENING_SERVICE_DEFINITION.restorationChoices.includes(row.restorationChoice as RestorationChoice)) invalid("Invalid restoration choice.");
  if (!Array.isArray(row.unlocks) || row.unlocks.some((item) => typeof item !== "string") || new Set(row.unlocks).size !== row.unlocks.length) invalid("Invalid unlock set.");
  if (!Array.isArray(row.storyFlags) || row.storyFlags.some((item) => typeof item !== "string") || new Set(row.storyFlags).size !== row.storyFlags.length) invalid("Invalid story-flag set.");
  if (!Array.isArray(row.orders) || row.orders.length !== FIRST_EVENING_SERVICE_DEFINITION.orders.length) invalid("Invalid service orders.");
  const states: readonly ServiceOrderState[] = ["OFFERED", "ACCEPTED", "PREPARING", "READY_TO_PLATE", "PLATED", "SERVED", "EXPIRED", "FAILED", "DISCARDED"];
  const orders = row.orders.map((value, index) => {
    const order = plainObject(value, `$checkpoint.orders[${index}]`);
    exactKeys(order, ["id", "plateFeedbackRef", "serveFeedbackRef", "state", "stepIndex"], `$checkpoint.orders[${index}]`);
    const definition = FIRST_EVENING_SERVICE_DEFINITION.orders[index]!;
    if (order.id !== definition.id || !states.includes(order.state as ServiceOrderState)
      || !Number.isSafeInteger(order.stepIndex) || (order.stepIndex as number) < 0 || (order.stepIndex as number) > definition.steps.length
      || (order.plateFeedbackRef !== null && order.plateFeedbackRef !== definition.plateFeedbackRef)
      || (order.serveFeedbackRef !== null && order.serveFeedbackRef !== definition.serveFeedbackRef)) invalid("Invalid authored order checkpoint.");
    return order as unknown as ServiceOrderCheckpoint;
  });
  if (!Array.isArray(row.components) || row.components.length !== COMPONENT_IDS.length) invalid("Invalid component ledger.");
  const components = row.components.map((value, index) => {
    const component = plainObject(value, `$checkpoint.components[${index}]`);
    exactKeys(component, ["available", "discarded", "id", "placed", "served", "total"], `$checkpoint.components[${index}]`);
    if (component.id !== COMPONENT_IDS[index] || [component.available, component.discarded, component.placed, component.served, component.total]
      .some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) invalid("Invalid component conservation row.");
    return component as unknown as ServiceComponentCheckpoint;
  });
  const decoded = { ...row, revision, orders, components } as unknown as EveningServiceCheckpoint;
  assertEveningServiceInvariants(decoded);
  return deepFreeze(decoded);
}

export function assertEveningServiceInvariants(checkpoint: EveningServiceCheckpoint): void {
  if (checkpoint.revision > MAX_SAFE_REVISION) invalid("Checkpoint revision exceeds the protocol maximum.");
  const served = checkpoint.orders.filter((order) => order.state === "SERVED").length;
  if (served !== checkpoint.activeOrderIndex) invalid("Served-order conservation does not match the active order index.");
  const expectedStoryFlags = FIRST_EVENING_SERVICE_DEFINITION.orders.slice(0, served).map((order) => order.storyFlagId);
  if (canonicalJson(checkpoint.storyFlags) !== canonicalJson(expectedStoryFlags)) invalid("Continuing story facts must match the served order prefix.");
  checkpoint.orders.forEach((order, index) => {
    const definition = FIRST_EVENING_SERVICE_DEFINITION.orders[index]!;
    if (order.state === "EXPIRED" || order.state === "FAILED") invalid("The forgiving first service cannot persist punitive order outcomes.");
    if (checkpoint.phase === "ABANDONED") {
      if (index < checkpoint.activeOrderIndex && order.state !== "SERVED") invalid("A completed order moved backward during abandonment.");
      if (index >= checkpoint.activeOrderIndex && order.state !== "DISCARDED") invalid("Abandonment must discard every outstanding order.");
    } else {
      if (index < checkpoint.activeOrderIndex && order.state !== "SERVED") invalid("A completed order moved backward.");
      if (index > checkpoint.activeOrderIndex && order.state !== "OFFERED") invalid("A future order advanced early.");
    }
    if (["OFFERED", "ACCEPTED"].includes(order.state) && order.stepIndex !== 0) invalid("An unprepared order cannot consume authored steps.");
    if (order.state === "PREPARING" && (order.stepIndex <= 0 || order.stepIndex >= definition.steps.length)) invalid("A preparing order must be within the authored sequence.");
    if (["READY_TO_PLATE", "PLATED", "SERVED"].includes(order.state) && order.stepIndex !== definition.steps.length) invalid("A prepared order must complete every authored step.");
    if (["PLATED", "SERVED"].includes(order.state) !== (order.plateFeedbackRef === definition.plateFeedbackRef)) invalid("Plate feedback conservation failed.");
    if ((order.state === "SERVED") !== (order.serveFeedbackRef === definition.serveFeedbackRef)) invalid("Serve feedback conservation failed.");
  });
  if (canonicalJson(checkpoint.components) !== canonicalJson(conservedComponents(checkpoint.orders))) invalid("Component conservation does not match the authored order state.");
  const unlocked = checkpoint.unlocks.includes(SALMON_SASHIMI_UNLOCK_ID);
  if ((checkpoint.phase === "SETTLED") !== unlocked || checkpoint.unlocks.length > 1) invalid("The sashimi unlock and settlement must be one exact fact.");
  if (["CLOSING", "SETTLED"].includes(checkpoint.phase) && (served !== 3 || checkpoint.activeOrderIndex !== 3)) invalid("Closing requires all authored orders served.");
  if (checkpoint.phase === "SETTLED" && (!checkpoint.restorationChoice || checkpoint.riceBeatIndex !== 3 || !checkpoint.presentationChoice)) invalid("Settlement prerequisites are incomplete.");
  if (checkpoint.phase !== "SETTLED" && checkpoint.restorationChoice !== null) invalid("Restoration is committed only at settlement.");
  if (checkpoint.phase !== "SETTLED" && checkpoint.unlocks.length !== 0) invalid("Pre-settlement state cannot expose an unlock.");
  const kappa = checkpoint.orders[0]!;
  if (checkpoint.presentationChoice && !["READY_TO_PLATE", "PLATED", "SERVED"].includes(kappa.state)) invalid("Presentation can be chosen only after kappa preparation.");
  if (checkpoint.phase === "IDLE") {
    if (checkpoint.revision !== 0 || checkpoint.riceBeatIndex !== 0 || checkpoint.activeOrderIndex !== 0 || checkpoint.presentationChoice !== null
      || checkpoint.storyFlags.length !== 0 || checkpoint.orders.some((order) => order.state !== "OFFERED")) invalid("Idle must be the exact untouched first-service checkpoint.");
  }
  if (checkpoint.phase === "OPEN") {
    if (checkpoint.revision === 0) invalid("Open state must follow the start transition.");
    if (checkpoint.riceBeatIndex < 3 && (checkpoint.activeOrderIndex !== 0 || checkpoint.presentationChoice !== null
      || checkpoint.orders.some((order) => order.state !== "OFFERED"))) invalid("Rice preparation must precede every order transition.");
    if (checkpoint.activeOrderIndex < 3 && !["OFFERED", "ACCEPTED", "PREPARING", "READY_TO_PLATE", "PLATED"].includes(checkpoint.orders[checkpoint.activeOrderIndex]!.state)) invalid("Open service has an impossible active order state.");
    if (checkpoint.activeOrderIndex > 0 && checkpoint.presentationChoice === null) invalid("Kappa presentation must precede later orders.");
  }
  if (["CLOSING", "SETTLED"].includes(checkpoint.phase)
    && (checkpoint.riceBeatIndex !== 3 || checkpoint.presentationChoice === null || checkpoint.orders.some((order) => order.state !== "SERVED"))) {
    invalid("Closing and settlement require the exact served first-service shape.");
  }
}

function payloadObject(command: CommandEnvelope, expected: readonly string[]): Record<string, unknown> {
  const payload = plainObject(command.payload, "$command.payload");
  exactKeys(payload, expected, "$command.payload");
  return payload;
}

function buildDecision(checkpoint: EveningServiceCheckpoint, command: CommandEnvelope, accepted: boolean, feedbackRef: string, settledNow: boolean, unlockedNow: readonly string[], outcomeClass: OrderOutcomeClass | null = null): EveningServiceDecision {
  const correctiveCueId = accepted ? null : feedbackRef;
  const eventPayload: JsonObject = { serviceId: FIRST_EVENING_SERVICE_ID, commandName: command.commandName, accepted, phase: checkpoint.phase, revision: checkpoint.revision, feedbackRef, settledNow, unlockedNow, outcomeClass };
  return deepFreeze({
    checkpointSchemaVersion: EVENING_SERVICE_SCHEMA_VERSION,
    checkpoint,
    event: { eventRef: command.idempotencyKey, eventType: accepted ? "service.transitioned" : "service.corrective-cue", schemaVersion: EVENING_SERVICE_SCHEMA_VERSION, payload: eventPayload },
    response: { schemaVersion: EVENING_SERVICE_SCHEMA_VERSION, payload: { accepted, checkpoint, feedbackRef, correctiveCueId, settledNow, unlockedNow, outcomeClass } },
  });
}

function correction(checkpoint: EveningServiceCheckpoint, command: CommandEnvelope, cueRef: string): EveningServiceDecision {
  return buildDecision(checkpoint, command, false, cueRef, false, []);
}

function nextCheckpoint(current: EveningServiceCheckpoint, changes: Partial<EveningServiceCheckpoint>): EveningServiceCheckpoint {
  const orders = changes.orders ?? current.orders;
  return decodeEveningServiceCheckpoint({ ...current, ...changes, orders, components: conservedComponents(orders), revision: current.revision + 1 });
}

export function reduceEveningService(checkpointInput: unknown, commandInput: unknown): EveningServiceDecision {
  const checkpoint = decodeEveningServiceCheckpoint(checkpointInput);
  assertBoundedJson(commandInput, "$command");
  const command = deepFreeze(validateCommandEnvelope(JSON.parse(canonicalJson(commandInput))));
  if (command.expectedRevision !== checkpoint.revision || checkpoint.revision === MAX_SAFE_REVISION || command.contentVersion !== FIRST_EVENING_CONTENT_VERSION) invalid("The command does not match the canonical service revision or content version.");
  if (["SETTLED", "ABANDONED"].includes(checkpoint.phase)) return correction(checkpoint, command, "cue.service.complete");

  const definition = FIRST_EVENING_SERVICE_DEFINITION.orders[checkpoint.activeOrderIndex];
  const order = checkpoint.orders[checkpoint.activeOrderIndex];
  switch (command.commandName as EveningServiceCommandName) {
    case "service.start": {
      payloadObject(command, []);
      if (checkpoint.phase !== "IDLE") return correction(checkpoint, command, "cue.start.invalid");
      return buildDecision(nextCheckpoint(checkpoint, { phase: "OPEN" }), command, true, "feedback.service.opened", false, []);
    }
    case "service.prepare-rice": {
      const payload = payloadObject(command, ["beat"]);
      const expected = FIRST_EVENING_SERVICE_DEFINITION.riceBeats[checkpoint.riceBeatIndex];
      if (checkpoint.phase !== "OPEN" || checkpoint.activeOrderIndex !== 0 || checkpoint.orders[0]!.state !== "OFFERED" || payload.beat !== expected) {
        return correction(checkpoint, command, expected ? `cue.rice.expected.${expected}` : "cue.rice.complete");
      }
      return buildDecision(nextCheckpoint(checkpoint, { riceBeatIndex: checkpoint.riceBeatIndex + 1 }), command, true, `feedback.rice.${payload.beat as string}.saved`, false, []);
    }
    case "service.accept-order": {
      const payload = payloadObject(command, ["orderId"]);
      if (checkpoint.phase !== "OPEN" || checkpoint.riceBeatIndex !== 3 || !definition || !order || payload.orderId !== definition.id || order.state !== "OFFERED") {
        return correction(checkpoint, command, definition ? `cue.order.accept.${definition.id}` : "cue.orders.complete");
      }
      const orders = checkpoint.orders.map((item, index) => index === checkpoint.activeOrderIndex ? { ...item, state: "ACCEPTED" as const } : item);
      return buildDecision(nextCheckpoint(checkpoint, { orders }), command, true, definition.dialogueRef, false, []);
    }
    case "service.perform-step": {
      const payload = payloadObject(command, ["orderId", "stepId"]);
      if (checkpoint.phase !== "OPEN" || !definition || !order || payload.orderId !== definition.id || !["ACCEPTED", "PREPARING"].includes(order.state)) {
        return correction(checkpoint, command, definition ? `cue.order.expected.${definition.id}` : "cue.orders.complete");
      }
      const expected = definition.steps[order.stepIndex];
      if (!expected || payload.stepId !== expected.id) return correction(checkpoint, command, expected?.correctiveCueRef ?? `cue.plate.required.${definition.id}`);
      const orders = checkpoint.orders.map((item, index) => index === checkpoint.activeOrderIndex
        ? { ...item, state: order.stepIndex + 1 === definition.steps.length ? "READY_TO_PLATE" as const : "PREPARING" as const, stepIndex: order.stepIndex + 1 }
        : item);
      return buildDecision(nextCheckpoint(checkpoint, { orders }), command, true, expected.promptRef, false, []);
    }
    case "service.choose-presentation": {
      const payload = payloadObject(command, ["choice", "orderId"]);
      if (checkpoint.phase !== "OPEN" || checkpoint.activeOrderIndex !== 0 || order?.state !== "READY_TO_PLATE" || payload.orderId !== definition?.id
        || checkpoint.presentationChoice !== null || !FIRST_EVENING_SERVICE_DEFINITION.presentationChoices.includes(payload.choice as PresentationChoice)) {
        return correction(checkpoint, command, "cue.presentation.invalid");
      }
      return buildDecision(nextCheckpoint(checkpoint, { presentationChoice: payload.choice as PresentationChoice }), command, true, `feedback.presentation.${payload.choice as string}`, false, []);
    }
    case "service.plate-order": {
      const payload = payloadObject(command, ["orderId"]);
      if (checkpoint.phase !== "OPEN" || !definition || !order || payload.orderId !== definition.id || order.state !== "READY_TO_PLATE"
        || (checkpoint.activeOrderIndex === 0 && checkpoint.presentationChoice === null)) return correction(checkpoint, command, definition ? `cue.plate.required.${definition.id}` : "cue.orders.complete");
      const orders = checkpoint.orders.map((item, index) => index === checkpoint.activeOrderIndex
        ? { ...item, state: "PLATED" as const, plateFeedbackRef: definition.plateFeedbackRef }
        : item);
      return buildDecision(nextCheckpoint(checkpoint, { orders }), command, true, definition.plateFeedbackRef, false, []);
    }
    case "service.serve-order": {
      const payload = payloadObject(command, ["orderId"]);
      if (checkpoint.phase !== "OPEN" || !definition || !order || payload.orderId !== definition.id || order.state !== "PLATED") return correction(checkpoint, command, definition ? `cue.serve.required.${definition.id}` : "cue.orders.served");
      const orders = checkpoint.orders.map((item, index) => index === checkpoint.activeOrderIndex
        ? { ...item, state: "SERVED" as const, serveFeedbackRef: definition.serveFeedbackRef }
        : item);
      return buildDecision(nextCheckpoint(checkpoint, {
        orders,
        activeOrderIndex: checkpoint.activeOrderIndex + 1,
        storyFlags: [...checkpoint.storyFlags, definition.storyFlagId],
      }), command, true, definition.serveFeedbackRef, false, [], definition.outcomeClass);
    }
    case "service.close-ledger": {
      payloadObject(command, []);
      if (checkpoint.phase !== "OPEN" || checkpoint.activeOrderIndex !== 3) return correction(checkpoint, command, "cue.ledger.orders-incomplete");
      return buildDecision(nextCheckpoint(checkpoint, { phase: "CLOSING" }), command, true, "feedback.ledger.closed", false, []);
    }
    case "service.choose-restoration": {
      const payload = payloadObject(command, ["choice"]);
      if (checkpoint.phase !== "CLOSING" || !FIRST_EVENING_SERVICE_DEFINITION.restorationChoices.includes(payload.choice as RestorationChoice)) return correction(checkpoint, command, "cue.restoration.invalid");
      const unlocks = [SALMON_SASHIMI_UNLOCK_ID];
      const next = nextCheckpoint(checkpoint, { phase: "SETTLED", restorationChoice: payload.choice as RestorationChoice, unlocks });
      return buildDecision(next, command, true, "feedback.service.settled", true, unlocks);
    }
    case "service.abandon": {
      payloadObject(command, []);
      if (!["OPEN", "CLOSING"].includes(checkpoint.phase)) return correction(checkpoint, command, "cue.abandon.invalid");
      const orders = checkpoint.orders.map((item) => item.state === "SERVED" ? item : { ...item, state: "DISCARDED" as const, plateFeedbackRef: null, serveFeedbackRef: null });
      return buildDecision(nextCheckpoint(checkpoint, { phase: "ABANDONED", orders }), command, true, "feedback.service.abandoned", false, []);
    }
    default:
      invalid("Unknown evening service command.");
  }
}

function assertProjectionManifest(input: EveningServiceProjectionManifest): EveningServiceProjectionManifest {
  assertBoundedJson(input, "$projectionManifest");
  const detached = JSON.parse(canonicalJson(input)) as EveningServiceProjectionManifest;
  if (detached.contentVersion !== FIRST_EVENING_CONTENT_VERSION || canonicalJson(detached.serviceDefinition) !== canonicalJson(FIRST_EVENING_SERVICE_DEFINITION)) invalid("Projection manifest does not match the pinned service definition.");
  if (!Array.isArray(detached.contentRefs) || detached.contentRefs.length === 0 || new Set(detached.contentRefs).size !== detached.contentRefs.length || [...detached.contentRefs].sort().join("|") !== detached.contentRefs.join("|")) invalid("Projection content references must be a sorted unique inventory.");
  return deepFreeze(detached);
}

export function projectEveningService(checkpointInput: unknown, manifestInput: EveningServiceProjectionManifest, contextInput: EveningServiceProjectionContext): EveningServiceProjection {
  const checkpoint = decodeEveningServiceCheckpoint(checkpointInput);
  const manifest = assertProjectionManifest(manifestInput);
  assertBoundedJson(contextInput, "$projectionContext");
  const context = JSON.parse(canonicalJson(contextInput)) as EveningServiceProjectionContext;
  if (!["query", "committed", "replayed", "restored"].includes(context.disposition) || (context.correctiveCueId !== null && typeof context.correctiveCueId !== "string")) invalid("Invalid projection context.");
  const definition = manifest.serviceDefinition.orders[checkpoint.activeOrderIndex];
  const order = checkpoint.orders[checkpoint.activeOrderIndex];
  let currentPromptId = manifest.serviceDefinition.startPromptRef;
  let allowedChoiceIds: readonly string[] = [];
  let primaryCommand: EveningServiceCommandName | null = "service.start";
  const displayRefs: string[] = ["service.first-evening", `phase.${checkpoint.phase.toLowerCase()}`];
  const ledgerRows: EveningServiceLedgerRow[] = [];

  if (checkpoint.phase === "OPEN" && checkpoint.riceBeatIndex < 3) {
    const beat = manifest.serviceDefinition.riceBeats[checkpoint.riceBeatIndex]!;
    currentPromptId = manifest.serviceDefinition.ricePromptRefs[beat];
    allowedChoiceIds = [beat];
    primaryCommand = "service.prepare-rice";
    displayRefs.push(`rice.${beat}`, "station.rice-hearth");
  } else if (checkpoint.phase === "OPEN" && definition && order?.state === "OFFERED") {
    currentPromptId = definition.acceptPromptRef;
    allowedChoiceIds = [definition.id];
    primaryCommand = "service.accept-order";
    displayRefs.push(definition.dialogueRef, `dish.${definition.dishId}`, `guest.${definition.guestRole}`);
  } else if (checkpoint.phase === "OPEN" && definition && order && ["ACCEPTED", "PREPARING"].includes(order.state)) {
    const step = definition.steps[order.stepIndex]!;
    currentPromptId = step.promptRef;
    allowedChoiceIds = [step.id];
    primaryCommand = "service.perform-step";
    displayRefs.push(`dish.${definition.dishId}`, `guest.${definition.guestRole}`, `station.${step.station}`);
  } else if (checkpoint.phase === "OPEN" && definition && order?.state === "READY_TO_PLATE" && checkpoint.activeOrderIndex === 0 && !checkpoint.presentationChoice) {
    currentPromptId = "prompt.presentation.choose";
    allowedChoiceIds = manifest.serviceDefinition.presentationChoices;
    primaryCommand = "service.choose-presentation";
  } else if (checkpoint.phase === "OPEN" && definition && order?.state === "READY_TO_PLATE") {
    currentPromptId = definition.platePromptRef;
    allowedChoiceIds = [definition.id];
    primaryCommand = "service.plate-order";
  } else if (checkpoint.phase === "OPEN" && definition && order?.state === "PLATED") {
    currentPromptId = `prompt.serve.${definition.id}`;
    allowedChoiceIds = [definition.id];
    primaryCommand = "service.serve-order";
    displayRefs.push(definition.plateFeedbackRef);
  } else if (checkpoint.phase === "OPEN") {
    currentPromptId = manifest.serviceDefinition.closePromptRef;
    primaryCommand = "service.close-ledger";
    displayRefs.push("ledger.first-evening");
  } else if (checkpoint.phase === "CLOSING") {
    currentPromptId = manifest.serviceDefinition.restorationPromptRef;
    allowedChoiceIds = manifest.serviceDefinition.restorationChoices;
    primaryCommand = "service.choose-restoration";
    displayRefs.push("ledger.first-evening");
  } else if (checkpoint.phase === "SETTLED") {
    currentPromptId = manifest.serviceDefinition.settledPromptRef;
    primaryCommand = null;
    displayRefs.push("ledger.first-evening", `unlock.${SALMON_SASHIMI_UNLOCK_ID}`);
  } else if (checkpoint.phase === "ABANDONED") {
    currentPromptId = manifest.serviceDefinition.abandonedPromptRef;
    primaryCommand = null;
  }
  checkpoint.orders.forEach((item, index) => {
    if (item.state === "SERVED" && item.serveFeedbackRef) {
      const servedDefinition = manifest.serviceDefinition.orders[index]!;
      const row: EveningServiceLedgerRow = {
        orderId: servedDefinition.id,
        guestRef: `guest.${servedDefinition.guestRole}`,
        dishRef: `dish.${servedDefinition.dishId}`,
        outcomeRef: `outcome.${servedDefinition.outcomeClass}`,
        plateFeedbackRef: item.plateFeedbackRef!,
        serveFeedbackRef: item.serveFeedbackRef,
        storyFlagRef: `story-flag.${servedDefinition.storyFlagId}`,
        persistentConsequenceRef: servedDefinition.persistentConsequenceRef,
      };
      ledgerRows.push(row);
      displayRefs.push(row.guestRef, row.dishRef, row.outcomeRef, row.plateFeedbackRef, row.serveFeedbackRef, row.storyFlagRef, row.persistentConsequenceRef);
    }
  });
  if (checkpoint.presentationChoice) displayRefs.push(`presentation.${checkpoint.presentationChoice}`);
  if (checkpoint.restorationChoice) displayRefs.push(`restoration.${checkpoint.restorationChoice}`);
  const refs = [currentPromptId, ...displayRefs, ...(context.correctiveCueId ? [context.correctiveCueId] : [])];
  if (refs.some((ref) => !manifest.contentRefs.includes(ref))) invalid("Projection selected a reference outside the pinned content manifest.");
  return deepFreeze({
    currentPromptId,
    allowedChoiceIds: [...allowedChoiceIds],
    primaryCommand,
    correctiveCueId: context.correctiveCueId,
    displayRefs: [...new Set(displayRefs)],
    ledgerRows,
    disposition: context.disposition,
    announceCeremony: context.disposition === "committed" && context.correctiveCueId === null,
  });
}

export function canonicalEveningServiceBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export const eveningServiceProfile = Object.freeze({
  schemaVersion: EVENING_SERVICE_SCHEMA_VERSION,
  serviceId: FIRST_EVENING_SERVICE_ID,
  contentVersion: FIRST_EVENING_CONTENT_VERSION,
  settlementUnlock: SALMON_SASHIMI_UNLOCK_ID,
} as const);
