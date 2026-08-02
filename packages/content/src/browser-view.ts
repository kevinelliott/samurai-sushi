import type { JsonObject } from "@samurai-sushi/domain";
import {
  FIRST_EVENING_CONTENT_VERSION,
  type EveningServiceCheckpoint,
  type EveningServiceCommandName,
  type EveningServiceProjection,
  type FirstServiceOrderId,
} from "@samurai-sushi/domain/evening-service";
import { contentHashFor } from "./hash";
import { firstEveningServiceSource } from "./service";
import { FIRST_SERVICE_SPRITE_ATTESTATION } from "./browser-assets-attestation.generated";

export interface BrowserServiceCopy {
  readonly ref: string;
  readonly text: string;
  readonly reviewId: string;
  readonly reviewStatus: "review-pending";
}

export interface BrowserServiceAsset {
  readonly key: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly nonColorIdentity: string;
  readonly reviewId: string;
  readonly reviewStatus: "review-pending";
}

export interface BrowserServiceChoice {
  readonly id: string;
  readonly label: BrowserServiceCopy;
  readonly actionLabel: BrowserServiceCopy;
  readonly commandName: EveningServiceCommandName;
  readonly payload: JsonObject;
  readonly asset: BrowserServiceAsset | null;
}

export interface BrowserServiceOrderRow {
  readonly orderId: FirstServiceOrderId;
  readonly guest: BrowserServiceCopy;
  readonly dish: BrowserServiceCopy;
  readonly status: BrowserServiceCopy;
  readonly stepIndex: number;
  readonly stepTotal: number;
  readonly active: boolean;
  readonly portrait: BrowserServiceAsset;
  readonly dishAsset: BrowserServiceAsset;
}

export interface BrowserServiceLedgerRow {
  readonly orderId: FirstServiceOrderId;
  readonly guest: BrowserServiceCopy;
  readonly dish: BrowserServiceCopy;
  readonly outcome: BrowserServiceCopy;
  readonly plateFeedback: BrowserServiceCopy;
  readonly serveFeedback: BrowserServiceCopy;
  readonly storyFlag: BrowserServiceCopy;
  readonly consequence: BrowserServiceCopy;
}

export interface BrowserServiceSceneLayer {
  readonly asset: BrowserServiceAsset;
  readonly x: number;
  readonly y: number;
}

export interface BrowserEveningServiceView {
  readonly schemaVersion: 1;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly revision: number;
  readonly identity: "guest" | "player";
  readonly identityLabel: "Guest play · no wallet" | "Saved play · no wallet";
  readonly phase: "IDLE" | "OPEN" | "CLOSING" | "SETTLED" | "ABANDONED";
  readonly prompt: BrowserServiceCopy;
  readonly correctiveCue: BrowserServiceCopy | null;
  readonly facts: readonly BrowserServiceCopy[];
  readonly choices: readonly BrowserServiceChoice[];
  readonly abandonChoice: BrowserServiceChoice | null;
  readonly orders: readonly BrowserServiceOrderRow[];
  readonly ledgerRows: readonly BrowserServiceLedgerRow[];
  readonly scene: BrowserServiceAsset;
  readonly sceneLayers: readonly BrowserServiceSceneLayer[];
  readonly restoration: BrowserServiceAsset | null;
  readonly unlock: BrowserServiceAsset;
  readonly disposition: "query" | "committed" | "replayed" | "restored";
  readonly announceCeremony: boolean;
}

export interface AttestedBrowserServiceAsset extends BrowserServiceAsset {
  readonly digest: string;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

const copyByRef = new Map(firstEveningServiceSource.copy.map((entry) => [entry.key, entry]));

function resolveCopy(ref: string): BrowserServiceCopy {
  const entry = copyByRef.get(ref);
  if (!entry) throw new Error(`Browser view cannot resolve copy ref: ${ref}`);
  return freeze({ ref: entry.key, text: entry.text, reviewId: entry.reviewId, reviewStatus: entry.status });
}

function dimensions(value: string): readonly [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Browser asset has invalid dimensions: ${value}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 512 || height > 512) {
    throw new Error(`Browser asset exceeds its dimension bound: ${value}`);
  }
  return [width, height];
}

export const attestedFirstServiceBrowserAssets: readonly AttestedBrowserServiceAsset[] = freeze(
  firstEveningServiceSource.artRequirements.map((requirement) => {
    const [width, height] = dimensions(requirement.dimensions);
    const path = `/service-assets/first-service.svg#${requirement.key}`;
    return {
      key: requirement.key,
      path,
      width,
      height,
      nonColorIdentity: requirement.nonColorIdentity,
      reviewId: requirement.reviewId,
      reviewStatus: "review-pending" as const,
      digest: (FIRST_SERVICE_SPRITE_ATTESTATION.symbolDigests as Readonly<Record<string, string>>)[requirement.key]!,
    };
  }),
);

export const firstServiceBrowserAssetManifestHash = contentHashFor({ fileDigest: FIRST_SERVICE_SPRITE_ATTESTATION.fileDigest, assets: attestedFirstServiceBrowserAssets });

const assetByKey = new Map(attestedFirstServiceBrowserAssets.map((asset) => [asset.key, asset]));

function resolveAsset(key: string): BrowserServiceAsset {
  const entry = assetByKey.get(key);
  if (!entry) throw new Error(`Browser view cannot resolve asset key: ${key}`);
  return freeze({
    key: entry.key,
    path: entry.path,
    width: entry.width,
    height: entry.height,
    nonColorIdentity: entry.nonColorIdentity,
    reviewId: entry.reviewId,
    reviewStatus: entry.reviewStatus,
  });
}

function presentationAsset(choiceId: string): BrowserServiceAsset | null {
  return choiceId === "indigo-rim" || choiceId === "sand-speckle" ? resolveAsset(`presentation-${choiceId}`) : null;
}

function restorationAsset(choiceId: string): BrowserServiceAsset | null {
  const keys: Record<string, string> = {
    "mend-counter-stool": "restoration-counter-stool",
    "polish-display-shelf": "restoration-display-shelf",
    "refresh-menu-board": "restoration-menu-board",
  };
  return keys[choiceId] ? resolveAsset(keys[choiceId]!) : null;
}

function choiceLabelRef(projection: EveningServiceProjection, choiceId: string): string {
  if (projection.primaryCommand === "service.choose-presentation") return `presentation.${choiceId}`;
  if (projection.primaryCommand === "service.choose-restoration") return `restoration.${choiceId}`;
  return projection.currentPromptId;
}

function choiceActionRef(projection: EveningServiceProjection, choiceId: string): string {
  if (projection.primaryCommand === "service.choose-presentation") return `action.presentation.${choiceId}`;
  if (projection.primaryCommand === "service.choose-restoration") return `action.restoration.${choiceId}`;
  return projection.currentPromptId;
}

function choicePayload(commandName: EveningServiceCommandName, choiceId: string, orderId: FirstServiceOrderId | null): JsonObject {
  switch (commandName) {
    case "service.prepare-rice": return { beat: choiceId };
    case "service.accept-order": return { orderId: choiceId };
    case "service.perform-step": return { orderId: orderId!, stepId: choiceId };
    case "service.choose-presentation": return { orderId: orderId!, choice: choiceId };
    case "service.plate-order":
    case "service.serve-order": return { orderId: choiceId };
    case "service.choose-restoration": return { choice: choiceId };
    default: return {};
  }
}

function choiceAsset(projection: EveningServiceProjection, choiceId: string, checkpoint: EveningServiceCheckpoint): BrowserServiceAsset | null {
  if (projection.primaryCommand === "service.prepare-rice") return resolveAsset(`rice-${choiceId === "steam" ? "cooked" : choiceId === "season" ? "seasoned" : "washed"}`);
  if (projection.primaryCommand === "service.choose-presentation") return presentationAsset(choiceId);
  if (projection.primaryCommand === "service.choose-restoration") return restorationAsset(choiceId);
  const definition = firstEveningServiceSource.serviceDefinition.orders[checkpoint.activeOrderIndex];
  if (projection.primaryCommand === "service.perform-step" && definition) {
    const step = definition.steps[checkpoint.orders[checkpoint.activeOrderIndex]?.stepIndex ?? 0];
    const keys: Record<string, string> = {
      "prepared-sushi-rice": "ingredient-sushi-rice", "nori-sheet": "ingredient-nori", "cucumber-strip": "ingredient-cucumber",
      "cooked-tamago": "ingredient-tamago", "prepared-salmon-topping": "ingredient-salmon",
    };
    return step?.componentRef ? resolveAsset(keys[step.componentRef]!) : resolveAsset(`station-${step?.station === "prep-sashimi-board" ? "prep-board" : step?.station}`);
  }
  return null;
}

function orderDishAsset(orderId: FirstServiceOrderId, state: EveningServiceCheckpoint["orders"][number]["state"]): BrowserServiceAsset {
  const dish = orderId === "ceramicist-kappa" ? "kappa-maki" : orderId === "fishmonger-tamago" ? "tamago-nigiri" : "salmon-nigiri";
  const suffix = state === "PLATED" || state === "SERVED" ? "-plated" : ["PREPARING", "ACCEPTED", "READY_TO_PLATE"].includes(state) ? "-build" : "";
  return resolveAsset(`dish-${dish}${suffix}`);
}

function portraitAsset(orderId: FirstServiceOrderId, state: EveningServiceCheckpoint["orders"][number]["state"]): BrowserServiceAsset {
  const role = orderId.split("-")[0]!;
  const mood = state === "SERVED" ? (role === "ceramicist" ? "delighted" : "content") : state === "DISCARDED" ? "recoverable" : "neutral";
  return resolveAsset(`guest-${role}-${mood}`);
}

function statusRef(state: EveningServiceCheckpoint["orders"][number]["state"]): string {
  const normalized = state.toLowerCase().replaceAll("_", "-");
  const supported = new Set(["accepted", "discarded", "offered", "plated", "preparing", "ready-to-plate", "served"]);
  if (!supported.has(normalized)) throw new Error(`Browser view rejects unsupported order state: ${state}`);
  return `order-state.${normalized}`;
}

export function buildBrowserEveningServiceView(
  checkpoint: EveningServiceCheckpoint,
  projection: EveningServiceProjection,
  identity: "guest" | "player",
): BrowserEveningServiceView {
  if (checkpoint.contentVersion !== FIRST_EVENING_CONTENT_VERSION) throw new Error("Browser view received an unsupported content version.");
  const activeOrder = checkpoint.orders[checkpoint.activeOrderIndex] ?? null;
  const automaticChoice = projection.primaryCommand && projection.allowedChoiceIds.length === 0
    ? [{ id: "primary", label: resolveCopy(projection.currentPromptId), actionLabel: resolveCopy(projection.currentPromptId), commandName: projection.primaryCommand, payload: {} as JsonObject, asset: null }]
    : [];
  const choices = projection.primaryCommand ? [
    ...projection.allowedChoiceIds.map((id) => ({
      id,
      label: resolveCopy(choiceLabelRef(projection, id)),
      actionLabel: resolveCopy(choiceActionRef(projection, id)),
      commandName: projection.primaryCommand!,
      payload: choicePayload(projection.primaryCommand!, id, activeOrder?.id ?? null),
      asset: choiceAsset(projection, id, checkpoint),
    })),
    ...automaticChoice,
  ] : [];
  const orders = checkpoint.orders.map((order, index) => {
    const definition = firstEveningServiceSource.serviceDefinition.orders[index]!;
    return {
      orderId: order.id,
      guest: resolveCopy(`guest.${definition.guestRole}`),
      dish: resolveCopy(`dish.${definition.dishId}`),
      status: resolveCopy(statusRef(order.state)),
      stepIndex: order.stepIndex,
      stepTotal: definition.steps.length,
      active: index === checkpoint.activeOrderIndex && checkpoint.phase === "OPEN" && checkpoint.riceBeatIndex === 3,
      portrait: portraitAsset(order.id, order.state),
      dishAsset: orderDishAsset(order.id, order.state),
    };
  });
  const ledgerRows = projection.ledgerRows.map((row) => ({
    orderId: row.orderId,
    guest: resolveCopy(row.guestRef),
    dish: resolveCopy(row.dishRef),
    outcome: resolveCopy(row.outcomeRef),
    plateFeedback: resolveCopy(row.plateFeedbackRef),
    serveFeedback: resolveCopy(row.serveFeedbackRef),
    storyFlag: resolveCopy(row.storyFlagRef),
    consequence: resolveCopy(row.persistentConsequenceRef),
  }));
  const restoration = checkpoint.restorationChoice ? restorationAsset(checkpoint.restorationChoice) : null;
  const restorationAnchors: Readonly<Record<string, readonly [number, number]>> = {
    "restoration-counter-stool": [24, 100], "restoration-display-shelf": [128, 76], "restoration-menu-board": [224, 72],
  };
  const sceneLayers: BrowserServiceSceneLayer[] = [{ asset: resolveAsset("counter-lamp-lit"), x: 232, y: 12 }];
  if (restoration) {
    const anchor = restorationAnchors[restoration.key];
    if (!anchor) throw new Error(`Browser view cannot anchor restoration: ${restoration.key}`);
    sceneLayers.push({ asset: restoration, x: anchor[0], y: anchor[1] });
  }
  return freeze({
    schemaVersion: 1,
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    revision: checkpoint.revision,
    identity,
    identityLabel: identity === "guest" ? "Guest play · no wallet" : "Saved play · no wallet",
    phase: checkpoint.phase,
    prompt: resolveCopy(projection.currentPromptId),
    correctiveCue: projection.correctiveCueId ? resolveCopy(projection.correctiveCueId) : null,
    facts: projection.displayRefs.map(resolveCopy),
    choices,
    abandonChoice: ["OPEN", "CLOSING"].includes(checkpoint.phase) ? {
      id: "abandon",
      label: resolveCopy("action.service.abandon"),
      actionLabel: resolveCopy("action.service.abandon"),
      commandName: "service.abandon",
      payload: {},
      asset: null,
    } : null,
    orders,
    ledgerRows,
    scene: resolveAsset(checkpoint.phase === "IDLE" || checkpoint.phase === "ABANDONED" || checkpoint.phase === "SETTLED" ? "counter-curtain-closed" : "counter-curtain-open"),
    sceneLayers,
    restoration,
    unlock: resolveAsset(checkpoint.unlocks.length > 0 ? "dish-salmon-sashimi" : "dish-salmon-sashimi-locked"),
    disposition: projection.disposition,
    announceCeremony: projection.announceCeremony,
  });
}
