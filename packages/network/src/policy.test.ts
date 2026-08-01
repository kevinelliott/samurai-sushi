import { describe, expect, it } from "vitest";
import { networkIdentities, validateNetworkEnvironment } from "./policy";

function profile(network: "localnet" | "shadownet") {
  const identity = networkIdentities[network];
  return {
    TEZOS_NETWORK: network,
    TEZOS_RPC_URL: identity.rpcUrl,
    TEZOS_CHAIN_ID: identity.chainId,
    TEZOS_INDEXER_URL: identity.indexerUrl,
    NEXT_PUBLIC_TEZOS_NETWORK: network,
    NEXT_PUBLIC_TEZOS_RPC_URL: identity.rpcUrl,
    NEXT_PUBLIC_TEZOS_CHAIN_ID: identity.chainId,
    NEXT_PUBLIC_TEZOS_INDEXER_URL: identity.indexerUrl,
  };
}

describe("network policy", () => {
  it("accepts only the exact loopback Localnet identity with no indexer", () => {
    expect(validateNetworkEnvironment(profile("localnet"))).toEqual({
      network: "localnet",
      rpcUrl: "http://127.0.0.1:8732",
      chainId: "NetXtJqPyJGB6Pc",
      indexerUrl: "",
      indexer: { available: false, reason: "LOCALNET_NO_INDEXER" },
    });
  });

  it("accepts only the explicit pinned Shadownet identity", () => {
    expect(validateNetworkEnvironment(profile("shadownet"))).toMatchObject({
      network: "shadownet",
      chainId: "NetXsqzbfFenSTS",
      indexer: { available: true },
    });
  });

  it.each([
    ["missing network", { ...profile("localnet"), TEZOS_NETWORK: "", NEXT_PUBLIC_TEZOS_NETWORK: "" }, "NETWORK_VALUE_MISSING"],
    ["unknown network", { ...profile("localnet"), TEZOS_NETWORK: "ghostnet", NEXT_PUBLIC_TEZOS_NETWORK: "ghostnet" }, "NETWORK_UNKNOWN"],
    ["Mainnet", { ...profile("localnet"), TEZOS_NETWORK: "mainnet", NEXT_PUBLIC_TEZOS_NETWORK: "mainnet" }, "MAINNET_FORBIDDEN"],
    ["localhost alias", { ...profile("localnet"), TEZOS_RPC_URL: "http://localhost:8732", NEXT_PUBLIC_TEZOS_RPC_URL: "http://localhost:8732" }, "LOCALNET_RPC_FORBIDDEN"],
    ["wrong local chain", { ...profile("localnet"), TEZOS_CHAIN_ID: "NetWrong", NEXT_PUBLIC_TEZOS_CHAIN_ID: "NetWrong" }, "LOCALNET_CHAIN_MISMATCH"],
    ["local indexer", { ...profile("localnet"), TEZOS_INDEXER_URL: "https://api.tzkt.io", NEXT_PUBLIC_TEZOS_INDEXER_URL: "https://api.tzkt.io" }, "LOCALNET_INDEXER_FORBIDDEN"],
    ["server/browser drift", { ...profile("localnet"), NEXT_PUBLIC_TEZOS_CHAIN_ID: "NetWrong" }, "NETWORK_PROFILE_MISMATCH"],
    ["wrong Shadownet RPC", { ...profile("shadownet"), TEZOS_RPC_URL: "https://example.com", NEXT_PUBLIC_TEZOS_RPC_URL: "https://example.com" }, "SHADOWNET_RPC_MISMATCH"],
    ["wrong Shadownet chain", { ...profile("shadownet"), TEZOS_CHAIN_ID: "NetWrong", NEXT_PUBLIC_TEZOS_CHAIN_ID: "NetWrong" }, "SHADOWNET_CHAIN_MISMATCH"],
    ["wrong Shadownet indexer", { ...profile("shadownet"), TEZOS_INDEXER_URL: "https://example.com", NEXT_PUBLIC_TEZOS_INDEXER_URL: "https://example.com" }, "SHADOWNET_INDEXER_MISMATCH"],
    ["browser secret", { ...profile("localnet"), NEXT_PUBLIC_TEZOS_PRIVATE_KEY: "nope" }, "BROWSER_SECRET_EXPOSURE"],
  ])("rejects %s", (_label, environment, code) => {
    try {
      validateNetworkEnvironment(environment);
      throw new Error("Expected the profile to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });
});
