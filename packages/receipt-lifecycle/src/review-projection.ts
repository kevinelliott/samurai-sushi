import { OPERATION_ATTEMPT_STATES, RECEIPT_INTENT_STATES, type OperationAttemptState, type ReceiptIntentState } from "./state-machine";
import { GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY } from "./generated/registered-receipt-networks";

export type RegisteredNonProductionReceiptNetworkFact = (typeof GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY)[number];
export { GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY };

export type ReceiptDisplayState = ReceiptIntentState | OperationAttemptState | "FINALITY_INCIDENT";
export type ReceiptStatusTone = "neutral" | "progress" | "attention" | "success";
export type ReceiptStatusTitleRef = `receipt.status.${string}.title`;
export type ReceiptStatusMessageRef = `receipt.status.${string}.message`;
export type ReceiptNextActionRef = `receipt.action.${string}`;
export type ReceiptAttemptOutcomeRef = `receipt.outcome.${string}`;

export interface BrowserSafeReceiptReviewProjectionV1 {
  readonly schemaVersion: 1;
  readonly projectionRevision: string;
  readonly intent: {
    readonly intentRef: string;
    readonly state: ReceiptIntentState;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
  readonly status: {
    readonly displayState: ReceiptDisplayState;
    readonly titleRef: ReceiptStatusTitleRef;
    readonly messageRef: ReceiptStatusMessageRef;
    readonly nextActionRef: ReceiptNextActionRef | null;
    readonly tone: ReceiptStatusTone;
  };
  readonly reviewFacts: {
    readonly domain: "SAMURAI_SUSHI_RECEIPT_V1";
    readonly payloadSchemaVersion: 1;
    readonly network: RegisteredNonProductionReceiptNetworkFact;
    readonly owner: string;
    readonly source: string;
    readonly destination: string;
    readonly entrypoint: "submit_receipt";
    readonly attachedMutez: "0";
    readonly serviceCommitment: string;
    readonly contentVersion: string;
    readonly nonce: string;
    readonly issuedAt: string;
    readonly expiry: string;
    readonly issuerKeyId: string;
    readonly issuerPolicyVersion: string;
    readonly packedPayloadHex: string;
    readonly payloadHash: string;
  };
  readonly policy: {
    readonly confirmationThreshold: string;
    readonly finalityPolicyRef: string;
  };
  readonly activeAttempt: null | {
    readonly attemptRef: string;
    readonly state: OperationAttemptState;
    readonly operationHash: string;
    readonly replacesOperationHash: string | null;
    readonly replacedByOperationHash: string | null;
    readonly includedLevel: string | null;
    readonly includedBlockHash: string | null;
    readonly orphanedBlockHash: string | null;
    readonly confirmations: string;
    readonly submittedAt: string;
    readonly includedAt: string | null;
    readonly confirmedAt: string | null;
    readonly finalizedAt: string | null;
    readonly lastObservedAt: string;
    readonly outcomeRef: ReceiptAttemptOutcomeRef | null;
  };
  readonly canonicalReceipt: null | {
    readonly operationHash: string;
    readonly state: "CONFIRMED" | "FINALIZED";
    readonly recordedAt: string;
    readonly finalizedAt: string | null;
  };
  readonly incident: null | {
    readonly kind: "FINALITY_CONTRADICTION";
    readonly messageRef: "receipt.incident.finality-contradiction";
    readonly lastSafeState: "FINALIZED";
    readonly detectedAt: string;
  };
}

export const RECEIPT_REVIEW_STATE_MEANINGS: Readonly<Record<ReceiptDisplayState, string>> = Object.freeze({
  DRAFT: "Exact receipt details are being prepared. Nothing has been sent or recorded.",
  REVIEWED: "The permit and server review facts match. Nothing has been sent.",
  AWAITING_SIGNATURE: "A future wallet request may be open. Without an operation hash, nothing has been submitted or recorded.",
  CANCELLED: "Nothing was submitted or recorded. The saved service is unchanged.",
  REJECTED: "Nothing was submitted or recorded. The saved service is unchanged.",
  EXPIRED: "The permit expired before submission. Nothing was submitted or recorded.",
  SUBMITTED: "The wallet returned an operation hash. It is not yet included or recorded.",
  INCLUDED: "The operation is in a canonical block but remains provisional.",
  CONFIRMED: "The confirmation threshold was reached and one public receipt is projected. It is not final yet.",
  FINALIZED: "The configured finality policy was satisfied and this receipt is treated as finalized. New contradictory chain evidence opens incident review rather than silently downgrading it.",
  REORGED: "The saved service is safe. The provisional public receipt was removed and the same operation is being reconciled.",
  FAILED: "This attempt did not record a receipt. A network fee may still apply.",
  DROPPED: "This operation was not observed in a canonical block and no receipt was recorded by this attempt.",
  REPLACED: "The original hash remains in history. Its replacement is observed under the same intent.",
  FINALITY_INCIDENT: "New chain evidence conflicts with the finalized record. The saved service is safe and the public status is under incident review.",
});

export const RECEIPT_STATUS_PRESENTATION: Readonly<Record<ReceiptDisplayState, Readonly<{
  titleRef: ReceiptStatusTitleRef;
  messageRef: ReceiptStatusMessageRef;
  nextActionRef: ReceiptNextActionRef | null;
  tone: ReceiptStatusTone;
}>>> = Object.freeze(Object.fromEntries(([
  ["DRAFT", "check-again", "neutral"], ["REVIEWED", "review-details", "neutral"],
  ["AWAITING_SIGNATURE", "return-to-wallet", "attention"], ["CANCELLED", "review-again", "neutral"],
  ["REJECTED", "review-again", "neutral"], ["EXPIRED", "prepare-fresh-review", "attention"],
  ["SUBMITTED", "check-status", "progress"], ["INCLUDED", "keep-checking", "progress"],
  ["CONFIRMED", "view-receipt-details", "success"], ["FINALIZED", "view-final-receipt", "success"],
  ["REORGED", "keep-checking", "attention"], ["FAILED", null, "attention"],
  ["DROPPED", null, "attention"], ["REPLACED", null, "progress"],
  ["FINALITY_INCIDENT", null, "attention"],
] as const).map(([state, action, tone]) => [state, Object.freeze({
  titleRef: `receipt.status.${state.toLowerCase().replaceAll("_", "-")}.title`,
  messageRef: `receipt.status.${state.toLowerCase().replaceAll("_", "-")}.message`,
  nextActionRef: action === null ? null : `receipt.action.${action}`,
  tone,
})])) as Record<ReceiptDisplayState, Readonly<{ titleRef: ReceiptStatusTitleRef; messageRef: ReceiptStatusMessageRef; nextActionRef: ReceiptNextActionRef | null; tone: ReceiptStatusTone }>>);

const ROOT_KEYS = ["activeAttempt", "canonicalReceipt", "incident", "intent", "policy", "projectionRevision", "reviewFacts", "schemaVersion", "status"] as const;
const INTENT_KEYS = ["createdAt", "expiresAt", "intentRef", "state"] as const;
const STATUS_KEYS = ["displayState", "messageRef", "nextActionRef", "titleRef", "tone"] as const;
const FACT_KEYS = ["attachedMutez", "contentVersion", "destination", "domain", "entrypoint", "expiry", "issuedAt", "issuerKeyId", "issuerPolicyVersion", "network", "nonce", "owner", "packedPayloadHex", "payloadHash", "payloadSchemaVersion", "serviceCommitment", "source"] as const;
const NETWORK_KEYS = ["chainId", "deploymentManifestHash", "networkLabelRef", "profile"] as const;
const POLICY_KEYS = ["confirmationThreshold", "finalityPolicyRef"] as const;
const ATTEMPT_KEYS = ["attemptRef", "confirmations", "confirmedAt", "finalizedAt", "includedAt", "includedBlockHash", "includedLevel", "lastObservedAt", "operationHash", "orphanedBlockHash", "outcomeRef", "replacedByOperationHash", "replacesOperationHash", "state", "submittedAt"] as const;
const RECEIPT_KEYS = ["finalizedAt", "operationHash", "recordedAt", "state"] as const;
const INCIDENT_KEYS = ["detectedAt", "kind", "lastSafeState", "messageRef"] as const;

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${label} cannot contain symbol keys.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.getOwnPropertyNames(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new TypeError(`${label} has an unexpected field set.`);
  for (const key of actual) if (!descriptors[key]?.enumerable || !("value" in descriptors[key]!)) throw new TypeError(`${label}.${key} must be a data field.`);
  return Object.fromEntries(actual.map((key) => [key, descriptors[key]!.value]));
}

function string(value: unknown, label: string, pattern: RegExp, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function nullableString(value: unknown, label: string, pattern: RegExp, maximum = 256): string | null {
  return value === null ? null : string(value, label, pattern, maximum);
}

function decimal(value: unknown, label: string): string {
  return string(value, label, /^(?:0|[1-9][0-9]*)$/, 32);
}

function instant(value: unknown, label: string): string {
  const text = string(value, label, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 24);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} is invalid.`);
  return text;
}

function nullableInstant(value: unknown, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Strict browser-boundary parser. Callers must supply a committed server projection, never raw observer or database state. */
export function parseBrowserSafeReceiptReviewProjection(value: unknown): BrowserSafeReceiptReviewProjectionV1 {
  const root = exactRecord(value, ROOT_KEYS, "receipt projection");
  if (root.schemaVersion !== 1) throw new TypeError("receipt projection schemaVersion is invalid.");
  const intent = exactRecord(root.intent, INTENT_KEYS, "receipt projection intent");
  const status = exactRecord(root.status, STATUS_KEYS, "receipt projection status");
  const facts = exactRecord(root.reviewFacts, FACT_KEYS, "receipt projection reviewFacts");
  const policy = exactRecord(root.policy, POLICY_KEYS, "receipt projection policy");
  if (typeof intent.state !== "string" || !RECEIPT_INTENT_STATES.includes(intent.state as ReceiptIntentState)) throw new TypeError("receipt projection intent state is invalid.");
  const intentState = intent.state as ReceiptIntentState;
  if (typeof status.displayState !== "string" || ![...RECEIPT_INTENT_STATES, ...OPERATION_ATTEMPT_STATES, "FINALITY_INCIDENT"].includes(status.displayState as ReceiptDisplayState)) throw new TypeError("receipt projection display state is invalid.");
  if (typeof status.tone !== "string" || !["neutral", "progress", "attention", "success"].includes(status.tone)) throw new TypeError("receipt projection tone is invalid.");
  if (facts.domain !== "SAMURAI_SUSHI_RECEIPT_V1" || facts.payloadSchemaVersion !== 1 || facts.entrypoint !== "submit_receipt" || facts.attachedMutez !== "0") throw new TypeError("receipt projection receipt protocol is invalid.");
  if (facts.owner !== facts.source) throw new TypeError("receipt projection owner must equal source.");
  const network = exactRecord(facts.network, NETWORK_KEYS, "receipt projection network");
  const registeredNetwork = GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY.find((candidate) => candidate.profile === network.profile
    && candidate.chainId === network.chainId && candidate.networkLabelRef === network.networkLabelRef
    && candidate.deploymentManifestHash === network.deploymentManifestHash);
  if (!registeredNetwork) throw new TypeError("receipt projection network tuple is not registered.");
  const threshold = decimal(policy.confirmationThreshold, "receipt projection confirmationThreshold");
  const activeAttempt = root.activeAttempt === null ? null : exactRecord(root.activeAttempt, ATTEMPT_KEYS, "receipt projection activeAttempt");
  const canonicalReceipt = root.canonicalReceipt === null ? null : exactRecord(root.canonicalReceipt, RECEIPT_KEYS, "receipt projection canonicalReceipt");
  const incident = root.incident === null ? null : exactRecord(root.incident, INCIDENT_KEYS, "receipt projection incident");
  const preSubmission = ["DRAFT", "REVIEWED", "AWAITING_SIGNATURE", "CANCELLED", "REJECTED", "EXPIRED"].includes(intentState);
  if (preSubmission && (activeAttempt !== null || canonicalReceipt !== null)) throw new TypeError("pre-submission receipt projection cannot expose operation evidence.");
  if (!preSubmission && activeAttempt === null) throw new TypeError("submitted receipt projection requires an active attempt.");
  let attempt: BrowserSafeReceiptReviewProjectionV1["activeAttempt"] = null;
  if (activeAttempt) {
    if (typeof activeAttempt.state !== "string" || !OPERATION_ATTEMPT_STATES.includes(activeAttempt.state as OperationAttemptState)) throw new TypeError("receipt projection attempt state is invalid.");
    const attemptState = activeAttempt.state as OperationAttemptState;
    const confirmations = decimal(activeAttempt.confirmations, "receipt projection confirmations");
    const includedLevel = activeAttempt.includedLevel === null ? null : decimal(activeAttempt.includedLevel, "receipt projection includedLevel");
    const includedBlockHash = nullableString(activeAttempt.includedBlockHash, "receipt projection includedBlockHash", /^[1-9A-HJ-NP-Za-km-z]{16,96}$/);
    const orphanedBlockHash = nullableString(activeAttempt.orphanedBlockHash, "receipt projection orphanedBlockHash", /^[1-9A-HJ-NP-Za-km-z]{16,96}$/);
    if (attemptState === "SUBMITTED" && (includedLevel !== null || includedBlockHash !== null || canonicalReceipt !== null || confirmations !== "0")) throw new TypeError("submitted receipt projection cannot expose inclusion evidence.");
    if ((attemptState === "INCLUDED" || attemptState === "CONFIRMED" || attemptState === "FINALIZED") && (includedLevel === null || includedBlockHash === null)) throw new TypeError("included receipt projection requires canonical block evidence.");
    if (attemptState === "INCLUDED" && BigInt(confirmations) >= BigInt(threshold)) throw new TypeError("included receipt projection must be below the confirmation threshold.");
    if ((attemptState === "CONFIRMED" || attemptState === "FINALIZED") && BigInt(confirmations) < BigInt(threshold)) throw new TypeError("confirmed receipt projection must meet the confirmation threshold.");
    if (attemptState === "REORGED" && (orphanedBlockHash === null || canonicalReceipt !== null || includedBlockHash !== null)) throw new TypeError("reorged receipt projection evidence is invalid.");
    if ((attemptState === "FAILED" || attemptState === "DROPPED") && canonicalReceipt !== null) throw new TypeError("failed receipt attempt cannot expose a canonical receipt.");
    attempt = Object.freeze({
      attemptRef: string(activeAttempt.attemptRef, "receipt projection attemptRef", /^ra_[A-Za-z0-9_-]{22}$/, 25),
      state: attemptState,
      operationHash: string(activeAttempt.operationHash, "receipt projection operationHash", /^o[1-9A-HJ-NP-Za-km-z]{50}$/),
      replacesOperationHash: nullableString(activeAttempt.replacesOperationHash, "receipt projection replacesOperationHash", /^o[1-9A-HJ-NP-Za-km-z]{50}$/),
      replacedByOperationHash: nullableString(activeAttempt.replacedByOperationHash, "receipt projection replacedByOperationHash", /^o[1-9A-HJ-NP-Za-km-z]{50}$/),
      includedLevel,
      includedBlockHash,
      orphanedBlockHash,
      confirmations,
      submittedAt: instant(activeAttempt.submittedAt, "receipt projection submittedAt"),
      includedAt: nullableInstant(activeAttempt.includedAt, "receipt projection includedAt"),
      confirmedAt: nullableInstant(activeAttempt.confirmedAt, "receipt projection confirmedAt"),
      finalizedAt: nullableInstant(activeAttempt.finalizedAt, "receipt projection finalizedAt"),
      lastObservedAt: instant(activeAttempt.lastObservedAt, "receipt projection lastObservedAt"),
      outcomeRef: nullableString(activeAttempt.outcomeRef, "receipt projection outcomeRef", /^receipt\.outcome\.[a-z0-9-]+$/) as ReceiptAttemptOutcomeRef | null,
    });
  }
  let receipt: BrowserSafeReceiptReviewProjectionV1["canonicalReceipt"] = null;
  if (canonicalReceipt) {
    if (canonicalReceipt.state !== "CONFIRMED" && canonicalReceipt.state !== "FINALIZED") throw new TypeError("receipt projection canonical receipt state is invalid.");
    receipt = Object.freeze({
      operationHash: string(canonicalReceipt.operationHash, "receipt projection canonical operationHash", /^o[1-9A-HJ-NP-Za-km-z]{50}$/),
      state: canonicalReceipt.state,
      recordedAt: instant(canonicalReceipt.recordedAt, "receipt projection recordedAt"),
      finalizedAt: nullableInstant(canonicalReceipt.finalizedAt, "receipt projection canonical finalizedAt"),
    });
    if (!attempt || receipt.operationHash !== attempt.operationHash || receipt.state !== attempt.state) throw new TypeError("canonical receipt must match the active attempt.");
    if ((receipt.state === "FINALIZED") !== (receipt.finalizedAt !== null)) throw new TypeError("canonical receipt finality evidence is invalid.");
  }
  let finalityIncident: BrowserSafeReceiptReviewProjectionV1["incident"] = null;
  if (incident) {
    if (incident.kind !== "FINALITY_CONTRADICTION" || incident.messageRef !== "receipt.incident.finality-contradiction" || incident.lastSafeState !== "FINALIZED" || status.displayState !== "FINALITY_INCIDENT") throw new TypeError("receipt projection finality incident is invalid.");
    finalityIncident = Object.freeze({
      kind: incident.kind,
      messageRef: incident.messageRef,
      lastSafeState: incident.lastSafeState,
      detectedAt: instant(incident.detectedAt, "receipt projection incident detectedAt"),
    });
  } else if (status.displayState === "FINALITY_INCIDENT") throw new TypeError("receipt projection finality incident evidence is missing.");
  const expectedDisplayState: ReceiptDisplayState = finalityIncident ? "FINALITY_INCIDENT" : attempt?.state ?? intentState;
  if (status.displayState !== expectedDisplayState) throw new TypeError("receipt projection display state is not server-authoritative.");
  const expectedStatus = RECEIPT_STATUS_PRESENTATION[expectedDisplayState];
  if (status.titleRef !== expectedStatus.titleRef || status.messageRef !== expectedStatus.messageRef
    || status.nextActionRef !== expectedStatus.nextActionRef || status.tone !== expectedStatus.tone) {
    throw new TypeError("receipt projection status presentation is not server-authoritative.");
  }
  if ((attempt?.state === "CONFIRMED" || attempt?.state === "FINALIZED") && receipt === null) throw new TypeError("recorded receipt projection is missing.");
  if (attempt?.state === "REPLACED" && (attempt.replacedByOperationHash === null || receipt !== null)) throw new TypeError("replaced receipt projection lineage is invalid.");
  if (finalityIncident && (attempt?.state !== "FINALIZED" || receipt?.state !== "FINALIZED")) throw new TypeError("finality incident must preserve the last safe finalized view.");
  return deepFreeze({
    schemaVersion: 1,
    projectionRevision: decimal(root.projectionRevision, "receipt projection revision"),
    intent: {
      intentRef: string(intent.intentRef, "receipt projection intentRef", /^ri_[A-Za-z0-9_-]{22}$/, 25),
      state: intentState,
      createdAt: instant(intent.createdAt, "receipt projection createdAt"),
      expiresAt: instant(intent.expiresAt, "receipt projection expiresAt"),
    },
    status: {
      displayState: status.displayState as ReceiptDisplayState,
      titleRef: string(status.titleRef, "receipt projection titleRef", /^receipt\.status\.[a-z0-9-]+\.title$/) as ReceiptStatusTitleRef,
      messageRef: string(status.messageRef, "receipt projection messageRef", /^receipt\.status\.[a-z0-9-]+\.message$/) as ReceiptStatusMessageRef,
      nextActionRef: nullableString(status.nextActionRef, "receipt projection nextActionRef", /^receipt\.action\.[a-z0-9-]+$/) as ReceiptNextActionRef | null,
      tone: status.tone as ReceiptStatusTone,
    },
    reviewFacts: {
      domain: facts.domain,
      payloadSchemaVersion: facts.payloadSchemaVersion,
      network: registeredNetwork,
      owner: string(facts.owner, "receipt projection owner", /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/),
      source: string(facts.source, "receipt projection source", /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/),
      destination: string(facts.destination, "receipt projection destination", /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/),
      entrypoint: facts.entrypoint,
      attachedMutez: facts.attachedMutez,
      serviceCommitment: string(facts.serviceCommitment, "receipt projection serviceCommitment", /^[0-9a-f]{64}$/, 64),
      contentVersion: string(facts.contentVersion, "receipt projection contentVersion", /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 128),
      nonce: string(facts.nonce, "receipt projection nonce", /^[0-9a-f]{64}$/, 64),
      issuedAt: instant(facts.issuedAt, "receipt projection issuedAt"),
      expiry: instant(facts.expiry, "receipt projection expiry"),
      issuerKeyId: string(facts.issuerKeyId, "receipt projection issuerKeyId", /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 64),
      issuerPolicyVersion: string(facts.issuerPolicyVersion, "receipt projection issuerPolicyVersion", /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 64),
      packedPayloadHex: string(facts.packedPayloadHex, "receipt projection packedPayloadHex", /^(?:[0-9a-f]{2})+$/, 4096),
      payloadHash: string(facts.payloadHash, "receipt projection payloadHash", /^[0-9a-f]{64}$/, 64),
    },
    policy: {
      confirmationThreshold: threshold,
      finalityPolicyRef: string(policy.finalityPolicyRef, "receipt projection finalityPolicyRef", /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 128),
    },
    activeAttempt: attempt,
    canonicalReceipt: receipt,
    incident: finalityIncident,
  });
}
