import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./canonical-json";
import {
  decryptPortableSave,
  encryptPortableSave,
  PortableRecoveryFileError,
} from "./portable-save-crypto";
import {
  canonicalPortableSaveEnvelopeBytes,
  parsePortableSaveEnvelope,
  portableSaveClaims,
  type PortableSaveEnvelopeV1,
} from "./portable-recovery";

const digest = (marker: string): `sha256:${string}` => `sha256:${marker.repeat(64)}`;

const fixture: PortableSaveEnvelopeV1 = {
  domain: "samurai-sushi:portable-save:v1",
  schemaVersion: 1,
  exportId: "123e4567-e89b-42d3-a456-426614174000",
  subjectRevision: 7,
  unlinkableClaimCommitment: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  content: {
    contentVersion: "salmon-sashimi-v1",
    checkpointSchemaVersion: 1,
    pack: {
      id: "phase0-salmon",
      version: 1,
      contentHash: digest("1"),
      contentManifestHash: digest("2"),
      artAssetMapHash: digest("3"),
    },
    refs: [
      { kind: "dish", id: "salmon-sashimi", version: 1, contentHash: digest("4") },
      { kind: "recipe", id: "salmon-sashimi", version: 1, contentHash: digest("5") },
    ],
    savePayloadHash: digest("6"),
  },
  expiresAt: "2026-08-30T09:00:00.000Z",
  integrity: {
    keyVersion: 3,
    keyIdentity: digest("7"),
    tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
};

function deterministicCrypto(salt: Uint8Array, nonce: Uint8Array): Crypto {
  let call = 0;
  return {
    subtle: webcrypto.subtle,
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint8Array)) throw new Error("Expected Uint8Array randomness target.");
      array.set(call === 0 ? salt : nonce);
      call += 1;
      return array as T;
    },
  } as unknown as Crypto;
}

const encodeBase64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

async function encryptedInvalidPlaintext(passphrase: string, salt: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const header = {
    format: "samurai-sushi-portable-save",
    formatVersion: 1,
    suite: "PBKDF2-SHA256-A256GCM-v1",
    salt: encodeBase64url(salt),
    nonce: encodeBase64url(nonce),
  };
  const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const additionalData = new TextEncoder().encode(`samurai-sushi:portable-save-aad:v1\n${canonicalJson(header)}`);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
    key,
    new TextEncoder().encode("{}"),
  ));
  return new TextEncoder().encode(canonicalJson({ ...header, ciphertext: encodeBase64url(ciphertext) }));
}

describe("portable recovery envelope", () => {
  it("strictly validates, detaches, sorts, and deeply freezes the envelope", () => {
    const mutable = JSON.parse(JSON.stringify(fixture)) as PortableSaveEnvelopeV1;
    const parsed = parsePortableSaveEnvelope(mutable);
    expect(parsed).toEqual(fixture);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.content.refs)).toBe(true);
    expect(canonicalPortableSaveEnvelopeBytes(parsed)).toEqual(new TextEncoder().encode(canonicalJson(fixture)));

    (mutable.content.refs as PortableSaveEnvelopeV1["content"]["refs"][number][])[0] = {
      kind: "tampered",
      id: "tampered",
      version: 1,
      contentHash: digest("8"),
    };
    expect(parsed.content.refs[0]?.kind).toBe("dish");
    expect(portableSaveClaims(parsed).integrity).toEqual({
      keyVersion: fixture.integrity.keyVersion,
      keyIdentity: fixture.integrity.keyIdentity,
    });
  });

  it("rejects unknown fields, noncanonical refs, and malformed capability fields", () => {
    expect(() => parsePortableSaveEnvelope({ ...fixture, extra: true })).toThrow(/must contain exactly/u);
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      content: { ...fixture.content, refs: [...fixture.content.refs].reverse() },
    })).toThrow(/strictly sorted/u);
    expect(() => parsePortableSaveEnvelope({ ...fixture, exportId: "not-an-id" })).toThrow(/UUIDv4/u);
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      integrity: { ...fixture.integrity, tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB" },
    })).toThrow(/canonical base64url/u);
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      content: {
        ...fixture.content,
        contentVersion: "mvp@1/review",
        refs: [
          { kind: "recipe", id: "salmon-sashimi", version: 2, contentHash: digest("4") },
          { kind: "recipe", id: "salmon-sashimi", version: 10, contentHash: digest("5") },
        ],
      },
    })).not.toThrow();
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      content: {
        ...fixture.content,
        refs: [
          { kind: "recipe", id: "A:one", version: 2, contentHash: digest("4") },
          { kind: "recipe", id: "A_one", version: 2, contentHash: digest("5") },
          { kind: "recipe", id: "a-one", version: 2, contentHash: digest("6") },
        ],
      },
    })).not.toThrow();
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      content: { ...fixture.content, refs: [{ kind: "attacker", id: "x", version: 1, contentHash: digest("4") }] },
    })).toThrow(/supported content kind/u);
    expect(() => parsePortableSaveEnvelope({
      ...fixture,
      content: { ...fixture.content, contentVersion: "x".repeat(256 * 1_024 + 1) },
    })).toThrow(/string data/u);
    expect(() => parsePortableSaveEnvelope(Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`field${index}`, index]),
    ))).toThrow(/too many properties/u);
  });
});

describe("portable recovery WebCrypto profile", () => {
  const crypto = webcrypto as unknown as Crypto;
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 16);
  const passphrase = "correct horse battery staple 🍣";

  afterEach(() => vi.unstubAllGlobals());

  it("pins deterministic canonical file bytes and decrypts to an immutable envelope", async () => {
    vi.stubGlobal("crypto", deterministicCrypto(salt, nonce));
    const file = await encryptPortableSave(fixture, passphrase);
    expect(createHash("sha256").update(file).digest("hex")).toBe("5ff37d6d7d2f5e6269d423344b367aaca5705e20c6254725393d5357c4580192");
    const recovered = await decryptPortableSave(file, passphrase);
    expect(recovered).toEqual(fixture);
    expect(Object.isFrozen(recovered.content.pack)).toBe(true);
  });

  it("collapses wrong-passphrase and ciphertext tamper failures", async () => {
    vi.stubGlobal("crypto", deterministicCrypto(salt, nonce));
    const file = await encryptPortableSave(fixture, passphrase);
    await expect(decryptPortableSave(file, "wrong but sufficiently long")).rejects.toMatchObject({
      code: "RECOVERY_DECRYPT_FAILED",
    });
    const parsed = JSON.parse(new TextDecoder().decode(file)) as Record<string, string | number>;
    const ciphertext = String(parsed.ciphertext);
    parsed.ciphertext = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    const tampered = new TextEncoder().encode(canonicalJson(parsed));
    await expect(decryptPortableSave(tampered, passphrase)).rejects.toMatchObject({
      code: "RECOVERY_DECRYPT_FAILED",
    });
    parsed.ciphertext = "AA";
    await expect(decryptPortableSave(new TextEncoder().encode(canonicalJson(parsed)), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_DECRYPT_FAILED",
    });
    try {
      await decryptPortableSave(tampered, passphrase);
      throw new Error("Expected tamper failure.");
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(passphrase);
      expect(serialized).not.toContain(fixture.exportId);
      expect(serialized).not.toContain(fixture.integrity.tag);
      expect(serialized).not.toContain(String(parsed.ciphertext));
    }
  });

  it("rejects weak creation passphrases and unsupported suites before decryption", async () => {
    vi.stubGlobal("crypto", deterministicCrypto(salt, nonce));
    await expect(encryptPortableSave(fixture, "too short")).rejects.toBeInstanceOf(
      PortableRecoveryFileError,
    );
    const file = await encryptPortableSave(fixture, passphrase);
    const parsed = JSON.parse(new TextDecoder().decode(file)) as Record<string, unknown>;
    parsed.suite = "attacker-controlled";
    await expect(decryptPortableSave(new TextEncoder().encode(canonicalJson(parsed)), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_SUITE_UNSUPPORTED",
    });
  });

  it("bounds files and passphrases before WebCrypto work and preserves exact Unicode", async () => {
    vi.stubGlobal("crypto", deterministicCrypto(salt, nonce));
    const importKey = vi.spyOn(webcrypto.subtle, "importKey");
    await expect(decryptPortableSave(new Uint8Array(360 * 1_024 + 1), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_FILE_TOO_LARGE",
    });
    await expect(encryptPortableSave(fixture, "x".repeat(257))).rejects.toMatchObject({
      code: "RECOVERY_PASSPHRASE_INVALID",
    });
    expect(importKey).not.toHaveBeenCalled();
    importKey.mockRestore();

    const composed = "correct horse café save";
    const decomposed = "correct horse cafe\u0301 save";
    const file = await encryptPortableSave(fixture, composed);
    await expect(decryptPortableSave(file, decomposed)).rejects.toMatchObject({ code: "RECOVERY_DECRYPT_FAILED" });
  });

  it("authenticates every outer header field and rejects noncanonical outer bytes", async () => {
    vi.stubGlobal("crypto", deterministicCrypto(salt, nonce));
    const file = await encryptPortableSave(fixture, passphrase);
    const parsed = JSON.parse(new TextDecoder().decode(file)) as Record<string, unknown>;
    parsed.nonce = "ERITFBUWFxgZGhsc";
    await expect(decryptPortableSave(new TextEncoder().encode(canonicalJson(parsed)), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_DECRYPT_FAILED",
    });
    await expect(decryptPortableSave(new TextEncoder().encode(` ${new TextDecoder().decode(file)}`), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_FILE_INVALID",
    });
    await expect(decryptPortableSave(await encryptedInvalidPlaintext(passphrase, salt, nonce), passphrase)).rejects.toMatchObject({
      code: "RECOVERY_DECRYPT_FAILED",
    });
  });

  it("uses fresh salt and nonce for every production encryption", async () => {
    vi.stubGlobal("crypto", crypto);
    const first = JSON.parse(new TextDecoder().decode(await encryptPortableSave(fixture, passphrase))) as Record<string, unknown>;
    const second = JSON.parse(new TextDecoder().decode(await encryptPortableSave(fixture, passphrase))) as Record<string, unknown>;
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
  });
});
