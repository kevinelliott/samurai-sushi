import { createHash } from "node:crypto";
import { canonicalJson, portableSaveClaims } from "@samurai-sushi/domain";
import { describe, expect, it } from "vitest";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  hmacKeyIdentity,
  HmacKeyring,
  IntegrityKeyring,
  issueResumeSecret,
  TombstoneKeyring,
} from "./crypto";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const key = (purpose: "resume" | "tombstone" | "portable-integrity", version: number, marker: number, retired = false) => {
  const bytes = new Uint8Array(32).fill(marker);
  return {
    version,
    key: bytes,
    keyIdentity: hmacKeyIdentity(purpose, bytes),
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    retiredAt: retired ? new Date("2026-06-01T00:00:00.000Z") : null,
    verifyUntil: retired ? new Date("2027-01-01T00:00:00.000Z") : null,
    compromisedAt: null,
  } as const;
};

describe("resume-secret digests", () => {
  it("issues canonical 256-bit secrets and verifies current plus previous key versions", () => {
    const secret = issueResumeSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ring = new HmacKeyring(key("resume", 2, 2), key("resume", 1, 1, true));
    const candidates = ring.candidates(secret, NOW);
    expect(candidates.map((candidate) => candidate.keyVersion)).toEqual([2, 1]);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, NOW, 2).digest)).toBe(true);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, NOW, 1).digest)).toBe(false);
  });

  it("rejects non-canonical or short bearer values before hashing", () => {
    const ring = new HmacKeyring(key("resume", 1, 1));
    expect(() => ring.digest("not-a-secret", NOW)).toThrow(GuestSecretFormatError);
  });

  it("domain-separates irreversible deletion tombstones", () => {
    const ring = new TombstoneKeyring(key("tombstone", 4, 9));
    const replayKey = "018f47fe-347b-7dac-8f45-a6f3f43bd551";
    const guest = ring.digest("guest-session", replayKey, NOW);
    const command = ring.digest("command", replayKey, NOW);
    expect(guest.keyVersion).toBe(4);
    expect(constantTimeDigestEqual(guest.digest, command.digest)).toBe(false);
    expect(Buffer.from(guest.digest).toString("hex")).not.toBe(createHash("sha256").update(replayKey).digest("hex"));
  });

  it("defensively owns key bytes and exposes only immutable primitive lifecycle metadata", () => {
    const configured = key("resume", 7, 7);
    const ring = new HmacKeyring(configured);
    const secret = issueResumeSecret();
    const before = ring.digest(secret, NOW).digest;
    configured.key.fill(99);
    configured.activatedAt.setTime(0);
    expect(ring.active.activatedAtMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(constantTimeDigestEqual(before, ring.digest(secret, NOW).digest)).toBe(true);
    expect(Object.isFrozen(ring.active)).toBe(true);
  });

  it("rejects a same-version key whose bytes do not match its attested identity", () => {
    const configured = key("resume", 8, 8);
    configured.key.fill(9);
    expect(() => new HmacKeyring(configured)).toThrow(/attested key identity/);
  });
});

describe("portable-save integrity keys", () => {
  it("pins the portable-integrity identity and exact domain-separated MAC bytes", () => {
    const configured = key("portable-integrity", 5, 5);
    expect(configured.keyIdentity).toBe("sha256:b5e4c6ff17b13eab53b7382cab07a23310a6f921bda074efc1da12f83da91e43");
    const ring = new IntegrityKeyring(configured);
    const claims = new TextEncoder().encode('{"a":1}');
    const signed = ring.sign(claims, NOW);
    expect(Buffer.from(signed.digest).toString("base64url")).toBe("JKI7aVK87h82VdSblMfhaHqeoN91lIxT14ZhCw-9wIw");
    expect(ring.verify(claims, signed.digest, signed.keyVersion, signed.keyIdentity, NOW)).toBe(true);
    expect(ring.verify(new TextEncoder().encode('{"a":2}'), signed.digest, signed.keyVersion, signed.keyIdentity, NOW)).toBe(false);
  });

  it("pins the full canonical claims preimage and HMAC-SHA-256 interoperability vector", () => {
    const configured = key("portable-integrity", 5, 5);
    const claims = portableSaveClaims({
      domain: "samurai-sushi:portable-save:v1",
      schemaVersion: 1,
      exportId: "123e4567-e89b-42d3-a456-426614174000",
      subjectRevision: 7,
      unlinkableClaimCommitment: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      content: {
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        pack: {
          id: "samurai-core",
          version: 1,
          contentHash: `sha256:${"1".repeat(64)}`,
          contentManifestHash: `sha256:${"2".repeat(64)}`,
          artAssetMapHash: `sha256:${"3".repeat(64)}`,
        },
        refs: [{ kind: "ingredient", id: "rice", version: 1, contentHash: `sha256:${"4".repeat(64)}` }],
        savePayloadHash: `sha256:${"5".repeat(64)}`,
      },
      expiresAt: "2026-08-29T12:00:00.000Z",
      integrity: {
        keyVersion: 5,
        keyIdentity: configured.keyIdentity,
        tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const preimage = canonicalJson(claims);
    expect(preimage).toBe(
      '{"content":{"checkpointSchemaVersion":1,"contentVersion":"content-v1","pack":{"artAssetMapHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","contentHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","contentManifestHash":"sha256:2222222222222222222222222222222222222222222222222222222222222222","id":"samurai-core","version":1},"refs":[{"contentHash":"sha256:4444444444444444444444444444444444444444444444444444444444444444","id":"rice","kind":"ingredient","version":1}],"savePayloadHash":"sha256:5555555555555555555555555555555555555555555555555555555555555555"},"domain":"samurai-sushi:portable-save:v1","expiresAt":"2026-08-29T12:00:00.000Z","exportId":"123e4567-e89b-42d3-a456-426614174000","integrity":{"keyIdentity":"sha256:b5e4c6ff17b13eab53b7382cab07a23310a6f921bda074efc1da12f83da91e43","keyVersion":5},"schemaVersion":1,"subjectRevision":7,"unlinkableClaimCommitment":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    );
    const tag = new IntegrityKeyring(configured).sign(new TextEncoder().encode(preimage), NOW);
    expect(Buffer.from(tag.digest).toString("base64url")).toBe("iWuzlmYEX0XfrbvNyB3kGHvXZUqTXAk2UHh93SQUjKk");
  });

  it("uses exclusive compromise and verification horizons and never lets a retired key write", () => {
    const retired = key("portable-integrity", 4, 4, true);
    const active = key("portable-integrity", 5, 5);
    const ring = new IntegrityKeyring(active, [retired]);
    const claims = new TextEncoder().encode('{"a":1}');
    const beforeHorizon = new Date(retired.verifyUntil!.getTime() - 1);
    const priorTag = new IntegrityKeyring(key("portable-integrity", 4, 4)).sign(claims, NOW).digest;
    expect(ring.verify(claims, priorTag, 4, retired.keyIdentity, beforeHorizon)).toBe(true);
    expect(() => ring.verify(claims, priorTag, 4, retired.keyIdentity, retired.verifyUntil!)).toThrow(/unavailable/u);
    expect(ring.sign(claims, NOW).keyVersion).toBe(5);

    const compromised = { ...active, compromisedAt: new Date(NOW) };
    const compromisedRing = new IntegrityKeyring(compromised);
    expect(() => compromisedRing.sign(claims, NOW)).toThrow(/active use/u);
  });

  it("keeps integrity, resume, and every tombstone purpose distinct", () => {
    const replay = "123e4567-e89b-42d3-a456-426614174000";
    const tombstones = new TombstoneKeyring(key("tombstone", 9, 9));
    const values = ["guest-session", "command", "save-export", "save-import"].map((kind) => (
      Buffer.from(tombstones.digest(kind as "guest-session" | "command" | "save-export" | "save-import", replay, NOW).digest).toString("hex")
    ));
    expect(new Set(values).size).toBe(4);
    const integrity = new IntegrityKeyring(key("portable-integrity", 9, 9)).sign(new TextEncoder().encode(replay), NOW);
    expect(values).not.toContain(Buffer.from(integrity.digest).toString("hex"));
  });

  it("defensively owns portable-integrity key bytes", () => {
    const configured = key("portable-integrity", 6, 6);
    const ring = new IntegrityKeyring(configured);
    const claims = new TextEncoder().encode('{"stable":true}');
    const before = ring.sign(claims, NOW).digest;
    configured.key.fill(42);
    expect(constantTimeDigestEqual(before, ring.sign(claims, NOW).digest)).toBe(true);
  });
});
