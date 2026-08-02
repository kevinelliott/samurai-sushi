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
  readonly canonicalChainProof: readonly CanonicalChainProofBlock[] | null;
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

export interface CanonicalChainProofBlock {
  readonly level: number;
  readonly blockHash: string;
  readonly predecessorHash: string | null;
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
  evidence: { readonly includedLevel: number; readonly includedBlockHash: string; readonly headLevel: number; readonly headBlockHash: string; readonly canonicalChainProof: readonly CanonicalChainProofBlock[] },
): FinalityPolicyDecision {
  if (policyId !== RECEIPT_FINALITY_POLICY) throw new Error("Unsupported receipt finality policy.");
  if (!Number.isSafeInteger(evidence.includedLevel) || evidence.includedLevel < 0
    || !Number.isSafeInteger(evidence.headLevel) || evidence.headLevel < evidence.includedLevel
    || !/^[1-9A-HJ-NP-Za-km-z]{16,96}$/.test(evidence.includedBlockHash)
    || !/^[1-9A-HJ-NP-Za-km-z]{16,96}$/.test(evidence.headBlockHash)
    || evidence.canonicalChainProof.length < 1 || evidence.canonicalChainProof.length > 64) {
    throw new Error("Receipt finality evidence is invalid.");
  }
  const confirmations = evidence.headLevel - evidence.includedLevel + 1;
  if (confirmations !== evidence.canonicalChainProof.length) throw new Error("Receipt finality proof is not contiguous.");
  for (let index = 0; index < evidence.canonicalChainProof.length; index += 1) {
    const block = evidence.canonicalChainProof[index]!;
    if (block.level !== evidence.includedLevel + index
      || (index === 0 && (block.blockHash !== evidence.includedBlockHash || block.predecessorHash !== null))
      || (index > 0 && block.predecessorHash !== evidence.canonicalChainProof[index - 1]!.blockHash)) {
      throw new Error("Receipt finality proof does not establish canonical ancestry.");
    }
  }
  if (evidence.canonicalChainProof.at(-1)!.blockHash !== evidence.headBlockHash) throw new Error("Receipt finality proof does not end at the observed head.");
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
  readonly lastRpcSourceSequence: number | null;
  readonly lastIndexerSourceSequence: number | null;
  readonly lastHeadLevel: number | null;
  readonly lastHeadBlockHash: string | null;
  readonly canonicalBlockHash: string | null;
  readonly canonicalBlockLevel: number | null;
  readonly confirmations: number;
}

export type ObservationDecision =
  | { readonly disposition: "DUPLICATE" | "STALE"; readonly next: AttemptObservationState; readonly transitions: readonly OperationAttemptState[] }
  | { readonly disposition: "HINT"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[] }
  | { readonly disposition: "ATTEMPT_CONTRADICTION"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[] }
  | { readonly disposition: "APPLY"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[]; readonly policyEvidence: string | null }
  | { readonly disposition: "FINALIZED_CONTRADICTION"; readonly next: AttemptObservationState; readonly observation: NormalizedOperationObservation; readonly transitions: readonly OperationAttemptState[] };

const OBSERVATION_KEYS = Object.freeze([
  "canonicalChainProof", "chainId", "contractAddress", "deploymentManifestHash", "disposition", "failureCode",
  "headBlockHash", "headLevel", "includedBlockHash", "includedLevel", "observer",
  "operationHash", "operationIndex", "receiptEvent", "sourceAccount", "sourceObservationId", "sourceSequence",
] as const);
const RECEIPT_EVENT_KEYS = ["contentVersion", "contractAddress", "deploymentManifestHash", "nonce", "owner", "payloadHash", "serviceCommitment"] as const;
const PROOF_BLOCK_KEYS = ["blockHash", "level", "predecessorHash"] as const;

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
  const canonicalChainProof = row.canonicalChainProof === null ? null : (() => {
    if (!Array.isArray(row.canonicalChainProof) || row.canonicalChainProof.length < 1 || row.canonicalChainProof.length > 64) throw new TypeError("Operation observation canonical chain proof is invalid.");
    return Object.freeze(row.canonicalChainProof.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Operation observation canonical chain proof block is invalid.");
      const block = value as Record<string, unknown>;
      const keys = Object.keys(block).sort();
      if (keys.length !== PROOF_BLOCK_KEYS.length || keys.some((key, keyIndex) => key !== PROOF_BLOCK_KEYS[keyIndex])) throw new TypeError("Operation observation canonical chain proof block has an unexpected field set.");
      return Object.freeze({
        level: natural(block.level, `canonicalChainProof[${index}].level`)! ,
        blockHash: text(block.blockHash, `canonicalChainProof[${index}].blockHash`, /^[1-9A-HJ-NP-Za-km-z]{16,96}$/),
        predecessorHash: block.predecessorHash === null ? null : text(block.predecessorHash, `canonicalChainProof[${index}].predecessorHash`, /^[1-9A-HJ-NP-Za-km-z]{16,96}$/),
      });
    }));
  })();
  const authoritativeProofRequired = row.observer === "fake-rpc" && inclusionBearing;
  if (authoritativeProofRequired !== (canonicalChainProof !== null)) throw new TypeError("Operation observation canonical proof authority is inconsistent with its source and disposition.");
  if (canonicalChainProof !== null) {
    const expectedLength = headLevel - includedLevel! + 1;
    const first = canonicalChainProof[0]!;
    const last = canonicalChainProof.at(-1)!;
    const firstHashMatchesDisposition = disposition === "INCLUDED"
      ? first.blockHash === includedBlockHash : first.blockHash !== includedBlockHash;
    if (canonicalChainProof.length !== expectedLength || first.level !== includedLevel || first.predecessorHash !== null
      || !firstHashMatchesDisposition || last.level !== headLevel || last.blockHash !== row.headBlockHash
      || canonicalChainProof.some((block, index) => index > 0
        && (block.level !== canonicalChainProof[index - 1]!.level + 1 || block.predecessorHash !== canonicalChainProof[index - 1]!.blockHash))) {
      throw new TypeError("Operation observation canonical chain proof does not establish the claimed chain position.");
    }
  }
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
    canonicalChainProof,
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
  const lastSourceSequence = observation.observer === "fake-rpc" ? current.lastRpcSourceSequence : current.lastIndexerSourceSequence;
  if (lastSourceSequence !== null && observation.sourceSequence < lastSourceSequence) return Object.freeze({ disposition: "STALE", next: current, transitions: [] });
  if (lastSourceSequence === observation.sourceSequence) throw new Error("Operation observation source sequence contradicts durable history.");
  if (observation.observer === "fake-indexer") {
    return Object.freeze({ disposition: "HINT", observation, transitions: [], next: Object.freeze({ ...current, lastIndexerSourceSequence: observation.sourceSequence }) });
  }
  if (current.lastHeadLevel !== null && observation.headLevel < current.lastHeadLevel) return Object.freeze({ disposition: "STALE", next: current, transitions: [] });
  if (current.lastHeadLevel === observation.headLevel && current.lastHeadBlockHash !== null && current.lastHeadBlockHash !== observation.headBlockHash) throw new Error("Operation observation history contradicts the durable head.");
  if (current.state === "FINALIZED" && observation.disposition !== "INCLUDED") return Object.freeze({ disposition: "FINALIZED_CONTRADICTION", next: current, observation, transitions: [] });
  const base = { ...current, lastRpcSourceSequence: observation.sourceSequence, lastHeadLevel: observation.headLevel, lastHeadBlockHash: observation.headBlockHash };
  if (observation.disposition === "PENDING") {
    return Object.freeze({ disposition: "APPLY", observation, transitions: [], policyEvidence: null, next: Object.freeze(base) });
  }
  if (observation.disposition === "INCLUDED") {
    const policy = evaluateReceiptFinalityPolicy(policyId, {
      includedLevel: observation.includedLevel!, includedBlockHash: observation.includedBlockHash!,
      headLevel: observation.headLevel, headBlockHash: observation.headBlockHash, canonicalChainProof: observation.canonicalChainProof!,
    });
    const transitions: OperationAttemptState[] = [];
    let from = current.state;
    if (from === "SUBMITTED" || from === "REORGED") { assertAttemptTransition(from, "INCLUDED"); transitions.push("INCLUDED"); from = "INCLUDED"; }
    else if (from === "REPLACED" || from === "FAILED" || from === "DROPPED") return Object.freeze({ disposition: "ATTEMPT_CONTRADICTION", next: current, observation, transitions: [] });
    if (policy.confirmed && from === "INCLUDED") { assertAttemptTransition(from, "CONFIRMED"); transitions.push("CONFIRMED"); from = "CONFIRMED"; }
    if (policy.finalized && from === "CONFIRMED") { assertAttemptTransition(from, "FINALIZED"); transitions.push("FINALIZED"); from = "FINALIZED"; }
    return Object.freeze({ disposition: "APPLY", observation, transitions: Object.freeze(transitions), policyEvidence: policy.evidence, next: Object.freeze({
      ...base, state: from, canonicalBlockHash: observation.includedBlockHash, canonicalBlockLevel: observation.includedLevel, confirmations: policy.confirmations,
    }) });
  }
  const target = observation.disposition as "FAILED" | "DROPPED" | "REORGED";
  if (target === "REORGED") {
    if (current.canonicalBlockLevel === null || current.canonicalBlockHash === null
      || observation.includedLevel !== current.canonicalBlockLevel || observation.includedBlockHash !== current.canonicalBlockHash) {
      return Object.freeze({ disposition: "ATTEMPT_CONTRADICTION", next: current, observation, transitions: [] });
    }
    const proof = observation.canonicalChainProof!;
    const first = proof[0]!;
    if (first.level !== current.canonicalBlockLevel || first.blockHash === current.canonicalBlockHash || first.predecessorHash !== null
      || proof.at(-1)!.level !== observation.headLevel || proof.at(-1)!.blockHash !== observation.headBlockHash
      || proof.some((block, index) => index > 0 && (block.level !== proof[index - 1]!.level + 1 || block.predecessorHash !== proof[index - 1]!.blockHash))) {
      return Object.freeze({ disposition: "ATTEMPT_CONTRADICTION", next: current, observation, transitions: [] });
    }
  }
  assertAttemptTransition(current.state, target);
  return Object.freeze({ disposition: "APPLY", observation, transitions: Object.freeze([target]), policyEvidence: null, next: Object.freeze({
    ...base, state: target, canonicalBlockHash: null, canonicalBlockLevel: null, confirmations: 0,
  }) });
}
