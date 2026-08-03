import { createHash, generateKeyPairSync, sign as signMessage } from "node:crypto";
import { readFileSync } from "node:fs";
import { b58DecodeAndCheckPrefix, b58Encode, PrefixV2, verifySignature } from "@taquito/utils";
import { walletSigningBytes } from "@samurai-sushi/domain/claim-protocol";
import { blake2b } from "@noble/hashes/blake2b";
import { getPkhfromPk } from "@taquito/utils";
import { walletLinkSigningBytes } from "@samurai-sushi/wallet-link";
import { describe, expect, it } from "vitest";
import {
  AccountProofError,
  accountProofVerifierProfile,
  verifyAccountProof,
  verifyWalletLinkProof,
  type TezosAccountScheme,
} from "./index";

interface AcceptedVector {
  readonly scheme: TezosAccountScheme;
  readonly account: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly walletSigningSha256: string;
}

interface ProofFixture {
  readonly schemaVersion: 1;
  readonly accepted: readonly AcceptedVector[];
  readonly rejected: {
    readonly genericSignatures: readonly string[];
    readonly wrongCurveSignatures: readonly string[];
    readonly highSSignatures: Readonly<Record<"tz2" | "tz3", string>>;
    readonly zip215: {
      readonly canonicalIdentityPublicKey: string;
      readonly canonicalIdentityAccount: string;
      readonly canonicalIdentitySignature: string;
      readonly noncanonicalIdentityPublicKey: string;
      readonly noncanonicalIdentityAccount: string;
      readonly noncanonicalIdentitySignature: string;
    };
    readonly invalidPointPublicKeys: Readonly<Record<"tz2" | "tz3" | "tz4", string>>;
    readonly invalidPointSignatures: Readonly<Record<"tz4", string>>;
  };
}

interface ClaimFixture {
  readonly challenge: Record<string, unknown>;
}

const proofFixture = JSON.parse(readFileSync(
  new URL("../fixtures/account-proof-v1.json", import.meta.url),
  "utf8",
)) as ProofFixture;
const claimFixture = JSON.parse(readFileSync(
  new URL("../../domain/fixtures/claim-protocol-v1.json", import.meta.url),
  "utf8",
)) as ClaimFixture;

function challenge(account: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...claimFixture.challenge, account, ...changes };
}

function proof(vector: AcceptedVector, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    challenge: challenge(vector.account),
    publicKey: vector.publicKey,
    signature: vector.signature,
    ...changes,
  };
}

function expectInvalid(input: unknown): void {
  try {
    verifyAccountProof(input);
    throw new Error("Expected proof verification to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountProofError);
    expect(error).toMatchObject({
      code: "INVALID_ACCOUNT_PROOF",
      message: "The wallet proof is invalid.",
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("tz1");
    expect(serialized).not.toContain("edpk");
    expect(serialized).not.toContain("signature");
  }
}

function corruptChecksum(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("1") ? "2" : "1"}`;
}

describe("server-side account proof verifier", () => {
  it("verifies the purpose-specific wallet review challenge without widening claim parsing", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const walletChallenge = { domain: "samurai-sushi:receipt-wallet-link:v1", schemaVersion: 1,
      purpose: "RECEIPT_WALLET_LINK", canonicalOrigin: "https://game.samurai-sushi.example",
      publicLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA", chainId: "NetXtJqPyJGB6Pc", account: getPkhfromPk(publicKeyText),
      providerId: "deterministic-wallet", permissionScopeDigest: "a".repeat(64), runtimeGeneration: 2,
      sessionRevision: 3, privacyPolicyVersion: "receipt-wallet-privacy-v1", nonce: "A".repeat(43),
      issuedAt: "2026-08-02T14:00:00.000Z", expiresAt: "2026-08-02T14:05:00.000Z" };
    const signature = b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(walletChallenge), { dkLen: 32 }), privateKey), PrefixV2.Ed25519Signature);
    expect(verifyWalletLinkProof({ challenge: walletChallenge, publicKey: publicKeyText, signature })).toMatchObject({ account: walletChallenge.account, publicKey: publicKeyText, scheme: "tz1" });
    expect(() => verifyAccountProof({ challenge: walletChallenge, publicKey: publicKeyText, signature })).toThrow(AccountProofError);
  });
  it("pins and accepts the four curve-specific proof tuples over exact Micheline bytes", () => {
    expect(accountProofVerifierProfile).toEqual({
      taquitoUtilsVersion: "25.0.0",
      nobleCurvesVersion: "1.9.7",
      acceptedSchemes: ["tz1", "tz2", "tz3", "tz4"],
      walletSigningType: "MICHELINE",
      blsProofOfPossession: false,
    });
    for (const vector of proofFixture.accepted) {
      const signingBytes = walletSigningBytes(challenge(vector.account));
      expect(createHash("sha256").update(signingBytes).digest("hex")).toBe(vector.walletSigningSha256);
      expect(verifyAccountProof(proof(vector))).toEqual({
        account: vector.account,
        publicKey: vector.publicKey,
        scheme: vector.scheme,
      });
      expect(Object.isFrozen(verifyAccountProof(proof(vector)))).toBe(true);
    }
  });

  it("binds every challenge context field and never accepts caller-supplied signing bytes", () => {
    const vector = proofFixture.accepted[0]!;
    const signingBytes = walletSigningBytes(challenge(vector.account));
    const oneByteMutation = Uint8Array.from(signingBytes);
    const finalIndex = oneByteMutation.byteLength - 1;
    oneByteMutation[finalIndex] = oneByteMutation[finalIndex]! ^ 1;
    expect(verifySignature(oneByteMutation, vector.publicKey, vector.signature)).toBe(false);
    const mutations: Record<string, unknown>[] = [
      { origin: "https://alternate.samurai-sushi.example" },
      { chainId: "NetXH12Aer3be93" },
      { account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb" },
      { claimIntentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { issuedAt: "2026-08-01T20:30:00.001Z", expiresAt: "2026-08-01T20:35:00.001Z" },
    ];
    for (const mutation of mutations) expectInvalid({ ...proof(vector), challenge: challenge(vector.account, mutation) });
    expectInvalid({ ...proof(vector), walletSigningBytes: oneByteMutation });
  });

  it("requires canonical one-prefix Base58Check encodings before Taquito verification", () => {
    for (const [index, vector] of proofFixture.accepted.entries()) {
      expectInvalid(proof(vector, { publicKey: corruptChecksum(vector.publicKey) }));
      expectInvalid(proof(vector, { signature: corruptChecksum(vector.signature) }));
      expectInvalid({ ...proof(vector), challenge: challenge(corruptChecksum(vector.account)) });
      expectInvalid(proof(vector, { signature: proofFixture.rejected.genericSignatures[Math.min(index, 2)] }));

      for (const other of proofFixture.accepted.filter((candidate) => candidate.scheme !== vector.scheme)) {
        expectInvalid(proof(vector, { publicKey: other.publicKey }));
        expectInvalid(proof(vector, { signature: other.signature }));
      }
    }
    const vector = proofFixture.accepted[0]!;
    for (const chainId of [
      corruptChecksum(claimFixture.challenge.chainId as string),
      b58Encode(new Uint8Array(5), PrefixV2.ChainID),
      b58Encode(new Uint8Array(4), PrefixV2.SlotHeader),
      `1${claimFixture.challenge.chainId as string}`,
    ]) expectInvalid({ ...proof(vector), challenge: challenge(vector.account, { chainId }) });
    for (const rejected of [
      "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
      "sr163Lv22CdE8QagCwf48PWDTquk6isQwv57",
      `tz5${"A".repeat(33)}`,
    ]) expectInvalid({ ...proof(vector), challenge: challenge(rejected) });
    expectInvalid(proof(vector, { signature: b58Encode(new Uint8Array(96), PrefixV2.GenericAggregateSignature) }));
  });

  it("rejects wrong payload lengths and noncanonical Base58 text before curve verification", () => {
    const shapes = [
      [proofFixture.accepted[0]!, PrefixV2.Ed25519PublicKey, 31, PrefixV2.Ed25519Signature, 63],
      [proofFixture.accepted[1]!, PrefixV2.Secp256k1PublicKey, 32, PrefixV2.Secp256k1Signature, 63],
      [proofFixture.accepted[2]!, PrefixV2.P256PublicKey, 32, PrefixV2.P256Signature, 63],
      [proofFixture.accepted[3]!, PrefixV2.BLS12_381PublicKey, 47, PrefixV2.BLS12_381Signature, 95],
    ] as const;
    for (const [vector, publicKeyPrefix, publicKeyBytes, signaturePrefix, signatureBytes] of shapes) {
      expectInvalid(proof(vector, { publicKey: b58Encode(new Uint8Array(publicKeyBytes), publicKeyPrefix) }));
      expectInvalid(proof(vector, { signature: b58Encode(new Uint8Array(signatureBytes), signaturePrefix) }));
      expectInvalid(proof(vector, { publicKey: `1${vector.publicKey}` }));
      expectInvalid(proof(vector, { signature: `1${vector.signature}` }));
    }
  });

  it("rejects an invalid-chain-checksum challenge even when Taquito accepts its ZIP-215 proof", () => {
    const attack = proofFixture.rejected.zip215;
    const invalidChain = corruptChecksum(claimFixture.challenge.chainId as string);
    const invalidChallenge = challenge(attack.canonicalIdentityAccount, { chainId: invalidChain });
    expect(verifySignature(
      walletSigningBytes(invalidChallenge),
      attack.canonicalIdentityPublicKey,
      attack.canonicalIdentitySignature,
    )).toBe(true);
    expectInvalid({
      challenge: invalidChallenge,
      publicKey: attack.canonicalIdentityPublicKey,
      signature: attack.canonicalIdentitySignature,
    });
  });

  it("rejects the same valid Ed25519 signature bytes under every wrong curve-specific prefix", () => {
    const vector = proofFixture.accepted[0]!;
    const signingBytes = walletSigningBytes(challenge(vector.account));
    for (const signature of proofFixture.rejected.wrongCurveSignatures) {
      expect(verifySignature(signingBytes, vector.publicKey, signature)).toBe(true);
      expectInvalid(proof(vector, { signature }));
    }
  });

  it("rejects a same-scheme account and public-key mismatch before signature admission", () => {
    const vector = proofFixture.accepted[0]!;
    expectInvalid({
      ...proof(vector),
      challenge: challenge("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"),
    });
  });

  it("rejects explicit high-S secp256k1 and P-256 twins", () => {
    for (const scheme of ["tz2", "tz3"] as const) {
      const vector = proofFixture.accepted.find((candidate) => candidate.scheme === scheme)!;
      const highS = proofFixture.rejected.highSSignatures[scheme];
      if (scheme === "tz3") {
        expect(verifySignature(walletSigningBytes(challenge(vector.account)), vector.publicKey, highS)).toBe(true);
      }
      expectInvalid(proof(vector, { signature: highS }));
    }
  });

  it("rejects canonical and noncanonical ZIP-215 identity A/R combinations before account derivation", () => {
    const attack = proofFixture.rejected.zip215;
    for (const [publicKey, account] of [
      [attack.canonicalIdentityPublicKey, attack.canonicalIdentityAccount],
      [attack.noncanonicalIdentityPublicKey, attack.noncanonicalIdentityAccount],
    ] as const) {
      for (const signature of [attack.canonicalIdentitySignature, attack.noncanonicalIdentitySignature]) {
        expect(verifySignature(walletSigningBytes(challenge(account)), publicKey, signature)).toBe(true);
        expectInvalid({ challenge: challenge(account), publicKey, signature });
      }
    }
  });

  it("rejects a noncanonical Ed25519 scalar at the exact subgroup order", () => {
    const vector = proofFixture.accepted[0]!;
    const [signatureBytes] = b58DecodeAndCheckPrefix(vector.signature, [PrefixV2.Ed25519Signature] as const);
    const invalidBytes = Uint8Array.from(signatureBytes);
    let order = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
    for (let index = 32; index < 64; index += 1) {
      invalidBytes[index] = Number(order & 0xffn);
      order >>= 8n;
    }
    expectInvalid(proof(vector, { signature: b58Encode(invalidBytes, PrefixV2.Ed25519Signature) }));
  });

  it("rejects malformed, identity, and non-curve points under valid checksums", () => {
    for (const scheme of ["tz2", "tz3", "tz4"] as const) {
      const vector = proofFixture.accepted.find((candidate) => candidate.scheme === scheme)!;
      expectInvalid(proof(vector, { publicKey: proofFixture.rejected.invalidPointPublicKeys[scheme] }));
    }
    const bls = proofFixture.accepted.find((candidate) => candidate.scheme === "tz4")!;
    expectInvalid(proof(bls, { signature: proofFixture.rejected.invalidPointSignatures.tz4 }));
  });

  it("fails every hostile proof-wrapper shape through the same public-safe error without invoking accessors", () => {
    const vector = proofFixture.accepted[0]!;
    for (const input of [null, true, [], "proof", { ...proof(vector), extra: true }, Object.create({ inherited: true })]) {
      expectInvalid(input);
    }
    let getterCalled = false;
    const accessor = proof(vector);
    Object.defineProperty(accessor, "signature", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return vector.signature;
      },
    });
    expectInvalid(accessor);
    expect(getterCalled).toBe(false);
    expectInvalid({ ...proof(vector), [Symbol("proof")]: true });
  });

  it("keeps Taquito and Noble out of the browser-safe domain subpath and client graph", () => {
    const domainPackage = readFileSync(new URL("../../domain/package.json", import.meta.url), "utf8");
    const claimProtocol = readFileSync(new URL("../../domain/src/claim-protocol.ts", import.meta.url), "utf8");
    const client = readFileSync(new URL("../../../apps/web/app/counter-shell.tsx", import.meta.url), "utf8");
    expect(domainPackage).not.toMatch(/taquito|noble/u);
    expect(claimProtocol).not.toMatch(/taquito|noble|node:/u);
    expect(client).not.toContain("claim-protocol");
    expect(client).not.toContain("account-proof-verifier");
  });
});
