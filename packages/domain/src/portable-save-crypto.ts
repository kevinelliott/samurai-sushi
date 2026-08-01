import { canonicalJson } from "./canonical-json";
import {
  canonicalPortableSaveEnvelopeBytes,
  parseCanonicalPortableSaveEnvelopeBytes,
  type PortableSaveEnvelopeV1,
} from "./portable-recovery";

const FORMAT = "samurai-sushi-portable-save";
const SUITE = "PBKDF2-SHA256-A256GCM-v1";
const AAD_DOMAIN = "samurai-sushi:portable-save-aad:v1\n";
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 360 * 1_024;
const MAX_CIPHERTEXT_BYTES = 256 * 1_024 + TAG_BYTES;
const MAX_PASSPHRASE_BYTES = 256;
const MIN_PASSPHRASE_SCALARS = 12;
const MIN_PASSPHRASE_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PortableRecoveryFileErrorCode =
  | "RECOVERY_FILE_TOO_LARGE"
  | "RECOVERY_FILE_INVALID"
  | "RECOVERY_SUITE_UNSUPPORTED"
  | "RECOVERY_PASSPHRASE_INVALID"
  | "RECOVERY_DECRYPT_FAILED";

export class PortableRecoveryFileError extends Error {
  constructor(readonly code: PortableRecoveryFileErrorCode, message: string) {
    super(message);
    this.name = "PortableRecoveryFileError";
  }
}

interface EncryptedPortableSaveV1 {
  readonly format: typeof FORMAT;
  readonly formatVersion: 1;
  readonly suite: typeof SUITE;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

interface EncryptionRandomness {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}

function fail(code: PortableRecoveryFileErrorCode, message: string): never {
  throw new PortableRecoveryFileError(code, message);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64url(
  value: unknown,
  expectedBytes: number | readonly [number, number],
  path: string,
  code: PortableRecoveryFileErrorCode = "RECOVERY_FILE_INVALID",
): Uint8Array {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.includes("=")) {
    fail(code, code === "RECOVERY_DECRYPT_FAILED" ? "Couldn’t unlock this save. The passphrase or file may be incorrect." : `${path} must be unpadded base64url.`);
  }
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4));
  } catch {
    fail(code, code === "RECOVERY_DECRYPT_FAILED" ? "Couldn’t unlock this save. The passphrase or file may be incorrect." : `${path} must be unpadded base64url.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) fail(code, code === "RECOVERY_DECRYPT_FAILED" ? "Couldn’t unlock this save. The passphrase or file may be incorrect." : `${path} is not canonical base64url.`);
  const validLength = typeof expectedBytes === "number"
    ? bytes.byteLength === expectedBytes
    : bytes.byteLength >= expectedBytes[0] && bytes.byteLength <= expectedBytes[1];
  if (!validLength) fail(code, code === "RECOVERY_DECRYPT_FAILED" ? "Couldn’t unlock this save. The passphrase or file may be incorrect." : `${path} has an invalid decoded length.`);
  return bytes;
}

function exactObject(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("RECOVERY_FILE_INVALID", "The recovery file must be an object.");
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("RECOVERY_FILE_INVALID", "The recovery file has unexpected or missing fields.");
  }
  return object;
}

function decodeCanonicalFile(fileBytes: Uint8Array): EncryptedPortableSaveV1 {
  if (fileBytes.byteLength > MAX_FILE_BYTES) fail("RECOVERY_FILE_TOO_LARGE", "The recovery file is too large.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
  } catch {
    fail("RECOVERY_FILE_INVALID", "The recovery file is not valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("RECOVERY_FILE_INVALID", "The recovery file is not valid JSON.");
  }
  const object = exactObject(parsed, ["ciphertext", "format", "formatVersion", "nonce", "salt", "suite"]);
  if (object.format !== FORMAT || object.formatVersion !== 1) fail("RECOVERY_FILE_INVALID", "The recovery file format is invalid.");
  if (object.suite !== SUITE) fail("RECOVERY_SUITE_UNSUPPORTED", "The recovery file uses an unsupported encryption suite.");
  if (canonicalJson(object) !== text) fail("RECOVERY_FILE_INVALID", "The recovery file must use canonical JSON bytes.");
  decodeBase64url(object.salt, SALT_BYTES, "$.salt");
  decodeBase64url(object.nonce, NONCE_BYTES, "$.nonce");
  decodeBase64url(object.ciphertext, [TAG_BYTES + 1, MAX_CIPHERTEXT_BYTES], "$.ciphertext", "RECOVERY_DECRYPT_FAILED");
  return object as unknown as EncryptedPortableSaveV1;
}

function normalizedPassphrase(passphrase: string, creation: boolean): Uint8Array {
  if (typeof passphrase !== "string") fail(creation ? "RECOVERY_PASSPHRASE_INVALID" : "RECOVERY_DECRYPT_FAILED", "The passphrase is invalid.");
  if (passphrase.length > MAX_PASSPHRASE_BYTES) {
    fail(creation ? "RECOVERY_PASSPHRASE_INVALID" : "RECOVERY_DECRYPT_FAILED", "The passphrase is invalid.");
  }
  for (let index = 0; index < passphrase.length; index += 1) {
    const code = passphrase.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = passphrase.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) fail(creation ? "RECOVERY_PASSPHRASE_INVALID" : "RECOVERY_DECRYPT_FAILED", "The passphrase is invalid.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(creation ? "RECOVERY_PASSPHRASE_INVALID" : "RECOVERY_DECRYPT_FAILED", "The passphrase is invalid.");
    }
  }
  const bytes = new TextEncoder().encode(passphrase);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASSPHRASE_BYTES) {
    fail(creation ? "RECOVERY_PASSPHRASE_INVALID" : "RECOVERY_DECRYPT_FAILED", "The passphrase is invalid.");
  }
  if (creation && ([...passphrase].length < MIN_PASSPHRASE_SCALARS || bytes.byteLength < MIN_PASSPHRASE_BYTES)) {
    fail("RECOVERY_PASSPHRASE_INVALID", "The passphrase must contain at least 12 characters and 16 UTF-8 bytes.");
  }
  return bytes;
}

function cryptoProvider(): Crypto {
  const selected = globalThis.crypto;
  if (!selected?.subtle) fail("RECOVERY_FILE_INVALID", "WebCrypto is unavailable.");
  return selected;
}

async function deriveKey(subtle: SubtleCrypto, passphrase: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", arrayBuffer(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function aad(file: Pick<EncryptedPortableSaveV1, "format" | "formatVersion" | "suite" | "salt" | "nonce">): Uint8Array {
  return new TextEncoder().encode(`${AAD_DOMAIN}${canonicalJson({
    format: file.format,
    formatVersion: file.formatVersion,
    suite: file.suite,
    salt: file.salt,
    nonce: file.nonce,
  })}`);
}

async function encryptWithRandomness(
  envelopeInput: unknown,
  passphrase: string,
  randomness: EncryptionRandomness,
): Promise<Uint8Array> {
  if (randomness.salt.byteLength !== SALT_BYTES || randomness.nonce.byteLength !== NONCE_BYTES) {
    fail("RECOVERY_FILE_INVALID", "Encryption randomness has an invalid length.");
  }
  const crypto = cryptoProvider();
  const plaintext = canonicalPortableSaveEnvelopeBytes(envelopeInput);
  const salt = new Uint8Array(randomness.salt);
  const nonce = new Uint8Array(randomness.nonce);
  const header: Omit<EncryptedPortableSaveV1, "ciphertext"> = {
    format: FORMAT,
    formatVersion: 1 as const,
    suite: SUITE,
    salt: base64url(salt),
    nonce: base64url(nonce),
  };
  const key = await deriveKey(crypto.subtle, normalizedPassphrase(passphrase, true), salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(aad(header)), tagLength: 128 },
    key,
    arrayBuffer(plaintext),
  ));
  const file: EncryptedPortableSaveV1 = { ...header, ciphertext: base64url(encrypted) };
  const bytes = new TextEncoder().encode(canonicalJson(file));
  if (bytes.byteLength > MAX_FILE_BYTES) fail("RECOVERY_FILE_TOO_LARGE", "The recovery file is too large.");
  return bytes;
}

export async function encryptPortableSave(
  envelopeInput: unknown,
  passphrase: string,
): Promise<Uint8Array> {
  const crypto = cryptoProvider();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return encryptWithRandomness(envelopeInput, passphrase, { salt, nonce });
}

export async function decryptPortableSave(
  fileBytes: Uint8Array,
  passphrase: string,
): Promise<PortableSaveEnvelopeV1> {
  const file = decodeCanonicalFile(fileBytes);
  const crypto = cryptoProvider();
  const salt = decodeBase64url(file.salt, SALT_BYTES, "$.salt");
  const nonce = decodeBase64url(file.nonce, NONCE_BYTES, "$.nonce");
  const ciphertext = decodeBase64url(
    file.ciphertext,
    [TAG_BYTES + 1, MAX_CIPHERTEXT_BYTES],
    "$.ciphertext",
    "RECOVERY_DECRYPT_FAILED",
  );
  let plaintext: Uint8Array;
  try {
    const key = await deriveKey(crypto.subtle, normalizedPassphrase(passphrase, false), salt);
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(aad(file)), tagLength: 128 },
      key,
      arrayBuffer(ciphertext),
    ));
  } catch (error) {
    if (error instanceof PortableRecoveryFileError) throw error;
    fail("RECOVERY_DECRYPT_FAILED", "Couldn’t unlock this save. The passphrase or file may be incorrect.");
  }
  try {
    return parseCanonicalPortableSaveEnvelopeBytes(plaintext);
  } catch {
    fail("RECOVERY_DECRYPT_FAILED", "Couldn’t unlock this save. The passphrase or file may be incorrect.");
  }
}

export const portableSaveCryptoProfile = Object.freeze({
  format: FORMAT,
  suite: SUITE,
  pbkdf2Iterations: PBKDF2_ITERATIONS,
  saltBytes: SALT_BYTES,
  nonceBytes: NONCE_BYTES,
  tagBytes: TAG_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  maxPassphraseBytes: MAX_PASSPHRASE_BYTES,
});
