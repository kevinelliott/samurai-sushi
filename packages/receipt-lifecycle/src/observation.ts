import { assertAttemptTransition, type OperationAttemptState } from "./state-machine";

export const RECEIPT_FINALITY_POLICY = "localnet-two-confirmation-rehearsal-v1" as const;
export type ReceiptFinalityPolicyId = typeof RECEIPT_FINALITY_POLICY;

export const OPERATION_OBSERVATION_DISPOSITIONS = Object.freeze([
  "PENDING",
  "INCLUDED",
  "FAILED",
  "DROPPED",
  "REORGED",
] as const);
export type OperationObservationDisposition = (typeof OPERATION_OBSERVATION_DISPOSITIONS)[number];

export interface OperationIdentity {
  readonly chainId: string;
  readonly operationHash: string;
  readonly sourceAccount: string;
  readonly contractAddress: string;
  readonly deploymentManifestHash: string;
}

export interface NormalizedOperationObservation extends OperationIdentity {
  readonly observer: "fake-rpc" | "fake-indexer";
  readonly sourceObservationId: string;
  readonly sourceSequence: number;
  readonly disposition: OperationObservationDisposition;
  readonly headLevel: number;
  readonly headBlockHash: string;
  readonly includedBlockHash: string | null;
  readonly includedLevel: number | null;
  readonly operationIndex: number | null;
  readonly failureCode: string | null;
  readonly receiptEvent: null | {
    readonly owner: string;
    readonly contractAddress: string;
    readonly serviceCommitment: string;
    readonly contentVersion: string;
    readonly nonce: string;
    readonly payloadHash: string;
    readonly deploymentManifestHash: string;
  };
}

export interface ChainObserver {
  observe(identity: OperationIdentity): Promise<unknown>;
}

export class DeterministicChainObserver implements ChainObserver {
  readonly #observations: ReadonlyMap<string, unknown>;

  constructor(observations: ReadonlyMap<string, unknown>) {
    this.#observations = new Map(observations);
  }

  async observe(identity: OperationIdentity): Promise<unknown> {
    return this.#observations.get(`${identity.chainId}\0${identity.operationHash}`) ?? null;
  }
}

export interface FinalityPolicyDecision {
  readonly confirmations: number;
  readonly confirmed: boolean;
  readonly finalized: boolean;
  readonly evidence: string;
}

export function evaluateReceiptFinalityPolicy(
  policyId: string,
  evidence: { readonly includedLevel: number; readonly includedBlockHash: string; readonly headLevel: number; readonly headBlockHash: string },
): FinalityPolicyDecision {
  if (policyId !== RECEIPT_FINALITY_POLICY) throw new Error("Unsupported receipt finality policy.");
  if (!Number.isSafeInteger(evidence.includedLevel) || evidence.includedLevel < 0
    || !Number.isSafeInteger(evidence.headLevel) || evidence.headLevel < evidence.includedLevel
    || !/^[1-9A-HJ-NP-Za-km-z]{16,96}$/.test(evidence.includedBlockHash)
    || !/^[1-9A-HJ-NP-Za-km-z]{16,96}$/.test(evidence.headBlockHash)) {
    throw new Error("Receipt finality evidence is invalid.");
  }
  const confirmations = evidence.headLevel - evidence.includedLevel + 1;
  const boundaryReached = confirmations >= 2;
  return Object.freeze({
    confirmations,
    confirmed: boundaryReached,
    finalized: boundaryReached,
    evidence: `${policyId}:${evidence.includedLevel}:${evidence.includedBlockHash}:${evidence.headLevel}:${evidence.headBlockHash}`,
  });
}

export interface AttemptObservationState extends OperationIdentity {
  readonly state: OperationAttemptState;
  readonly lastSourceSequence: number | null;
  readonly lastHeadLevel: number | null;
  readonly lastHeadBlockHash: string | null;
  readonly canonicalBlockHash: string | null;
  readonly canonicalBlockLevel: number | null;
  readonly confirmations: number;
}

export type ObservationDecision =
  | { readonly disposition: "DUPLICATE" | "STALE"; readonly next: AttemptObservationState; readonly transitions: readonly OperationAttemptState[] }
  | { readonly disposition: "APPLY"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[]; readonly policyEvidence: string | null }
  | { readonly disposition: "FINALIZED_CONTRADICTION"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[] };

const OBSERVATION_KEYS = Object.freeze([
  "chainId", "contractAddress", "deploymentManifestHash", "disposition", "failureCode",
  "headBlockHash", "headLevel", "includedBlockHash", "includedLevel", "observer",
  "operationHash", "operationIndex", "receiptEvent", "sourceAccount", "sourceObservationId", "sourceSequence",
] as const);
const RECEIPT_EVENT_KEYS = ["contentVersion", "contractAddress", "deploymentManifestHash", "nonce", "owner", "payloadHash", "serviceCommitment"] as const;

function exactRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Operation observation must be an object.");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Operation observation must be a plain object.");
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("Operation observation cannot contain symbol keys.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.length !== OBSERVATION_KEYS.length || keys.some((key, index) => key !== OBSERVATION_KEYS[index])) throw new TypeError("Operation observation has an unexpected field set.");
  for (const key of keys) if (!descriptors[key]?.enumerable || !("value" in descriptors[key]!)) throw new TypeError(`Operation observation ${key} must be a data field.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function text(value: unknown, label: string, pattern: RegExp, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) throw new TypeError(`Operation observation ${label} is invalid.`);
  return value;
}

function natural(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Operation observation ${label} is invalid.`);
  return value as number;
}

export function normalizeOperationObservation(value: unknown): NormalizedOperationObservation {
  const row = exactRecord(value);
  if (typeof row.observer !== "string" || !["fake-rpc", "fake-indexer"].includes(row.observer)) throw new TypeError("Operation observation source is invalid.");
  if (typeof row.disposition !== "string" || !OPERATION_OBSERVATION_DISPOSITIONS.includes(row.disposition as OperationObservationDisposition)) throw new TypeError("Operation observation disposition is invalid.");
  const disposition = row.disposition as OperationObservationDisposition;
  const inclusionBearing = disposition === "INCLUDED" || disposition === "REORGED";
  const includedBlockHash = row.includedBlockHash === null ? null : text(row.includedBlockHash, "includedBlockHash", /^[1-9A-HJ-NP-Za-km-z]{16,96}$/);
  const includedLevel = natural(row.includedLevel, "includedLevel", true);
  const operationIndex = natural(row.operationIndex, "operationIndex", true);
  if (inclusionBearing !== (includedBlockHash !== null && includedLevel !== null && operationIndex !== null)) throw new TypeError("Operation observation inclusion evidence is inconsistent with its disposition.");
  const failureBearing = disposition === "FAILED" || disposition === "DROPPED";
  const failureCode = row.failureCode === null ? null : text(row.failureCode, "failureCode", /^[A-Z][A-Z0-9_]{0,63}$/);
  if (failureBearing !== (failureCode !== null)) throw new TypeError("Operation observation failure evidence is inconsistent with its disposition.");
  const headLevel = natural(row.headLevel, "headLevel")!;
  if (includedLevel !== null && headLevel < includedLevel) throw new TypeError("Operation observation head precedes its inclusion.");
  const eventRow = row.receiptEvent === null ? null : (() => {
    if (!row.receiptEvent || typeof row.receiptEvent !== "object" || Array.isArray(row.receiptEvent)) throw new TypeError("Operation observation receipt event is invalid.");
    const event = row.receiptEvent as Record<string, unknown>;
    const keys = Object.keys(event).sort();
    if (keys.length !== RECEIPT_EVENT_KEYS.length || keys.some((key, index) => key !== RECEIPT_EVENT_KEYS[index])) throw new TypeError("Operation observation receipt event has an unexpected field set.");
    return Object.freeze({
      owner: text(event.owner, "receiptEvent.owner", /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/),
      contractAddress: text(event.contractAddress, "receiptEvent.contractAddress", /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/),
      serviceCommitment: text(event.serviceCommitment, "receiptEvent.serviceCommitment", /^[0-9a-f]{64}$/, 64),
      contentVersion: text(event.contentVersion, "receiptEvent.contentVersion", /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 128),
      nonce: text(event.nonce, "receiptEvent.nonce", /^[0-9a-f]{64}$/, 64),
      payloadHash: text(event.payloadHash, "receiptEvent.payloadHash", /^[0-9a-f]{64}$/, 64),
      deploymentManifestHash: text(event.deploymentManifestHash, "receiptEvent.deploymentManifestHash", /^[0-9a-f]{64}$/, 64),
    });
  })();
  if ((disposition === "INCLUDED") !== (eventRow !== null)) throw new TypeError("Operation observation receipt event is inconsistent with its disposition.");
  return Object.freeze({
    observer: row.observer as "fake-rpc" | "fake-indexer",
    sourceObservationId: text(row.sourceObservationId, "sourceObservationId", /^[A-Za-z0-9._:-]{1,128}$/),
    sourceSequence: natural(row.sourceSequence, "sourceSequence")!,
    disposition,
    chainId: text(row.chainId, "chainId", /^Net[1-9A-HJ-NP-Za-km-z]{12}$/),
    operationHash: text(row.operationHash, "operationHash", /^o[1-9A-HJ-NP-Za-km-z]{50}$/),
    sourceAccount: text(row.sourceAccount, "sourceAccount", /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/),
    contractAddress: text(row.contractAddress, "contractAddress", /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/),
    deploymentManifestHash: text(row.deploymentManifestHash, "deploymentManifestHash", /^[0-9a-f]{64}$/, 64),
    headLevel,
    headBlockHash: text(row.headBlockHash, "headBlockHash", /^[1-9A-HJ-NP-Za-km-z]{16,96}$/),
    includedBlockHash,
    includedLevel,
    operationIndex,
    failureCode,
    receiptEvent: eventRow,
  });
}

function sameIdentity(current: AttemptObservationState, observation: NormalizedOperationObservation): boolean {
  return current.chainId === observation.chainId && current.operationHash === observation.operationHash
    && current.sourceAccount === observation.sourceAccount && current.contractAddress === observation.contractAddress
    && current.deploymentManifestHash === observation.deploymentManifestHash;
}

export function reduceOperationObservation(current: AttemptObservationState, input: unknown, policyId: string): ObservationDecision {
  const observation = normalizeOperationObservation(input);
  if (!sameIdentity(current, observation)) throw new Error("Operation observation identity does not match the durable attempt.");
  if (current.lastHeadLevel !== null && observation.headLevel < current.lastHeadLevel) return Object.freeze({ disposition: "STALE", next: current, transitions: [] });
  if (current.lastSourceSequence !== null && observation.sourceSequence < current.lastSourceSequence) return Object.freeze({ disposition: "STALE", next: current, transitions: [] });
  if (current.lastSourceSequence === observation.sourceSequence && current.lastHeadLevel === observation.headLevel && current.lastHeadBlockHash === observation.headBlockHash) return Object.freeze({ disposition: "DUPLICATE", next: current, transitions: [] });
  if (current.lastHeadLevel === observation.headLevel && current.lastHeadBlockHash !== null && current.lastHeadBlockHash !== observation.headBlockHash) throw new Error("Operation observation history contradicts the durable head.");
  if (current.state === "FINALIZED" && observation.disposition !== "INCLUDED") return Object.freeze({ disposition: "FINALIZED_CONTRADICTION", next: current, observation, transitions: [] });
  const base = { ...current, lastSourceSequence: observation.sourceSequence, lastHeadLevel: observation.headLevel, lastHeadBlockHash: observation.headBlockHash };
  if (observation.disposition === "PENDING") {
    return Object.freeze({ disposition: "APPLY", observation, transitions: [], policyEvidence: null, next: Object.freeze(base) });
  }
  if (observation.disposition === "INCLUDED") {
    const policy = evaluateReceiptFinalityPolicy(policyId, {
      includedLevel: observation.includedLevel!, includedBlockHash: observation.includedBlockHash!,
      headLevel: observation.headLevel, headBlockHash: observation.headBlockHash,
    });
    const transitions: OperationAttemptState[] = [];
    let from = current.state;
    if (from === "SUBMITTED" || from === "REORGED") { assertAttemptTransition(from, "INCLUDED"); transitions.push("INCLUDED"); from = "INCLUDED"; }
    if (policy.confirmed && from === "INCLUDED") { assertAttemptTransition(from, "CONFIRMED"); transitions.push("CONFIRMED"); from = "CONFIRMED"; }
    if (policy.finalized && from === "CONFIRMED") { assertAttemptTransition(from, "FINALIZED"); transitions.push("FINALIZED"); from = "FINALIZED"; }
    return Object.freeze({ disposition: "APPLY", observation, transitions: Object.freeze(transitions), policyEvidence: policy.evidence, next: Object.freeze({
      ...base, state: from, canonicalBlockHash: observation.includedBlockHash, canonicalBlockLevel: observation.includedLevel, confirmations: policy.confirmations,
    }) });
  }
  const target = observation.disposition as "FAILED" | "DROPPED" | "REORGED";
  assertAttemptTransition(current.state, target);
  return Object.freeze({ disposition: "APPLY", observation, transitions: Object.freeze([target]), policyEvidence: null, next: Object.freeze({
    ...base, state: target, canonicalBlockHash: null, canonicalBlockLevel: null, confirmations: 0,
  }) });
}
