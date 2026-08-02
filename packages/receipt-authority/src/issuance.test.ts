import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import { describe, expect, it } from "vitest";
import vector from "../fixtures/receipt-permit-v1.json";
import { admitSettledReceiptPermit, issueSettledReceiptPermit } from "./issuance";
import { hashReceiptPayload } from "./michelson-pack";
import { admitReceiptPermit, parseReceiptPayload, serviceReceiptEvent, type ReceiptAdmissionContext, type ReceiptPayloadV1 } from "./model";
import { FIXTURE_SETTLED_COMMITMENT_NONCE, deterministicSettledCheckpointFixture } from "./test-fixture";

const SECRET_KEY = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
const PUBLIC_KEY = "edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r";

function sign(payloadHash: string): string {
  return b58Encode(ed25519.sign(blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 }), SECRET_KEY), PrefixV2.Ed25519Signature);
}

function issuanceInput(): Record<string, unknown> {
  return {
    checkpoint: deterministicSettledCheckpointFixture(),
    commitmentNonce: FIXTURE_SETTLED_COMMITMENT_NONCE,
    chainId: vector.payload.chainId,
    owner: vector.payload.owner,
    destination: vector.payload.destination,
    nonce: vector.payload.nonce,
    issuedAt: vector.payload.issuedAt,
    expiry: vector.payload.expiry,
    deploymentManifestHash: vector.payload.deploymentManifestHash,
    issuerKeyId: vector.payload.issuerKeyId,
    issuerPolicyVersion: vector.payload.issuerPolicyVersion,
  };
}

function context(): ReceiptAdmissionContext {
  return {
    now: vector.payload.issuedAt,
    sender: vector.payload.owner,
    chainId: vector.payload.chainId,
    destination: vector.payload.destination,
    entrypoint: "submit_receipt",
    attachedMutez: "0",
    deploymentManifestHash: vector.payload.deploymentManifestHash,
    contentVersion: "phase-1-evening-service-v1",
    paused: false,
    issuerPolicies: new Map([[vector.payload.issuerKeyId, {
      keyId: vector.payload.issuerKeyId,
      policyVersion: vector.payload.issuerPolicyVersion,
      publicKey: PUBLIC_KEY,
      activatesAt: "1767225600",
      retiresAt: "2051222400",
      verifyUntil: "2051223300",
      revoked: false,
    }]]),
    usedNonces: new Set(),
    usedOwnerCommitments: new Set(),
  };
}

function freshlySigned(overrides: Partial<ReceiptPayloadV1>) {
  const payload = parseReceiptPayload({ ...vector.payload, ...overrides });
  const payloadHash = hashReceiptPayload(payload);
  return { payload, payloadHash, signature: sign(payloadHash) };
}

describe("settled receipt issuance boundary", () => {
  it("derives the golden public pair from one decoded checkpoint and private nonce", () => {
    const permit = issueSettledReceiptPermit(issuanceInput(), sign);
    expect(permit).toEqual({ payload: vector.payload, payloadHash: vector.payloadHash, signature: vector.signature });
    const receipt = admitSettledReceiptPermit(
      permit,
      context(),
      deterministicSettledCheckpointFixture(),
      FIXTURE_SETTLED_COMMITMENT_NONCE,
    );
    expect(serviceReceiptEvent(receipt).payloadHash).toBe(vector.payloadHash);
  });

  it("does not accept caller-supplied public settled facts or malformed private inputs", () => {
    expect(() => issueSettledReceiptPermit({ ...issuanceInput(), contentVersion: vector.payload.contentVersion }, sign)).toThrow(/field set/);
    expect(() => issueSettledReceiptPermit({ ...issuanceInput(), serviceCommitment: vector.payload.serviceCommitment }, sign)).toThrow(/field set/);
    expect(() => issueSettledReceiptPermit({ ...issuanceInput(), checkpoint: { ...deterministicSettledCheckpointFixture(), phase: "CLOSING" } }, sign)).toThrow();
    expect(() => issueSettledReceiptPermit({ ...issuanceInput(), commitmentNonce: "ab".repeat(31) }, sign)).toThrow(/32/);
  });

  it("returns no accepted record or event for freshly signed wrong, unrelated, or mismatched pairs", () => {
    const accepted: unknown[] = [];
    const emitted: unknown[] = [];
    const hostilePermits = [
      freshlySigned({ contentVersion: "phase-1-evening-service-v999" }),
      freshlySigned({ serviceCommitment: "55".repeat(32) }),
      freshlySigned({ contentVersion: "phase-1-evening-service-v999", serviceCommitment: "66".repeat(32) }),
    ];
    for (const permit of hostilePermits) {
      expect(() => {
        const receipt = admitSettledReceiptPermit(
          permit,
          context(),
          deterministicSettledCheckpointFixture(),
          FIXTURE_SETTLED_COMMITMENT_NONCE,
        );
        accepted.push(receipt);
        emitted.push(serviceReceiptEvent(receipt));
      }).toThrow();
    }
    expect(accepted).toEqual([]);
    expect(emitted).toEqual([]);
    expect(() => admitReceiptPermit(hostilePermits[0], context())).toThrow(/content version/);
  });
});
