import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { PersistenceDomainError } from "./errors";
import type { CommandPayloadHash } from "./model";

const COMMAND_HASH_DOMAIN = "samurai-sushi:command:v1\n";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function canonicalCommandPayloadBytes(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${COMMAND_HASH_DOMAIN}${canonicalJson(payload)}`);
}

export function hashCommandPayload(payload: unknown): CommandPayloadHash {
  const digest = createHash("sha256").update(canonicalCommandPayloadBytes(payload)).digest("hex");
  return `sha256:${digest}` as CommandPayloadHash;
}

export function parseCommandPayloadHash(value: unknown, path = "$.payloadHash"): CommandPayloadHash {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new PersistenceDomainError("INVALID_COMMAND_SHAPE", `${path} must be a lowercase sha256 digest.`);
  }
  return value as CommandPayloadHash;
}

export const commandHashDomain = COMMAND_HASH_DOMAIN;

export { canonicalJson } from "./canonical-json";
