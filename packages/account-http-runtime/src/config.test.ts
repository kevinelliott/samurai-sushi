import { describe, expect, it } from "vitest";
import { loadAccountRuntimeConfig, RuntimeConfigurationError } from "./config";

const key = Buffer.alloc(32, 9).toString("base64url");
function environment(chainId = "NetXtJqPyJGB6Pc"): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SAMURAI_CANONICAL_ORIGIN: "https://game.samurai-sushi.example",
    SAMURAI_DATABASE_URL: "postgresql://database.invalid/samurai",
    SAMURAI_HMAC_ACTIVATED_AT: "2026-08-01T00:00:00.000Z",
    SAMURAI_HMAC_RESUME_KEY: key,
    SAMURAI_HMAC_TOMBSTONE_KEY: Buffer.alloc(32, 10).toString("base64url"),
    SAMURAI_HMAC_GUEST_CLAIM_KEY: Buffer.alloc(32, 11).toString("base64url"),
    SAMURAI_HMAC_PLAYER_SESSION_KEY: Buffer.alloc(32, 12).toString("base64url"),
    SAMURAI_INTERNAL_RAW_HEADER_GUARD: Buffer.alloc(32, 13).toString("base64url"),
    TEZOS_CHAIN_ID: chainId,
  };
}

describe("server-only account runtime configuration", () => {
  it.each(["NetXtJqPyJGB6Pc", "NetXsqzbfFenSTS"])("accepts canonical chain %s", (chainId) => {
    expect(loadAccountRuntimeConfig(environment(chainId)).chainId).toBe(chainId);
  });

  it.each(["NetXtJqPyJGB6Pd", "Net1111111111", "expruDummyPrefix"]) (
    "rejects a noncanonical ChainID authority: %s",
    (chainId) => expect(() => loadAccountRuntimeConfig(environment(chainId))).toThrow(RuntimeConfigurationError),
  );

  it("requires an explicit loopback exception and rejects public configuration aliases", () => {
    const source: NodeJS.ProcessEnv = { ...environment(), SAMURAI_CANONICAL_ORIGIN: "http://127.0.0.1:3000" };
    expect(() => loadAccountRuntimeConfig(source)).toThrow(RuntimeConfigurationError);
    source.SAMURAI_ALLOW_LOOPBACK_HTTP = "true";
    expect(loadAccountRuntimeConfig(source).canonicalOrigin).toBe("http://127.0.0.1:3000");
  });

  it("admits one exact verification-only resume key only as a complete lifecycle tuple", () => {
    const source: NodeJS.ProcessEnv = {
      ...environment(),
      SAMURAI_HMAC_RESUME_KEY: Buffer.alloc(32, 19).toString("base64url"),
      SAMURAI_HMAC_RESUME_PREVIOUS_KEY: key,
      SAMURAI_HMAC_RESUME_PREVIOUS_RETIRED_AT: "2026-08-01T12:00:00.000Z",
      SAMURAI_HMAC_RESUME_PREVIOUS_VERIFY_UNTIL: "2026-09-01T00:00:00.000Z",
    };
    const config = loadAccountRuntimeConfig(source);
    expect(config.keys.resume.version).toBe(2);
    expect(config.resumeVerificationKeys).toMatchObject([{ version: 1 }]);
    delete source.SAMURAI_HMAC_RESUME_PREVIOUS_VERIFY_UNTIL;
    expect(() => loadAccountRuntimeConfig(source)).toThrow(RuntimeConfigurationError);
  });
});
