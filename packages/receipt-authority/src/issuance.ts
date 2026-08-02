import { deriveSettledServiceReceiptFacts } from "./commitment";
import { hashReceiptPayload } from "./michelson-pack";
import {
  RECEIPT_DOMAIN,
  RECEIPT_ENTRYPOINT,
  RECEIPT_SCHEMA_VERSION,
  admitReceiptPermit,
  parseReceiptPayload,
  type PublicServiceReceiptV1,
  type ReceiptAdmissionContext,
  type ReceiptPermitV1,
} from "./model";

const ISSUANCE_KEYS = Object.freeze([
  "chainId",
  "checkpoint",
  "commitmentNonce",
  "deploymentManifestHash",
  "destination",
  "expiry",
  "issuedAt",
  "issuerKeyId",
  "issuerPolicyVersion",
  "nonce",
  "owner",
] as const);

export interface SettledReceiptIssuanceInput {
  readonly checkpoint: unknown;
  readonly commitmentNonce: string;
  readonly chainId: string;
  readonly owner: string;
  readonly destination: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiry: string;
  readonly deploymentManifestHash: string;
  readonly issuerKeyId: string;
  readonly issuerPolicyVersion: string;
}

export type ReceiptPermitSigner = (payloadHash: string) => string;

function exactIssuanceInput(input: unknown): Record<(typeof ISSUANCE_KEYS)[number], unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Settled receipt issuance input must be an object.");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Settled receipt issuance input must be a plain object.");
  }
  if (Object.getOwnPropertySymbols(input).length !== 0) {
    throw new TypeError("Settled receipt issuance input cannot contain symbol keys.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.getOwnPropertyNames(input).sort();
  if (keys.length !== ISSUANCE_KEYS.length || keys.some((key, index) => key !== ISSUANCE_KEYS[index])) {
    throw new TypeError("Settled receipt issuance input has an unexpected field set.");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Settled receipt issuance input ${key} must be a data field.`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])) as Record<
    (typeof ISSUANCE_KEYS)[number],
    unknown
  >;
}

/**
 * Sole server-only permit issuance boundary. Callers provide the private settled
 * checkpoint and commitment nonce, never the derived public content fields.
 */
export function issueSettledReceiptPermit(input: unknown, signer: ReceiptPermitSigner): ReceiptPermitV1 {
  if (typeof signer !== "function") throw new TypeError("Receipt permit signer is required.");
  const row = exactIssuanceInput(input);
  const facts = deriveSettledServiceReceiptFacts(row.checkpoint, row.commitmentNonce);
  const payload = parseReceiptPayload({
    domain: RECEIPT_DOMAIN,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    chainId: row.chainId,
    owner: row.owner,
    source: row.owner,
    destination: row.destination,
    entrypoint: RECEIPT_ENTRYPOINT,
    attachedMutez: "0",
    serviceCommitment: facts.serviceCommitment,
    contentVersion: facts.contentVersion,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiry: row.expiry,
    deploymentManifestHash: row.deploymentManifestHash,
    issuerKeyId: row.issuerKeyId,
    issuerPolicyVersion: row.issuerPolicyVersion,
  });
  const payloadHash = hashReceiptPayload(payload);
  const signature = signer(payloadHash);
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 192) {
    throw new TypeError("Receipt permit signer returned an invalid signature.");
  }
  return Object.freeze({ payload, payloadHash, signature });
}

/**
 * Server-side pre-submission check. It re-derives the settled pair so even a
 * freshly signed permit cannot cross this boundary with unrelated public facts.
 */
export function admitSettledReceiptPermit(
  permit: unknown,
  context: ReceiptAdmissionContext,
  checkpoint: unknown,
  commitmentNonce: unknown,
): PublicServiceReceiptV1 {
  const facts = deriveSettledServiceReceiptFacts(checkpoint, commitmentNonce);
  const receipt = admitReceiptPermit(permit, context);
  if (receipt.contentVersion !== facts.contentVersion || receipt.serviceCommitment !== facts.serviceCommitment) {
    throw new Error("Receipt permit does not match the exact settled-service issuance facts.");
  }
  return receipt;
}
