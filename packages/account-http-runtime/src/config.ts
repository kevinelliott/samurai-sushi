import { randomBytes } from "node:crypto";
import { assertCanonicalTezosChainId } from "@samurai-sushi/account-proof-verifier";
import { hmacKeyIdentity, type HmacKeyPurpose, type VersionedHmacKey } from "@samurai-sushi/persistence";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AccountRuntimeConfig {
  readonly canonicalOrigin: string;
  readonly chainId: string;
  readonly databaseUrl: string;
  readonly rawHeaderGuard: string;
  readonly keys: Readonly<Record<"resume" | "tombstone" | "guestClaim" | "playerSession", VersionedHmacKey>>;
  readonly resumeVerificationKeys: readonly VersionedHmacKey[];
}

export class RuntimeConfigurationError extends Error {
  constructor() {
    super("Account runtime configuration is unavailable.");
    this.name = "RuntimeConfigurationError";
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new RuntimeConfigurationError();
  return value;
}

function canonicalOrigin(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "SAMURAI_CANONICAL_ORIGIN");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RuntimeConfigurationError(); }
  const loopback = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && environment.SAMURAI_ALLOW_LOOPBACK_HTTP === "true";
  if ((parsed.protocol !== "https:" && !loopback) || parsed.origin !== value || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new RuntimeConfigurationError();
  return value;
}

function databaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "SAMURAI_DATABASE_URL");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RuntimeConfigurationError(); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new RuntimeConfigurationError();
  return value;
}

function key(
  environment: NodeJS.ProcessEnv,
  variable: string,
  purpose: HmacKeyPurpose,
  activatedAt: Date,
  version = 1,
): VersionedHmacKey {
  const encoded = required(environment, variable);
  if (!SECRET_PATTERN.test(encoded)) throw new RuntimeConfigurationError();
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== encoded) throw new RuntimeConfigurationError();
  return Object.freeze({
    version,
    key: bytes,
    keyIdentity: hmacKeyIdentity(purpose, bytes),
    activatedAt,
    retiredAt: null,
    verifyUntil: null,
    compromisedAt: null,
  });
}

function exactDate(value: string | undefined): Date {
  if (!value) throw new RuntimeConfigurationError();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new RuntimeConfigurationError();
  return parsed;
}

export function loadAccountRuntimeConfig(environment: NodeJS.ProcessEnv): AccountRuntimeConfig {
  const activatedAtText = required(environment, "SAMURAI_HMAC_ACTIVATED_AT");
  const activatedAt = new Date(activatedAtText);
  if (!Number.isFinite(activatedAt.getTime()) || activatedAt.toISOString() !== activatedAtText) {
    throw new RuntimeConfigurationError();
  }
  const chainId = required(environment, "TEZOS_CHAIN_ID");
  try { assertCanonicalTezosChainId(chainId); } catch { throw new RuntimeConfigurationError(); }
  const guard = environment.SAMURAI_INTERNAL_RAW_HEADER_GUARD ?? randomBytes(32).toString("base64url");
  if (!SECRET_PATTERN.test(guard)) throw new RuntimeConfigurationError();
  const previousResumeValues = [environment.SAMURAI_HMAC_RESUME_PREVIOUS_KEY,
    environment.SAMURAI_HMAC_RESUME_PREVIOUS_RETIRED_AT, environment.SAMURAI_HMAC_RESUME_PREVIOUS_VERIFY_UNTIL];
  if (previousResumeValues.some(Boolean) && !previousResumeValues.every(Boolean)) throw new RuntimeConfigurationError();
  const resumeVerificationKeys = previousResumeValues.every(Boolean) ? [Object.freeze({
    ...key(environment, "SAMURAI_HMAC_RESUME_PREVIOUS_KEY", "resume", activatedAt, 1),
    retiredAt: exactDate(environment.SAMURAI_HMAC_RESUME_PREVIOUS_RETIRED_AT),
    verifyUntil: exactDate(environment.SAMURAI_HMAC_RESUME_PREVIOUS_VERIFY_UNTIL),
  })] : [];
  return Object.freeze({
    canonicalOrigin: canonicalOrigin(environment),
    chainId,
    databaseUrl: databaseUrl(environment),
    rawHeaderGuard: guard,
    resumeVerificationKeys: Object.freeze(resumeVerificationKeys),
    keys: Object.freeze({
      resume: key(environment, "SAMURAI_HMAC_RESUME_KEY", "resume", activatedAt, resumeVerificationKeys.length ? 2 : 1),
      tombstone: key(environment, "SAMURAI_HMAC_TOMBSTONE_KEY", "tombstone", activatedAt),
      guestClaim: key(environment, "SAMURAI_HMAC_GUEST_CLAIM_KEY", "guest-claim", activatedAt),
      playerSession: key(environment, "SAMURAI_HMAC_PLAYER_SESSION_KEY", "player-session", activatedAt),
    }),
  });
}
