import { describe, expect, it } from "vitest";
import {
  CredentialBoundaryError,
  runtimeRevisionFromEnvironment,
  sanitizeSigningEnvironment,
} from "./signing-policy";

describe("profile-scoped signing environment", () => {
  it("maps only the active Shadownet signer namespace", () => {
    expect(
      sanitizeSigningEnvironment("shadownet", {
        PATH: "/bin",
        SAMURAI_SHADOWNET_SIGNER_PRIVATE_KEY: "test-only-secret",
      }),
    ).toMatchObject({ PATH: "/bin", SAMURAI_SIGNER_PRIVATE_KEY: "test-only-secret" });
  });

  it("rejects Shadownet signer material in Localnet", () => {
    expect(() =>
      sanitizeSigningEnvironment("localnet", {
        SAMURAI_SHADOWNET_SIGNER_PRIVATE_KEY: "test-only-secret",
      }),
    ).toThrowError(CredentialBoundaryError);
  });

  it("rejects Localnet signer material in Shadownet", () => {
    expect(() =>
      sanitizeSigningEnvironment("shadownet", {
        SAMURAI_LOCALNET_SIGNER_PRIVATE_KEY: "sandbox-secret",
      }),
    ).toThrowError(CredentialBoundaryError);
  });

  it("rejects known sandbox fixture material in the Shadownet namespace", () => {
    expect(() =>
      sanitizeSigningEnvironment("shadownet", {
        SAMURAI_SHADOWNET_SIGNER_PRIVATE_KEY: "unencrypted:edsk3QoqBuvdamxouPhin7sw",
      }),
    ).toThrowError(CredentialBoundaryError);
  });

  it("rejects every browser-visible signing key", () => {
    expect(() =>
      sanitizeSigningEnvironment("localnet", { NEXT_PUBLIC_SAMURAI_SIGNER_KEY: "nope" }),
    ).toThrowError(CredentialBoundaryError);
  });

  it("requires an exact runtime revision in candidate evidence", () => {
    expect(runtimeRevisionFromEnvironment({ SAMURAI_TEZOS_RUNTIME_REVISION: "a".repeat(40) })).toBe(
      "a".repeat(40),
    );
    expect(() => runtimeRevisionFromEnvironment({})).toThrowError(CredentialBoundaryError);
  });
});
