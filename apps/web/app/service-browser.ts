"use client";

import { FIRST_SERVICE_BROWSER_INVENTORY } from "./service-browser-inventory.generated";

export const SERVICE_QUERY_PATH = "/api/account/service";
export const SERVICE_COMMAND_PATH = "/api/account/service/command";
export const COOKIE_RESET_PATH = "/api/account/cookies/reset";
export const GUEST_ISSUE_PATH = "/api/account/guest/issue";
const SERVICE_AUTHORITY_REJECTION = Object.freeze({
  code: "SERVICE_AUTHORITY_REJECTED",
  message: "Service access could not be authenticated.",
});
const SERVICE_CREDENTIAL_REFRESHED = Object.freeze({
  code: "SERVICE_CREDENTIAL_REFRESHED",
  message: "Service access was refreshed. Requery the saved service.",
});

export type ServicePhase = "IDLE" | "OPEN" | "CLOSING" | "SETTLED" | "ABANDONED";
export type ServiceDisposition = "query" | "committed" | "replayed" | "restored";

export interface ViewCopy {
  readonly ref: string;
  readonly text: string;
  readonly reviewId: string;
  readonly reviewStatus: "review-pending";
}

export interface ViewAsset {
  readonly key: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly nonColorIdentity: string;
  readonly reviewId: string;
  readonly reviewStatus: "review-pending";
}

export interface ViewChoice {
  readonly id: string;
  readonly label: ViewCopy;
  readonly actionLabel: ViewCopy;
  readonly commandName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly asset: ViewAsset | null;
}

export interface ViewOrder {
  readonly orderId: string;
  readonly guest: ViewCopy;
  readonly dish: ViewCopy;
  readonly status: ViewCopy;
  readonly stepIndex: number;
  readonly stepTotal: number;
  readonly active: boolean;
  readonly portrait: ViewAsset;
  readonly dishAsset: ViewAsset;
}

export interface ViewLedgerRow {
  readonly orderId: string;
  readonly guest: ViewCopy;
  readonly dish: ViewCopy;
  readonly outcome: ViewCopy;
  readonly plateFeedback: ViewCopy;
  readonly serveFeedback: ViewCopy;
  readonly storyFlag: ViewCopy;
  readonly consequence: ViewCopy;
}

export interface ViewSceneLayer {
  readonly asset: ViewAsset;
  readonly x: number;
  readonly y: number;
}

export interface ServiceView {
  readonly schemaVersion: 1;
  readonly contentVersion: "phase-1-evening-service-v1";
  readonly revision: number;
  readonly generation: number;
  readonly identity: "guest" | "player";
  readonly identityLabel: "Guest play · no wallet" | "Saved play · no wallet";
  readonly phase: ServicePhase;
  readonly prompt: ViewCopy;
  readonly correctiveCue: ViewCopy | null;
  readonly facts: readonly ViewCopy[];
  readonly choices: readonly ViewChoice[];
  readonly abandonChoice: ViewChoice | null;
  readonly orders: readonly ViewOrder[];
  readonly ledgerRows: readonly ViewLedgerRow[];
  readonly scene: ViewAsset;
  readonly sceneLayers: readonly ViewSceneLayer[];
  readonly restoration: ViewAsset | null;
  readonly unlock: ViewAsset;
  readonly disposition: ServiceDisposition;
  readonly announceCeremony: boolean;
}

export interface IntentEnvelope {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly commandName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly canonicalBody: string;
}

const COPY_REFS = new Set<string>(FIRST_SERVICE_BROWSER_INVENTORY.copyRefs);
const ASSET_DIMENSIONS = FIRST_SERVICE_BROWSER_INVENTORY.assetDimensions as Readonly<Record<string, readonly [number, number]>>;
const COPY = FIRST_SERVICE_BROWSER_INVENTORY.copy as Readonly<Record<string, { readonly text: string; readonly reviewId: string; readonly reviewStatus: "review-pending" }>>;
const ASSETS = FIRST_SERVICE_BROWSER_INVENTORY.assets as Readonly<Record<string, Omit<ViewAsset, "key">>>;
const SCENE_ANCHORS = FIRST_SERVICE_BROWSER_INVENTORY.sceneAnchors as Readonly<Record<string, readonly [number, number]>>;
const ORDER_STATUS_REFS = new Set<string>(FIRST_SERVICE_BROWSER_INVENTORY.orderStatusRefs);
const ORDER_IDS = FIRST_SERVICE_BROWSER_INVENTORY.orderIds as readonly string[];
const ORDER_BINDINGS = FIRST_SERVICE_BROWSER_INVENTORY.orderBindings as Readonly<Record<string, { readonly guestRef: string; readonly dishRef: string }>>;
const LEDGER_BINDINGS = FIRST_SERVICE_BROWSER_INVENTORY.ledgerBindings as Readonly<Record<string, {
  readonly guestRef: string; readonly dishRef: string; readonly outcomeRef: string; readonly plateFeedbackRef: string;
  readonly serveFeedbackRef: string; readonly storyFlagRef: string; readonly consequenceRef: string;
}>>;
const COMMANDS = new Set<string>(FIRST_SERVICE_BROWSER_INVENTORY.commandNames);
const PROMPT_COMMANDS = FIRST_SERVICE_BROWSER_INVENTORY.promptCommands as Readonly<Record<string, string>>;
interface PromptViewSpec {
  readonly phase: ServicePhase;
  readonly choices: readonly { readonly id: string; readonly labelRef: string; readonly actionLabelRef: string; readonly commandName: string; readonly payload: Readonly<Record<string, unknown>>; readonly assetKey: string | null }[];
  readonly facts: readonly string[];
  readonly orders: readonly { readonly orderId: string; readonly statusRef: string; readonly stepIndex: number; readonly stepTotal: number; readonly active: boolean; readonly portraitKey: string; readonly dishAssetKey: string }[];
  readonly ledgerOrderIds: readonly string[];
  readonly sceneKey: string;
  readonly sceneLayers: readonly { readonly assetKey: string; readonly x: number; readonly y: number }[];
  readonly restorationKey: string | null;
  readonly unlockKey: string;
}
const PROMPT_VIEWS = FIRST_SERVICE_BROWSER_INVENTORY.promptViews as Readonly<Record<string, PromptViewSpec>>;
const STEPS = FIRST_SERVICE_BROWSER_INVENTORY.steps as Readonly<Record<string, readonly string[]>>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} unavailable`);
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${path} unavailable`);
  return row;
}

function boundedString(value: unknown, path: string, limit = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit) throw new Error(`${path} unavailable`);
  return value;
}

function safeInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`${path} unavailable`);
  return value as number;
}

function boundedArray(value: unknown, path: string, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${path} unavailable`);
  return value;
}

function copy(value: unknown, path: string): ViewCopy {
  const row = record(value, ["ref", "text", "reviewId", "reviewStatus"], path);
  const expected = COPY[String(row.ref)];
  if (row.reviewStatus !== "review-pending" || !COPY_REFS.has(String(row.ref)) || !expected
    || row.text !== expected.text || row.reviewId !== expected.reviewId || row.reviewStatus !== expected.reviewStatus
    || !FIRST_SERVICE_BROWSER_INVENTORY.reviewIds.includes(row.reviewId as never)) throw new Error(`${path} unavailable`);
  return Object.freeze({ ref: boundedString(row.ref, `${path}.ref`, 160), text: boundedString(row.text, `${path}.text`, 1024), reviewId: boundedString(row.reviewId, `${path}.reviewId`, 160), reviewStatus: "review-pending" });
}

function asset(value: unknown, path: string): ViewAsset {
  const row = record(value, ["key", "path", "width", "height", "nonColorIdentity", "reviewId", "reviewStatus"], path);
  const key = boundedString(row.key, `${path}.key`, 96);
  const assetPath = boundedString(row.path, `${path}.path`, 180);
  const width = safeInteger(row.width, `${path}.width`, 512);
  const height = safeInteger(row.height, `${path}.height`, 512);
  const expected = ASSET_DIMENSIONS[key];
  const expectedAsset = ASSETS[key];
  if (!/^[a-z0-9-]+$/.test(key) || assetPath !== `/service-assets/first-service.svg#${key}` || row.reviewStatus !== "review-pending"
    || !expected || width < 1 || height < 1 || expected[0] !== width || expected[1] !== height
    || !expectedAsset || row.path !== expectedAsset.path || row.nonColorIdentity !== expectedAsset.nonColorIdentity || row.reviewId !== expectedAsset.reviewId
    || !FIRST_SERVICE_BROWSER_INVENTORY.reviewIds.includes(row.reviewId as never)) throw new Error(`${path} unavailable`);
  return Object.freeze({ key, path: assetPath, width, height, nonColorIdentity: boundedString(row.nonColorIdentity, `${path}.nonColorIdentity`, 512), reviewId: boundedString(row.reviewId, `${path}.reviewId`, 160), reviewStatus: "review-pending" });
}

function payload(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 4) throw new Error(`${path} unavailable`);
  const detached = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (JSON.stringify(detached).length > 1024) throw new Error(`${path} unavailable`);
  return deepFreeze(detached);
}

function choice(value: unknown, path: string): ViewChoice {
  const row = record(value, ["id", "label", "actionLabel", "commandName", "payload", "asset"], path);
  const commandName = boundedString(row.commandName, `${path}.commandName`, 96);
  if (!COMMANDS.has(commandName)) throw new Error(`${path} unavailable`);
  return Object.freeze({ id: boundedString(row.id, `${path}.id`, 96), label: copy(row.label, `${path}.label`), actionLabel: copy(row.actionLabel, `${path}.actionLabel`), commandName, payload: payload(row.payload, `${path}.payload`), asset: row.asset === null ? null : asset(row.asset, `${path}.asset`) });
}

function order(value: unknown, path: string): ViewOrder {
  const row = record(value, ["orderId", "guest", "dish", "status", "stepIndex", "stepTotal", "active", "portrait", "dishAsset"], path);
  if (typeof row.active !== "boolean") throw new Error(`${path} unavailable`);
  const status = copy(row.status, `${path}.status`);
  const stepIndex = safeInteger(row.stepIndex, `${path}.stepIndex`, 16);
  const stepTotal = safeInteger(row.stepTotal, `${path}.stepTotal`, 16);
  if (!ORDER_STATUS_REFS.has(status.ref) || stepIndex > stepTotal) throw new Error(`${path} unavailable`);
  return Object.freeze({ orderId: boundedString(row.orderId, `${path}.orderId`, 96), guest: copy(row.guest, `${path}.guest`), dish: copy(row.dish, `${path}.dish`), status, stepIndex, stepTotal, active: row.active, portrait: asset(row.portrait, `${path}.portrait`), dishAsset: asset(row.dishAsset, `${path}.dishAsset`) });
}

function ledger(value: unknown, path: string): ViewLedgerRow {
  const row = record(value, ["orderId", "guest", "dish", "outcome", "plateFeedback", "serveFeedback", "storyFlag", "consequence"], path);
  return Object.freeze({ orderId: boundedString(row.orderId, `${path}.orderId`, 96), guest: copy(row.guest, `${path}.guest`), dish: copy(row.dish, `${path}.dish`), outcome: copy(row.outcome, `${path}.outcome`), plateFeedback: copy(row.plateFeedback, `${path}.plateFeedback`), serveFeedback: copy(row.serveFeedback, `${path}.serveFeedback`), storyFlag: copy(row.storyFlag, `${path}.storyFlag`), consequence: copy(row.consequence, `${path}.consequence`) });
}

function sceneLayer(value: unknown, path: string): ViewSceneLayer {
  const row = record(value, ["asset", "x", "y"], path);
  return Object.freeze({ asset: asset(row.asset, `${path}.asset`), x: safeInteger(row.x, `${path}.x`, 320), y: safeInteger(row.y, `${path}.y`, 180) });
}

function exactPayload(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validChoice(choiceItem: ViewChoice, activeOrderId: string | null): boolean {
  const value = choiceItem.payload;
  switch (choiceItem.commandName) {
    case "service.start":
    case "service.start-new":
    case "service.close-ledger": return choiceItem.id === "primary" && exactPayload(value, []);
    case "service.prepare-rice": return exactPayload(value, ["beat"]) && value.beat === choiceItem.id && FIRST_SERVICE_BROWSER_INVENTORY.riceBeats.includes(choiceItem.id as never);
    case "service.accept-order": return exactPayload(value, ["orderId"]) && value.orderId === choiceItem.id && ORDER_IDS.includes(choiceItem.id);
    case "service.perform-step": return Boolean(activeOrderId && exactPayload(value, ["orderId", "stepId"]) && value.orderId === activeOrderId && value.stepId === choiceItem.id && STEPS[activeOrderId]?.includes(choiceItem.id));
    case "service.choose-presentation": return Boolean(activeOrderId && exactPayload(value, ["choice", "orderId"]) && value.orderId === activeOrderId && value.choice === choiceItem.id && FIRST_SERVICE_BROWSER_INVENTORY.presentationChoices.includes(choiceItem.id as never));
    case "service.plate-order":
    case "service.serve-order": return Boolean(activeOrderId && exactPayload(value, ["orderId"]) && value.orderId === activeOrderId && choiceItem.id === activeOrderId);
    case "service.choose-restoration": return exactPayload(value, ["choice"]) && value.choice === choiceItem.id && FIRST_SERVICE_BROWSER_INVENTORY.restorationChoices.includes(choiceItem.id as never);
    case "service.abandon": return choiceItem.id === "abandon" && exactPayload(value, []);
    default: return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function choiceMatchesSpec(actual: ViewChoice, expected: PromptViewSpec["choices"][number]): boolean {
  return actual.id === expected.id && actual.label.ref === expected.labelRef && actual.actionLabel.ref === expected.actionLabelRef
    && actual.commandName === expected.commandName && sameJson(actual.payload, expected.payload)
    && (actual.asset?.key ?? null) === expected.assetKey;
}

function orderMatchesSpec(actual: ViewOrder, expected: PromptViewSpec["orders"][number]): boolean {
  return actual.orderId === expected.orderId && actual.status.ref === expected.statusRef && actual.stepIndex === expected.stepIndex
    && actual.stepTotal === expected.stepTotal && actual.active === expected.active && actual.portrait.key === expected.portraitKey
    && actual.dishAsset.key === expected.dishAssetKey;
}

function ledgerMatchesBinding(row: ViewLedgerRow): boolean {
  const expected = LEDGER_BINDINGS[row.orderId];
  return Boolean(expected && row.guest.ref === expected.guestRef && row.dish.ref === expected.dishRef
    && row.outcome.ref === expected.outcomeRef && row.plateFeedback.ref === expected.plateFeedbackRef
    && row.serveFeedback.ref === expected.serveFeedbackRef && row.storyFlag.ref === expected.storyFlagRef
    && row.consequence.ref === expected.consequenceRef);
}

function normalizeVariantFact(ref: string): string {
  if (FIRST_SERVICE_BROWSER_INVENTORY.presentationChoices.some((choiceId) => ref === `presentation.${choiceId}`)) return "presentation.indigo-rim";
  if (FIRST_SERVICE_BROWSER_INVENTORY.restorationChoices.some((choiceId) => ref === `restoration.${choiceId}`)) return "restoration.mend-counter-stool";
  return ref;
}

function factsMatchSpec(actual: readonly ViewCopy[], expected: readonly string[]): boolean {
  return sameJson(actual.map((item) => normalizeVariantFact(item.ref)), expected.map(normalizeVariantFact));
}

function abandonedShapeIsExact(orders: readonly ViewOrder[], ledgerRows: readonly ViewLedgerRow[], facts: readonly ViewCopy[]): boolean {
  const servedCount = ledgerRows.length;
  if (servedCount > ORDER_IDS.length || ledgerRows.some((row, index) => row.orderId !== ORDER_IDS[index] || !ledgerMatchesBinding(row))) return false;
  const discarded = PROMPT_VIEWS["prompt.service.abandoned"]?.orders;
  const served = PROMPT_VIEWS["prompt.service.settled"]?.orders;
  if (!discarded || !served) return false;
  for (const [index, orderItem] of orders.entries()) {
    const expected = index < servedCount ? served[index] : discarded[index];
    if (!expected || orderItem.orderId !== expected.orderId || orderItem.status.ref !== expected.statusRef || orderItem.stepTotal !== expected.stepTotal
      || orderItem.active || orderItem.portrait.key !== expected.portraitKey || orderItem.dishAsset.key !== expected.dishAssetKey) return false;
    if (index < servedCount && orderItem.stepIndex !== orderItem.stepTotal) return false;
    if (index > servedCount && orderItem.stepIndex !== 0) return false;
  }
  const expectedFacts = ["service.first-evening", "phase.abandoned"];
  for (const row of ledgerRows) {
    const binding = LEDGER_BINDINGS[row.orderId]!;
    expectedFacts.push(binding.guestRef, binding.dishRef, binding.outcomeRef, binding.plateFeedbackRef,
      binding.serveFeedbackRef, binding.storyFlagRef, binding.consequenceRef);
  }
  const presentation = facts.map((item) => item.ref).filter((ref) => ref.startsWith("presentation."));
  if (presentation.length > 1) return false;
  expectedFacts.push(...presentation);
  return factsMatchSpec(facts, expectedFacts);
}

export function decodeServiceResponse(value: unknown): ServiceView {
  const outer = record(value, ["view"], "$response");
  const row = record(outer.view, ["schemaVersion", "contentVersion", "revision", "generation", "identity", "identityLabel", "phase", "prompt", "correctiveCue", "facts", "choices", "abandonChoice", "orders", "ledgerRows", "scene", "sceneLayers", "restoration", "unlock", "disposition", "announceCeremony"], "$response.view");
  if (row.schemaVersion !== 1 || row.contentVersion !== "phase-1-evening-service-v1" || !["guest", "player"].includes(row.identity as string)
    || (row.identity === "guest" ? row.identityLabel !== "Guest play · no wallet" : row.identityLabel !== "Saved play · no wallet")
    || !["IDLE", "OPEN", "CLOSING", "SETTLED", "ABANDONED"].includes(row.phase as string)
    || !["query", "committed", "replayed", "restored"].includes(row.disposition as string) || typeof row.announceCeremony !== "boolean") throw new Error("$response.view unavailable");
  const facts = boundedArray(row.facts, "$response.view.facts", 64).map((item, index) => copy(item, `$response.view.facts[${index}]`));
  const choices = boundedArray(row.choices, "$response.view.choices", 8).map((item, index) => choice(item, `$response.view.choices[${index}]`));
  const orders = boundedArray(row.orders, "$response.view.orders", 3).map((item, index) => order(item, `$response.view.orders[${index}]`));
  const ledgerRows = boundedArray(row.ledgerRows, "$response.view.ledgerRows", 3).map((item, index) => ledger(item, `$response.view.ledgerRows[${index}]`));
  const sceneLayers = boundedArray(row.sceneLayers, "$response.view.sceneLayers", 2).map((item, index) => sceneLayer(item, `$response.view.sceneLayers[${index}]`));
  const abandonChoice = row.abandonChoice === null ? null : choice(row.abandonChoice, "$response.view.abandonChoice");
  const prompt = copy(row.prompt, "$response.view.prompt");
  const phase = row.phase as ServicePhase;
  const generation = safeInteger(row.generation, "$response.view.generation");
  const activeOrder = orders.find((item) => item.active)?.orderId ?? null;
  const expectedCommand = PROMPT_COMMANDS[prompt.ref];
  const promptView = PROMPT_VIEWS[prompt.ref];
  const scene = asset(row.scene, "$response.view.scene");
  const restoration = row.restoration === null ? null : asset(row.restoration, "$response.view.restoration");
  const unlock = asset(row.unlock, "$response.view.unlock");
  const correctiveCue = row.correctiveCue === null ? null : copy(row.correctiveCue, "$response.view.correctiveCue");
  const exactAbandonChoice = abandonChoice === null || (abandonChoice.id === "abandon"
    && abandonChoice.label.ref === "action.service.abandon" && abandonChoice.actionLabel.ref === "action.service.abandon"
    && abandonChoice.commandName === "service.abandon" && sameJson(abandonChoice.payload, {}) && abandonChoice.asset === null);
  const exactPromptShape = Boolean(promptView && phase === promptView.phase
    && choices.length === promptView.choices.length && choices.every((item, index) => choiceMatchesSpec(item, promptView.choices[index]!))
    && (phase === "ABANDONED" ? abandonedShapeIsExact(orders, ledgerRows, facts)
      : orders.length === promptView.orders.length && orders.every((item, index) => orderMatchesSpec(item, promptView.orders[index]!))
        && sameJson(ledgerRows.map((item) => item.orderId), promptView.ledgerOrderIds) && factsMatchSpec(facts, promptView.facts)));
  const disposition = row.disposition as ServiceDisposition;
  const exactCeremony = row.announceCeremony === (disposition === "committed" && correctiveCue === null)
    && (!["query", "restored"].includes(disposition) || correctiveCue === null);
  const exactScene = scene.key === promptView?.sceneKey && (phase === "SETTLED"
    ? Boolean(restoration && FIRST_SERVICE_BROWSER_INVENTORY.restorationChoices.some((choiceId) => restoration.key === `restoration-${choiceId.replace("mend-counter-stool", "counter-stool").replace("polish-display-shelf", "display-shelf").replace("refresh-menu-board", "menu-board")}`)
      && sceneLayers.length === 2 && sceneLayers[1]?.asset.key === restoration.key)
    : restoration === null && sceneLayers.length === 1)
    && (phase === "SETTLED" ? unlock.key === "dish-salmon-sashimi" : ["dish-salmon-sashimi-locked", "dish-salmon-sashimi"].includes(unlock.key));
  if (orders.length !== 3 || orders.some((item, index) => item.orderId !== ORDER_IDS[index]
    || item.guest.ref !== ORDER_BINDINGS[item.orderId]?.guestRef || item.dish.ref !== ORDER_BINDINGS[item.orderId]?.dishRef)
    || !exactPromptShape || !exactCeremony || !exactScene || (phase === "IDLE" && generation !== 0)
    || new Set(choices.map((item) => item.id)).size !== choices.length || choices.some((item) => !validChoice(item, activeOrder))
    || (choices.length > 0 && (!expectedCommand || choices.some((item) => item.commandName !== expectedCommand)))
    || (phase === "SETTLED" ? choices.length !== 0 : choices.length === 0)
    || !exactAbandonChoice || (["OPEN", "CLOSING"].includes(phase) ? !abandonChoice || !validChoice(abandonChoice, activeOrder) : abandonChoice !== null)
    || orders.filter((item) => item.active).length > 1 || (phase !== "OPEN" && activeOrder !== null)
    || sceneLayers.length < 1 || sceneLayers.some((layer) => {
      const expected = SCENE_ANCHORS[layer.asset.key];
      return !expected || expected[0] !== layer.x || expected[1] !== layer.y;
    }) || sceneLayers[0]?.asset.key !== "counter-lamp-lit"
    || (row.restoration === null ? sceneLayers.length !== 1 : sceneLayers.length !== 2 || sceneLayers[1]?.asset.key !== (row.restoration as Record<string, unknown>).key)
    || ledgerRows.some((item) => !ORDER_IDS.includes(item.orderId) || !ledgerMatchesBinding(item))) {
    throw new Error("$response.view unavailable");
  }
  return deepFreeze({ schemaVersion: 1, contentVersion: "phase-1-evening-service-v1", revision: safeInteger(row.revision, "$response.view.revision"), generation, identity: row.identity as "guest" | "player", identityLabel: row.identityLabel as ServiceView["identityLabel"], phase, prompt, correctiveCue, facts, choices, abandonChoice, orders, ledgerRows, scene, sceneLayers, restoration, unlock, disposition, announceCeremony: row.announceCeremony });
}

export async function isServiceAuthorityRejection(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const row = record(await response.json(), ["code", "message"], "$response");
    return row.code === SERVICE_AUTHORITY_REJECTION.code && row.message === SERVICE_AUTHORITY_REJECTION.message;
  } catch {
    return false;
  }
}

export async function isServiceCredentialRefreshed(response: Response): Promise<boolean> {
  if (response.status !== 428) return false;
  try {
    const row = record(await response.json(), ["code", "message"], "$response");
    return row.code === SERVICE_CREDENTIAL_REFRESHED.code && row.message === SERVICE_CREDENTIAL_REFRESHED.message;
  } catch {
    return false;
  }
}

export function createIntentEnvelope(view: ServiceView, choice: ViewChoice): IntentEnvelope {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("Secure intent generation is unavailable.");
  const idempotencyKey = globalThis.crypto.randomUUID();
  const body = { idempotencyKey, expectedRevision: view.revision, commandName: choice.commandName, payload: choice.payload };
  return deepFreeze({ ...body, canonicalBody: JSON.stringify(body) });
}

export async function postJson(path: string, canonicalBody: string, signal?: AbortSignal): Promise<Response> {
  if (![SERVICE_QUERY_PATH, SERVICE_COMMAND_PATH, COOKIE_RESET_PATH, GUEST_ISSUE_PATH].includes(path) || !path.startsWith("/")) throw new Error("Request path unavailable.");
  return fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: canonicalBody, signal: signal ?? null });
}
