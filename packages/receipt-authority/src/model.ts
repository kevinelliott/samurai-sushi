import {
  b58DecodeAddress,
  b58DecodeAndCheckPrefix,
  b58Encode,
  encodeAddress,
  PrefixV2,
  verifySignature,
} from "@taquito/utils";
import { FIRST_EVENING_CONTENT_VERSION } from "@samurai-sushi/domain/evening-service";
import { hashReceiptPayload } from "./michelson-pack";

export const RECEIPT_DOMAIN = "SAMURAI_SUSHI_RECEIPT_V1" as const;
export const RECEIPT_SCHEMA_VERSION = 1 as const;
export const RECEIPT_ENTRYPOINT = "submit_receipt" as const;
export const MAX_PERMIT_LIFETIME_SECONDS = 15n * 60n;
export const MAX_CLOCK_SKEW_SECONDS = 30n;

export const RECEIPT_PAYLOAD_KEYS = Object.freeze([
  "attachedMutez",
  "chainId",
  "contentVersion",
  "deploymentManifestHash",
  "destination",
  "domain",
  "entrypoint",
  "expiry",
  "issuedAt",
  "issuerKeyId",
  "issuerPolicyVersion",
  "nonce",
  "owner",
  "schemaVersion",
  "serviceCommitment",
  "source",
] as const);

export const PUBLIC_RECEIPT_RECORD_KEYS = Object.freeze([
  "contentVersion",
  "deploymentManifestHash",
  "expiry",
  "issuedAt",
  "issuerKeyId",
  "issuerPolicyVersion",
  "nonce",
  "owner",
  "payloadHash",
  "serviceCommitment",
] as const);

export const SERVICE_RECEIPT_EVENT_KEYS = Object.freeze([
  "contentVersion",
  "nonce",
  "owner",
  "payloadHash",
  "serviceCommitment",
] as const);

export interface ReceiptPayloadV1 {
  readonly domain: typeof RECEIPT_DOMAIN;
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly chainId: string;
  readonly owner: string;
  readonly source: string;
  readonly destination: string;
  readonly entrypoint: typeof RECEIPT_ENTRYPOINT;
  readonly attachedMutez: "0";
  readonly serviceCommitment: string;
  readonly contentVersion: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiry: string;
  readonly deploymentManifestHash: string;
  readonly issuerKeyId: string;
  readonly issuerPolicyVersion: string;
}

export interface ReceiptPermitV1 {
  readonly payload: ReceiptPayloadV1;
  readonly payloadHash: string;
  readonly signature: string;
}

export interface IssuerKeyPolicyV1 {
  readonly keyId: string;
  readonly policyVersion: string;
  readonly publicKey: string;
  readonly activatesAt: string;
  readonly retiresAt: string;
  readonly verifyUntil: string;
  readonly revoked: boolean;
}

export interface ReceiptAdmissionContext {
  readonly now: string;
  readonly sender: string;
  readonly chainId: string;
  readonly destination: string;
  readonly entrypoint: typeof RECEIPT_ENTRYPOINT;
  readonly attachedMutez: "0";
  readonly deploymentManifestHash: string;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly paused: boolean;
  readonly issuerPolicies: ReadonlyMap<string, IssuerKeyPolicyV1>;
  readonly usedNonces: ReadonlySet<string>;
  readonly usedOwnerCommitments: ReadonlySet<string>;
}

export interface PublicServiceReceiptV1 {
  readonly owner: string;
  readonly serviceCommitment: string;
  readonly contentVersion: string;
  readonly nonce: string;
  readonly payloadHash: string;
  readonly deploymentManifestHash: string;
  readonly issuerKeyId: string;
  readonly issuerPolicyVersion: string;
  readonly issuedAt: string;
  readonly expiry: string;
}

export interface ServiceReceiptEventV1 {
  readonly owner: string;
  readonly serviceCommitment: string;
  readonly contentVersion: string;
  readonly nonce: string;
  readonly payloadHash: string;
}

export type ReceiptAuthorityErrorCode =
  | "INVALID_RECEIPT_INPUT"
  | "RECEIPT_AUTHORITY_REJECTED";

export class ReceiptAuthorityError extends Error {
  constructor(
    readonly code: ReceiptAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReceiptAuthorityError";
  }
}

function invalid(message: string): never {
  throw new ReceiptAuthorityError("INVALID_RECEIPT_INPUT", message);
}

function reject(message: string): never {
  throw new ReceiptAuthorityError("RECEIPT_AUTHORITY_REJECTED", message);
}

function plainRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(`${label} cannot contain symbol keys.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    invalid(`${label} has an unexpected field set.`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${label}.${key} must be a data field.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function boundedString(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) invalid(`${label} is invalid.`);
  return value;
}

function canonicalNatural(value: unknown, label: string): string {
  const text = boundedString(value, label, 32);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) invalid(`${label} must be a canonical natural number.`);
  return text;
}

function canonicalHex32(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) invalid(`${label} must be 32 lowercase hexadecimal bytes.`);
  return text;
}

function canonicalChainId(value: unknown, label: string): string {
  const text = boundedString(value, label, 32);
  try {
    const [bytes, prefix] = b58DecodeAndCheckPrefix(text, [PrefixV2.ChainID] as const);
    if (prefix === PrefixV2.ChainID && bytes.byteLength === 4 && b58Encode(bytes, PrefixV2.ChainID) === text) return text;
  } catch {
    // Collapse decoder detail into the stable receipt input boundary below.
  }
  invalid(`${label} is not a canonical Tezos chain ID.`);
}

function canonicalAddress(value: unknown, label: string, contractOnly = false): string {
  const text = boundedString(value, label, 64);
  if (text.includes("%") || (contractOnly && !text.startsWith("KT1"))) invalid(`${label} is not an allowed address.`);
  try {
    const bytes = b58DecodeAddress(text, "array");
    if (bytes.byteLength !== 22 || encodeAddress(bytes) !== text) invalid(`${label} is not a canonical Tezos address.`);
  } catch (error) {
    if (error instanceof ReceiptAuthorityError) throw error;
    invalid(`${label} is not a canonical Tezos address.`);
  }
  if (!contractOnly && !/^tz[1-4]/.test(text)) invalid(`${label} must be an implicit account.`);
  return text;
}

function canonicalIdentifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(text)) invalid(`${label} is not a canonical identifier.`);
  return text;
}

function canonicalEd25519PublicKey(value: unknown): string {
  const text = boundedString(value, "issuer public key", 64);
  try {
    const [bytes, prefix] = b58DecodeAndCheckPrefix(text, [PrefixV2.Ed25519PublicKey] as const);
    if (prefix === PrefixV2.Ed25519PublicKey && bytes.byteLength === 32 && b58Encode(bytes, prefix) === text) return text;
  } catch {
    // Collapse decoder detail into the stable receipt input boundary below.
  }
  invalid("issuer public key must be canonical Ed25519.");
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function parseReceiptPayload(input: unknown): ReceiptPayloadV1 {
  const row = plainRecord(input, RECEIPT_PAYLOAD_KEYS, "receipt payload");
  const payload: ReceiptPayloadV1 = {
    domain: row.domain === RECEIPT_DOMAIN ? RECEIPT_DOMAIN : invalid("receipt payload domain is unsupported."),
    schemaVersion: row.schemaVersion === RECEIPT_SCHEMA_VERSION ? RECEIPT_SCHEMA_VERSION : invalid("receipt payload schema is unsupported."),
    chainId: canonicalChainId(row.chainId, "receipt payload chain ID"),
    owner: canonicalAddress(row.owner, "receipt payload owner"),
    source: canonicalAddress(row.source, "receipt payload source"),
    destination: canonicalAddress(row.destination, "receipt payload destination", true),
    entrypoint: row.entrypoint === RECEIPT_ENTRYPOINT ? RECEIPT_ENTRYPOINT : invalid("receipt payload entrypoint is unsupported."),
    attachedMutez: canonicalNatural(row.attachedMutez, "receipt payload attached mutez") === "0" ? "0" : invalid("receipt payload must attach zero mutez."),
    serviceCommitment: canonicalHex32(row.serviceCommitment, "receipt payload service commitment"),
    contentVersion: canonicalIdentifier(row.contentVersion, "receipt payload content version"),
    nonce: canonicalHex32(row.nonce, "receipt payload nonce"),
    issuedAt: canonicalNatural(row.issuedAt, "receipt payload issuedAt"),
    expiry: canonicalNatural(row.expiry, "receipt payload expiry"),
    deploymentManifestHash: canonicalHex32(row.deploymentManifestHash, "receipt payload deployment manifest hash"),
    issuerKeyId: canonicalIdentifier(row.issuerKeyId, "receipt payload issuer key ID"),
    issuerPolicyVersion: canonicalNatural(row.issuerPolicyVersion, "receipt payload issuer policy version"),
  };
  if (payload.owner !== payload.source) invalid("receipt payload owner and source must match.");
  return freeze(payload) as ReceiptPayloadV1;
}

export function parseIssuerKeyPolicy(input: unknown): IssuerKeyPolicyV1 {
  const row = plainRecord(
    input,
    ["activatesAt", "keyId", "policyVersion", "publicKey", "retiresAt", "revoked", "verifyUntil"],
    "issuer key policy",
  );
  if (typeof row.revoked !== "boolean") invalid("issuer key policy revoked must be boolean.");
  const policy: IssuerKeyPolicyV1 = {
    keyId: canonicalIdentifier(row.keyId, "issuer key policy ID"),
    policyVersion: canonicalNatural(row.policyVersion, "issuer key policy version"),
    publicKey: canonicalEd25519PublicKey(row.publicKey),
    activatesAt: canonicalNatural(row.activatesAt, "issuer key activation"),
    retiresAt: canonicalNatural(row.retiresAt, "issuer key retirement"),
    verifyUntil: canonicalNatural(row.verifyUntil, "issuer key verify-until"),
    revoked: row.revoked,
  };
  if (BigInt(policy.activatesAt) >= BigInt(policy.retiresAt)) invalid("issuer key policy activation must precede retirement.");
  if (BigInt(policy.retiresAt) > BigInt(policy.verifyUntil)) invalid("issuer key policy retirement cannot follow verify-until.");
  return freeze(policy) as IssuerKeyPolicyV1;
}

function parsePermit(input: unknown): ReceiptPermitV1 {
  const row = plainRecord(input, ["payload", "payloadHash", "signature"], "receipt permit");
  const signature = boundedString(row.signature, "receipt permit signature", 192);
  return freeze({
    payload: parseReceiptPayload(row.payload),
    payloadHash: canonicalHex32(row.payloadHash, "receipt permit payload hash"),
    signature,
  }) as ReceiptPermitV1;
}

function ownerCommitmentKey(owner: string, commitment: string): string {
  return `${owner}\u0000${commitment}`;
}

export function receiptOwnerCommitmentKey(owner: string, commitment: string): string {
  return ownerCommitmentKey(canonicalAddress(owner, "receipt owner"), canonicalHex32(commitment, "service commitment"));
}

export function serviceReceiptEvent(receipt: PublicServiceReceiptV1): ServiceReceiptEventV1 {
  return freeze({
    owner: receipt.owner,
    serviceCommitment: receipt.serviceCommitment,
    contentVersion: receipt.contentVersion,
    nonce: receipt.nonce,
    payloadHash: receipt.payloadHash,
  }) as ServiceReceiptEventV1;
}

export function admitReceiptPermit(input: unknown, context: ReceiptAdmissionContext): PublicServiceReceiptV1 {
  const permit = parsePermit(input);
  const payload = permit.payload;
  const now = BigInt(canonicalNatural(context.now, "receipt admission time"));
  const sender = canonicalAddress(context.sender, "receipt admission sender");
  const expectedChain = canonicalChainId(context.chainId, "receipt admission chain ID");
  const expectedDestination = canonicalAddress(context.destination, "receipt admission destination", true);
  const expectedManifest = canonicalHex32(context.deploymentManifestHash, "receipt admission deployment manifest hash");
  const expectedContentVersion = canonicalIdentifier(context.contentVersion, "receipt admission content version");
  if (context.entrypoint !== RECEIPT_ENTRYPOINT || context.attachedMutez !== "0") invalid("receipt admission dispatch is malformed.");
  if (context.paused) reject("receipt authority is paused.");
  if (payload.owner !== sender || payload.source !== sender) reject("receipt sender does not match owner/source.");
  if (payload.chainId !== expectedChain || payload.destination !== expectedDestination || payload.entrypoint !== context.entrypoint) {
    reject("receipt dispatch identity does not match authority.");
  }
  if (payload.attachedMutez !== context.attachedMutez || payload.deploymentManifestHash !== expectedManifest) {
    reject("receipt dispatch policy does not match authority.");
  }
  if (payload.contentVersion !== expectedContentVersion || expectedContentVersion !== FIRST_EVENING_CONTENT_VERSION) {
    reject("receipt content version does not match authority.");
  }
  const policy = context.issuerPolicies.get(payload.issuerKeyId);
  if (!policy) reject("receipt issuer policy is unavailable.");
  const validatedPolicy = parseIssuerKeyPolicy(policy);
  if (validatedPolicy.policyVersion !== payload.issuerPolicyVersion || validatedPolicy.revoked) {
    reject("receipt issuer policy is inactive.");
  }
  const issuedAt = BigInt(payload.issuedAt);
  const expiry = BigInt(payload.expiry);
  const activatesAt = BigInt(validatedPolicy.activatesAt);
  const retiresAt = BigInt(validatedPolicy.retiresAt);
  const verifyUntil = BigInt(validatedPolicy.verifyUntil);
  if (!(activatesAt <= issuedAt && issuedAt < retiresAt)) reject("receipt issuance is outside the issuer window.");
  if (issuedAt > now + MAX_CLOCK_SKEW_SECONDS) reject("receipt issuance exceeds the clock-skew boundary.");
  if (!(issuedAt < expiry) || expiry - issuedAt > MAX_PERMIT_LIFETIME_SECONDS) reject("receipt permit lifetime is invalid.");
  if (!(now < expiry) || !(now < verifyUntil)) reject("receipt permit verification window is closed.");
  const computedHash = hashReceiptPayload(payload);
  if (permit.payloadHash !== computedHash) reject("receipt payload hash does not match the packed payload.");
  try {
    if (!verifySignature(Uint8Array.from(Buffer.from(computedHash, "hex")), validatedPolicy.publicKey, permit.signature, undefined, false)) {
      reject("receipt issuer signature is invalid.");
    }
  } catch {
    reject("receipt issuer signature is invalid.");
  }
  if (context.usedNonces.has(payload.nonce)) reject("receipt nonce was already accepted.");
  if (context.usedOwnerCommitments.has(ownerCommitmentKey(payload.owner, payload.serviceCommitment))) {
    reject("receipt owner/service commitment was already accepted.");
  }
  return freeze({
    owner: payload.owner,
    serviceCommitment: payload.serviceCommitment,
    contentVersion: payload.contentVersion,
    nonce: payload.nonce,
    payloadHash: computedHash,
    deploymentManifestHash: payload.deploymentManifestHash,
    issuerKeyId: payload.issuerKeyId,
    issuerPolicyVersion: payload.issuerPolicyVersion,
    issuedAt: payload.issuedAt,
    expiry: payload.expiry,
  }) as PublicServiceReceiptV1;
}
