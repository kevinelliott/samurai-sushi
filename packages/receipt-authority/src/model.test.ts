import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import { describe, expect, it } from "vitest";
import vector from "../fixtures/receipt-permit-v1.json";
import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_PERMIT_LIFETIME_SECONDS,
  PUBLIC_RECEIPT_RECORD_KEYS,
  RECEIPT_PAYLOAD_KEYS,
  SERVICE_RECEIPT_EVENT_KEYS,
  admitReceiptPermit,
  parseReceiptPayload,
  receiptOwnerCommitmentKey,
  serviceReceiptEvent,
  type IssuerKeyPolicyV1,
  type ReceiptAdmissionContext,
  type ReceiptPayloadV1,
  type ReceiptPermitV1,
} from "./model";
import { hashReceiptPayload, receiptPayloadPackedHex } from "./michelson-pack";

const SECRET_KEY = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
const PUBLIC_KEY = "edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r";
const OTHER_OWNER = "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6";
const OTHER_CONTRACT = "KT1AFA2mwNUMNd4SsujE1YYp29vd8BZejyKW";
const fixturePermit = {
  payload: vector.payload,
  payloadHash: vector.payloadHash,
  signature: vector.signature,
};

const policy: IssuerKeyPolicyV1 = {
  keyId: "localnet-issuer-2026-01",
  policyVersion: "1",
  publicKey: PUBLIC_KEY,
  activatesAt: "1767225600",
  retiresAt: "2051222400",
  verifyUntil: "2051223300",
  revoked: false,
};

function context(overrides: Partial<ReceiptAdmissionContext> = {}): ReceiptAdmissionContext {
  return {
    now: "1770000000",
    sender: vector.payload.owner,
    chainId: vector.payload.chainId,
    destination: vector.payload.destination,
    entrypoint: "submit_receipt",
    attachedMutez: "0",
    deploymentManifestHash: vector.payload.deploymentManifestHash,
    paused: false,
    issuerPolicies: new Map([[policy.keyId, policy]]),
    usedNonces: new Set(),
    usedOwnerCommitments: new Set(),
    ...overrides,
  };
}

function signHash(payloadHash: string): string {
  const tezosDigest = blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 });
  return b58Encode(ed25519.sign(tezosDigest, SECRET_KEY), PrefixV2.Ed25519Signature);
}

function signedPermit(overrides: Partial<ReceiptPayloadV1> = {}): ReceiptPermitV1 {
  const payload = parseReceiptPayload({ ...vector.payload, ...overrides });
  const payloadHash = hashReceiptPayload(payload);
  return { payload, payloadHash, signature: signHash(payloadHash) };
}

describe("SAMURAI_SUSHI_RECEIPT_V1 pure authority", () => {
  it("pins exact TypeScript PACK bytes, BLAKE2b hash, and fixture signature", () => {
    const payload = parseReceiptPayload(vector.payload);
    expect(receiptPayloadPackedHex(payload)).toBe(vector.packedHex);
    expect(hashReceiptPayload(payload)).toBe(vector.payloadHash);
    expect(signHash(vector.payloadHash)).toBe(vector.signature);
    expect(admitReceiptPermit(fixturePermit, context())).toEqual({
      owner: vector.payload.owner,
      serviceCommitment: vector.payload.serviceCommitment,
      contentVersion: vector.payload.contentVersion,
      nonce: vector.payload.nonce,
      payloadHash: vector.payloadHash,
      deploymentManifestHash: vector.payload.deploymentManifestHash,
      issuerKeyId: vector.payload.issuerKeyId,
      issuerPolicyVersion: vector.payload.issuerPolicyVersion,
      issuedAt: vector.payload.issuedAt,
      expiry: vector.payload.expiry,
    });
  });

  it("exposes only the exact minimal immutable record and event facts", () => {
    const receipt = admitReceiptPermit(fixturePermit, context());
    expect(Object.keys(receipt).sort()).toEqual(PUBLIC_RECEIPT_RECORD_KEYS);
    expect(Object.isFrozen(receipt)).toBe(true);
    const event = serviceReceiptEvent(receipt);
    expect(Object.keys(event).sort()).toEqual(SERVICE_RECEIPT_EVENT_KEYS);
    expect(Object.isFrozen(event)).toBe(true);
    expect(JSON.stringify({ receipt, event })).not.toMatch(
      /guest|player|order|choice|dialogue|score|walletProof|serverNonce|checkpoint|media|url|rarity|price|reward|der/i,
    );
  });

  it("rejects an independently mutated value for every signed payload field with zero accepted fact", () => {
    const mutations: Record<(typeof RECEIPT_PAYLOAD_KEYS)[number], unknown> = {
      attachedMutez: "1",
      chainId: "NetXdQprcVkpaWU",
      contentVersion: "phase-1-evening-service-v2",
      deploymentManifestHash: "33".repeat(32),
      destination: OTHER_CONTRACT,
      domain: "SAMURAI_SUSHI_RECEIPT_V2",
      entrypoint: "transfer",
      expiry: "1770000899",
      issuedAt: "1769999999",
      issuerKeyId: "localnet-issuer-2026-02",
      issuerPolicyVersion: "2",
      nonce: "44".repeat(32),
      owner: OTHER_OWNER,
      schemaVersion: 2,
      serviceCommitment: "55".repeat(32),
      source: OTHER_OWNER,
    };
    for (const key of RECEIPT_PAYLOAD_KEYS) {
      const accepted: unknown[] = [];
      const hostile = { ...fixturePermit, payload: { ...vector.payload, [key]: mutations[key] } };
      expect(() => accepted.push(admitReceiptPermit(hostile, context())), key).toThrow();
      expect(accepted, key).toEqual([]);
    }
  });

  it("rejects dispatch, hash, signature, policy, pause, and replay substitutions", () => {
    const cases: readonly [string, unknown, ReceiptAdmissionContext][] = [
      ["hash", { ...fixturePermit, payloadHash: "66".repeat(32) }, context()],
      ["signature", { ...fixturePermit, signature: vector.signature.slice(0, -1) + "x" }, context()],
      ["sender", fixturePermit, context({ sender: OTHER_OWNER })],
      ["chain", fixturePermit, context({ chainId: "NetXdQprcVkpaWU" })],
      ["destination", fixturePermit, context({ destination: OTHER_CONTRACT })],
      ["mutez", fixturePermit, context({ attachedMutez: "1" as "0" })],
      ["manifest", fixturePermit, context({ deploymentManifestHash: "77".repeat(32) })],
      ["pause", fixturePermit, context({ paused: true })],
      ["missing policy", fixturePermit, context({ issuerPolicies: new Map() })],
      ["wrong policy", fixturePermit, context({ issuerPolicies: new Map([[policy.keyId, { ...policy, policyVersion: "2" }]]) })],
      ["revoked policy", fixturePermit, context({ issuerPolicies: new Map([[policy.keyId, { ...policy, revoked: true }]]) })],
      ["nonce replay", fixturePermit, context({ usedNonces: new Set([vector.payload.nonce]) })],
      [
        "commitment replay",
        fixturePermit,
        context({ usedOwnerCommitments: new Set([receiptOwnerCommitmentKey(vector.payload.owner, vector.payload.serviceCommitment)]) }),
      ],
    ];
    for (const [label, permit, admission] of cases) expect(() => admitReceiptPermit(permit, admission), label).toThrow();
  });

  it("pins half-open activation, retirement, expiry, verify-until, lifetime, and skew boundaries", () => {
    const activation = 1_767_225_600n;
    const retirement = 2_051_222_400n;

    const atActivation = signedPermit({ issuedAt: activation.toString(), expiry: (activation + 1n).toString() });
    expect(admitReceiptPermit(atActivation, context({ now: activation.toString() }))).toBeDefined();
    const belowActivation = signedPermit({ issuedAt: (activation - 1n).toString(), expiry: activation.toString() });
    expect(() => admitReceiptPermit(belowActivation, context({ now: (activation - 1n).toString() }))).toThrow(/issuance/);

    const beforeRetirement = signedPermit({ issuedAt: (retirement - 1n).toString(), expiry: retirement.toString() });
    expect(admitReceiptPermit(beforeRetirement, context({ now: (retirement - 1n).toString() }))).toBeDefined();
    const atRetirement = signedPermit({ issuedAt: retirement.toString(), expiry: (retirement + 1n).toString() });
    expect(() => admitReceiptPermit(atRetirement, context({ now: retirement.toString() }))).toThrow(/issuance/);

    const lifetime = signedPermit({ issuedAt: "1770000000", expiry: (1_770_000_000n + MAX_PERMIT_LIFETIME_SECONDS).toString() });
    expect(admitReceiptPermit(lifetime, context())).toBeDefined();
    const tooLong = signedPermit({ issuedAt: "1770000000", expiry: (1_770_000_001n + MAX_PERMIT_LIFETIME_SECONDS).toString() });
    expect(() => admitReceiptPermit(tooLong, context())).toThrow(/lifetime/);

    const skew = signedPermit({ issuedAt: (1_770_000_000n + MAX_CLOCK_SKEW_SECONDS).toString(), expiry: "1770000900" });
    expect(admitReceiptPermit(skew, context())).toBeDefined();
    const beyondSkew = signedPermit({ issuedAt: (1_770_000_001n + MAX_CLOCK_SKEW_SECONDS).toString(), expiry: "1770000900" });
    expect(() => admitReceiptPermit(beyondSkew, context())).toThrow(/clock-skew/);

    expect(() => admitReceiptPermit(fixturePermit, context({ now: vector.payload.expiry }))).toThrow(/window/);
    expect(() => admitReceiptPermit(fixturePermit, context({ now: policy.verifyUntil }))).toThrow(/window/);
    expect(() => admitReceiptPermit(signedPermit({ expiry: vector.payload.issuedAt }), context())).toThrow(/lifetime/);
  });

  it("rejects extra, accessor, symbol, noncanonical, and economic/metadata fields", () => {
    expect(() => parseReceiptPayload({ ...vector.payload, transfer: [] })).toThrow(/field set/);
    expect(() => parseReceiptPayload({ ...vector.payload, metadata: {} })).toThrow(/field set/);
    expect(() => parseReceiptPayload({ ...vector.payload, attachedMutez: "00" })).toThrow(/canonical/);
    expect(() => parseReceiptPayload({ ...vector.payload, nonce: "AB".repeat(32) })).toThrow(/lowercase/);
    expect(() => parseReceiptPayload({ ...vector.payload, chainId: "not-base58" })).toThrow(/canonical Tezos chain/);
    expect(() => parseReceiptPayload({ ...vector.payload, destination: "KT1-invalid" })).toThrow(/canonical Tezos address/);
    const accessor = { ...vector.payload } as Record<string, unknown>;
    Object.defineProperty(accessor, "nonce", { enumerable: true, get: () => vector.payload.nonce });
    expect(() => parseReceiptPayload(accessor)).toThrow(/data field/);
    const symbol = Object.assign({ ...vector.payload }, { [Symbol("secret")]: "hidden" });
    expect(() => parseReceiptPayload(symbol)).toThrow(/symbol/);
  });
});
