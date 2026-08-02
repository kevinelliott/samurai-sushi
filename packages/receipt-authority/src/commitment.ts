import { blake2b } from "@noble/hashes/blake2b";
import {
  canonicalEveningServiceBytes,
  decodeEveningServiceCheckpoint,
  FIRST_EVENING_CONTENT_VERSION,
} from "@samurai-sushi/domain/evening-service";

const SERVICE_COMMITMENT_DOMAIN = new TextEncoder().encode("SAMURAI_SUSHI_SERVICE_COMMITMENT_V1\0");

function nonceBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Service commitment nonce must be 32 lowercase hexadecimal bytes.");
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/**
 * Server-only derivation. Only the 32-byte result may cross the public receipt boundary;
 * the settled checkpoint and server nonce remain private persistence material.
 */
export function deriveSettledServiceCommitment(checkpointInput: unknown, serverNonce: unknown): string {
  const checkpoint = decodeEveningServiceCheckpoint(checkpointInput);
  if (checkpoint.phase !== "SETTLED" || checkpoint.contentVersion !== FIRST_EVENING_CONTENT_VERSION) {
    throw new Error("A receipt commitment requires the exact settled first-service checkpoint.");
  }
  const digest = blake2b(
    concat(SERVICE_COMMITMENT_DOMAIN, nonceBytes(serverNonce), canonicalEveningServiceBytes(checkpoint)),
    { dkLen: 32 },
  );
  return Buffer.from(digest).toString("hex");
}
