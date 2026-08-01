import type { NetworkEnvironment, NetworkName } from "./policy";

export class CredentialBoundaryError extends Error {
  readonly code = "CREDENTIAL_PROFILE_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "CredentialBoundaryError";
  }
}

const LOCAL_PREFIX = "SAMURAI_LOCALNET_SIGNER_";
const SHADOW_PREFIX = "SAMURAI_SHADOWNET_SIGNER_";
const ACTIVE_PREFIX = "SAMURAI_SIGNER_";
const PUBLIC_SECRET = /^NEXT_PUBLIC_.*(?:PRIVATE|SECRET|MNEMONIC|SIGNER|SEED|KEY)/i;
const SANDBOX_KEY_FRAGMENTS = ["edsk3QoqBuvdamxou", "edsk3RFfvaFaxbHx8"];

export function sanitizeSigningEnvironment(
  network: NetworkName,
  environment: NetworkEnvironment,
): NetworkEnvironment {
  const sanitized: NetworkEnvironment = { ...environment };
  const activePrefix = network === "localnet" ? LOCAL_PREFIX : SHADOW_PREFIX;
  const forbiddenPrefix = network === "localnet" ? SHADOW_PREFIX : LOCAL_PREFIX;

  for (const [key, rawValue] of Object.entries(environment)) {
    const value = rawValue?.trim() ?? "";
    if (!value) continue;
    if (PUBLIC_SECRET.test(key)) {
      throw new CredentialBoundaryError(`${key} must never expose signing material to the browser.`);
    }
    if (key.startsWith(ACTIVE_PREFIX)) {
      throw new CredentialBoundaryError(`${key} is child-only and cannot enter a public project command.`);
    }
    if (key.startsWith(forbiddenPrefix)) {
      throw new CredentialBoundaryError(`${key} is forbidden while running the ${network} profile.`);
    }
    if (
      network === "shadownet" &&
      (key.startsWith(activePrefix) || key.startsWith(ACTIVE_PREFIX)) &&
      SANDBOX_KEY_FRAGMENTS.some((fragment) => value.includes(fragment))
    ) {
      throw new CredentialBoundaryError("Known Localnet fixture key material is forbidden on Shadownet.");
    }
  }

  for (const key of Object.keys(sanitized)) {
    if (key.startsWith(LOCAL_PREFIX) || key.startsWith(SHADOW_PREFIX) || key.startsWith(ACTIVE_PREFIX)) {
      delete sanitized[key];
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith(activePrefix) && value?.trim()) {
      sanitized[`${ACTIVE_PREFIX}${key.slice(activePrefix.length)}`] = value;
    }
  }
  return sanitized;
}

export function validateSigningEnvironment(
  network: NetworkName,
  environment: NetworkEnvironment,
): void {
  sanitizeSigningEnvironment(network, environment);
}

export function runtimeRevisionFromEnvironment(environment: NetworkEnvironment): string {
  const revision = environment.SAMURAI_TEZOS_RUNTIME_REVISION?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new CredentialBoundaryError("SAMURAI_TEZOS_RUNTIME_REVISION must pin one exact runtime commit.");
  }
  return revision;
}
