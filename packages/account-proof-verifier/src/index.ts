import { bls12_381 } from "@noble/curves/bls12-381.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  b58DecodeAndCheckPrefix,
  b58Encode,
  getPkhfromPk,
  PrefixV2,
  verifySignature,
} from "@taquito/utils";
import {
  parseClaimChallenge,
  walletSigningBytes,
  type ClaimChallengeV1,
} from "@samurai-sushi/domain/claim-protocol";

const MAX_BASE58_TEXT = 192;
const ED25519_ORDER = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type TezosAccountScheme = "tz1" | "tz2" | "tz3" | "tz4";

export interface AccountProofInput {
  readonly challenge: unknown;
  readonly publicKey: unknown;
  readonly signature: unknown;
}

export interface VerifiedAccountProof {
  readonly account: string;
  readonly publicKey: string;
  readonly scheme: TezosAccountScheme;
}

export type AccountProofErrorCode = "INVALID_ACCOUNT_PROOF";

/** Public-safe: no account, key, signature, challenge, or parser detail is exposed. */
export class AccountProofError extends Error {
  readonly code: AccountProofErrorCode = "INVALID_ACCOUNT_PROOF";

  constructor() {
    super("The wallet proof is invalid.");
    this.name = "AccountProofError";
  }
}

interface Scheme {
  readonly name: TezosAccountScheme;
  readonly accountPrefix: PrefixV2;
  readonly publicKeyPrefix: PrefixV2;
  readonly signaturePrefix: PrefixV2;
  readonly publicKeyBytes: number;
  readonly signatureBytes: number;
}

const SCHEMES: Readonly<Record<TezosAccountScheme, Scheme>> = Object.freeze({
  tz1: Object.freeze({
    name: "tz1",
    accountPrefix: PrefixV2.Ed25519PublicKeyHash,
    publicKeyPrefix: PrefixV2.Ed25519PublicKey,
    signaturePrefix: PrefixV2.Ed25519Signature,
    publicKeyBytes: 32,
    signatureBytes: 64,
  }),
  tz2: Object.freeze({
    name: "tz2",
    accountPrefix: PrefixV2.Secp256k1PublicKeyHash,
    publicKeyPrefix: PrefixV2.Secp256k1PublicKey,
    signaturePrefix: PrefixV2.Secp256k1Signature,
    publicKeyBytes: 33,
    signatureBytes: 64,
  }),
  tz3: Object.freeze({
    name: "tz3",
    accountPrefix: PrefixV2.P256PublicKeyHash,
    publicKeyPrefix: PrefixV2.P256PublicKey,
    signaturePrefix: PrefixV2.P256Signature,
    publicKeyBytes: 33,
    signatureBytes: 64,
  }),
  tz4: Object.freeze({
    name: "tz4",
    accountPrefix: PrefixV2.BLS12_381PublicKeyHash,
    publicKeyPrefix: PrefixV2.BLS12_381PublicKey,
    signaturePrefix: PrefixV2.BLS12_381Signature,
    publicKeyBytes: 48,
    signatureBytes: 96,
  }),
});

function invalid(): never {
  throw new AccountProofError();
}

function proofInput(input: unknown): AccountProofInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(input).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Object.getOwnPropertyNames(input).sort();
  if (names.length !== 3 || names[0] !== "challenge" || names[1] !== "publicKey" || names[2] !== "signature") invalid();
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
  return {
    challenge: descriptors.challenge?.value,
    publicKey: descriptors.publicKey?.value,
    signature: descriptors.signature?.value,
  };
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE58_TEXT) invalid();
  return value;
}

function canonicalBase58(value: unknown, expectedPrefix: PrefixV2, expectedBytes: number): Uint8Array {
  const text = boundedText(value);
  const [bytes, actualPrefix] = b58DecodeAndCheckPrefix(text, [expectedPrefix] as const);
  if (actualPrefix !== expectedPrefix || bytes.byteLength !== expectedBytes) invalid();
  if (b58Encode(bytes, expectedPrefix) !== text) invalid();
  return Uint8Array.from(bytes);
}

/** Node-only startup gate shared by proof verification and server composition. */
export function assertCanonicalTezosChainId(value: unknown): string {
  const text = boundedText(value);
  canonicalBase58(text, PrefixV2.ChainID, 4);
  return text;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function littleEndianInteger(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) result = (result << 8n) | BigInt(bytes[index]!);
  return result;
}

function bigEndianInteger(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function validateEd25519(publicKey: Uint8Array, signature: Uint8Array): void {
  const keyPoint = ed25519.Point.fromBytes(publicKey, false);
  keyPoint.assertValidity();
  if (keyPoint.is0() || keyPoint.isSmallOrder() || !keyPoint.isTorsionFree() || !bytesEqual(keyPoint.toBytes(), publicKey)) invalid();

  const encodedR = signature.subarray(0, 32);
  const rPoint = ed25519.Point.fromBytes(encodedR, false);
  rPoint.assertValidity();
  if (rPoint.is0() || rPoint.isSmallOrder() || !rPoint.isTorsionFree() || !bytesEqual(rPoint.toBytes(), encodedR)) invalid();
  if (littleEndianInteger(signature.subarray(32)) >= ED25519_ORDER) invalid();
}

function validateEcdsaPointAndSignature(
  scheme: "tz2" | "tz3",
  publicKey: Uint8Array,
  signature: Uint8Array,
): void {
  const curve = scheme === "tz2" ? secp256k1 : p256;
  const order = scheme === "tz2" ? SECP256K1_ORDER : P256_ORDER;
  const point = curve.Point.fromBytes(publicKey);
  point.assertValidity();
  if (point.is0() || !point.isTorsionFree() || !bytesEqual(point.toBytes(true), publicKey)) invalid();
  const r = bigEndianInteger(signature.subarray(0, 32));
  const s = bigEndianInteger(signature.subarray(32));
  if (r < 1n || r >= order || s < 1n || s > order / 2n) invalid();
}

function validateBls(publicKey: Uint8Array, signature: Uint8Array): void {
  const keyPoint = bls12_381.G1.Point.fromBytes(publicKey);
  keyPoint.assertValidity();
  if (keyPoint.is0() || !keyPoint.isTorsionFree() || !bytesEqual(keyPoint.toBytes(), publicKey)) invalid();
  const signaturePoint = bls12_381.G2.Point.fromBytes(signature);
  signaturePoint.assertValidity();
  if (
    signaturePoint.is0()
    || !signaturePoint.isTorsionFree()
    || !bytesEqual(signaturePoint.toBytes(), signature)
  ) invalid();
}

function validatePoints(scheme: TezosAccountScheme, publicKey: Uint8Array, signature: Uint8Array): void {
  switch (scheme) {
    case "tz1":
      validateEd25519(publicKey, signature);
      return;
    case "tz2":
    case "tz3":
      validateEcdsaPointAndSignature(scheme, publicKey, signature);
      return;
    case "tz4":
      validateBls(publicKey, signature);
  }
}

function schemeFor(challenge: ClaimChallengeV1): Scheme {
  const name = challenge.account.slice(0, 3) as TezosAccountScheme;
  return SCHEMES[name] ?? invalid();
}

function verify(input: unknown): VerifiedAccountProof {
  const raw = proofInput(input);
  const challenge = parseClaimChallenge(raw.challenge);
  const scheme = schemeFor(challenge);

  canonicalBase58(challenge.chainId, PrefixV2.ChainID, 4);
  canonicalBase58(challenge.account, scheme.accountPrefix, 20);
  const publicKey = boundedText(raw.publicKey);
  const signature = boundedText(raw.signature);
  const publicKeyBytes = canonicalBase58(publicKey, scheme.publicKeyPrefix, scheme.publicKeyBytes);
  const signatureBytes = canonicalBase58(signature, scheme.signaturePrefix, scheme.signatureBytes);
  validatePoints(scheme.name, publicKeyBytes, signatureBytes);

  if (getPkhfromPk(publicKey) !== challenge.account) invalid();
  if (!verifySignature(walletSigningBytes(challenge), publicKey, signature, undefined, false)) invalid();

  return Object.freeze({ account: challenge.account, publicKey, scheme: scheme.name });
}

/**
 * Verifies a signature over the exact canonical Micheline wallet payload.
 * Challenge freshness, uniqueness, and consumption remain PostgreSQL authority.
 */
export function verifyAccountProof(input: unknown): VerifiedAccountProof {
  try {
    return verify(input);
  } catch {
    throw new AccountProofError();
  }
}

export const accountProofVerifierProfile = Object.freeze({
  taquitoUtilsVersion: "25.0.0",
  nobleCurvesVersion: "1.9.7",
  acceptedSchemes: Object.freeze(["tz1", "tz2", "tz3", "tz4"] as const),
  walletSigningType: "MICHELINE",
  blsProofOfPossession: false,
});
