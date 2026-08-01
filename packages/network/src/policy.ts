export type NetworkName = "localnet" | "shadownet";

export type NetworkEnvironment = Record<string, string | undefined>;

export interface NetworkProfile {
  readonly network: NetworkName;
  readonly rpcUrl: string;
  readonly chainId: string;
  readonly indexerUrl: string;
  readonly indexer: { readonly available: boolean; readonly reason?: "LOCALNET_NO_INDEXER" };
}

export type NetworkFailureCode =
  | "NETWORK_VALUE_MISSING"
  | "NETWORK_UNKNOWN"
  | "MAINNET_FORBIDDEN"
  | "NETWORK_PROFILE_MISMATCH"
  | "LOCALNET_RPC_FORBIDDEN"
  | "LOCALNET_CHAIN_MISMATCH"
  | "LOCALNET_INDEXER_FORBIDDEN"
  | "SHADOWNET_RPC_MISMATCH"
  | "SHADOWNET_CHAIN_MISMATCH"
  | "SHADOWNET_INDEXER_MISMATCH"
  | "BROWSER_SECRET_EXPOSURE";

export class NetworkPolicyError extends Error {
  constructor(
    readonly code: NetworkFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

const LOCALNET = Object.freeze({
  rpcUrl: "http://127.0.0.1:8732",
  chainId: "NetXtJqPyJGB6Pc",
  indexerUrl: "",
});

const SHADOWNET = Object.freeze({
  rpcUrl: "https://rpc.shadownet.teztnets.com",
  chainId: "NetXsqzbfFenSTS",
  indexerUrl: "https://api.shadownet.tzkt.io",
});

const NETWORK_KEYS = ["NETWORK", "RPC_URL", "CHAIN_ID", "INDEXER_URL"] as const;
const BROWSER_SECRET_PATTERN = /^NEXT_PUBLIC_.*(?:PRIVATE|SECRET|MNEMONIC|SIGNER|SK|KEY)/i;

function required(environment: NetworkEnvironment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new NetworkPolicyError("NETWORK_VALUE_MISSING", `${key} is required.`);
  }
  return value;
}

function normalizedOptional(environment: NetworkEnvironment, key: string): string {
  return environment[key]?.trim() ?? "";
}

function assertBrowserParity(environment: NetworkEnvironment): void {
  for (const key of NETWORK_KEYS) {
    const serverKey = `TEZOS_${key}`;
    const browserKey = `NEXT_PUBLIC_TEZOS_${key}`;
    if (normalizedOptional(environment, serverKey) !== normalizedOptional(environment, browserKey)) {
      throw new NetworkPolicyError(
        "NETWORK_PROFILE_MISMATCH",
        `${browserKey} must exactly match ${serverKey}.`,
      );
    }
  }
}

function assertNoBrowserSecrets(environment: NetworkEnvironment): void {
  const exposed = Object.keys(environment).find(
    (key) => BROWSER_SECRET_PATTERN.test(key) && Boolean(environment[key]?.trim()),
  );
  if (exposed) {
    throw new NetworkPolicyError(
      "BROWSER_SECRET_EXPOSURE",
      `${exposed} must never contain signing or secret material.`,
    );
  }
}

function canonicalUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new NetworkPolicyError("NETWORK_PROFILE_MISMATCH", `${label} must be an absolute URL.`);
  }
}

export function validateNetworkEnvironment(environment: NetworkEnvironment): NetworkProfile {
  assertNoBrowserSecrets(environment);
  assertBrowserParity(environment);

  const network = required(environment, "TEZOS_NETWORK").toLowerCase();
  if (network === "mainnet") {
    throw new NetworkPolicyError(
      "MAINNET_FORBIDDEN",
      "Mainnet is unavailable from Samurai Sushi development commands.",
    );
  }
  if (network !== "localnet" && network !== "shadownet") {
    throw new NetworkPolicyError("NETWORK_UNKNOWN", `Unknown TEZOS_NETWORK ${JSON.stringify(network)}.`);
  }

  const rpcUrl = canonicalUrl(required(environment, "TEZOS_RPC_URL"), "TEZOS_RPC_URL");
  const chainId = required(environment, "TEZOS_CHAIN_ID");
  const indexerUrl = normalizedOptional(environment, "TEZOS_INDEXER_URL");

  if (network === "localnet") {
    const rpc = rpcUrl.href.replace(/\/$/, "");
    if (rpc !== LOCALNET.rpcUrl || rpcUrl.hostname !== "127.0.0.1") {
      throw new NetworkPolicyError(
        "LOCALNET_RPC_FORBIDDEN",
        `Localnet RPC must be exactly ${LOCALNET.rpcUrl}.`,
      );
    }
    if (chainId !== LOCALNET.chainId) {
      throw new NetworkPolicyError(
        "LOCALNET_CHAIN_MISMATCH",
        `Localnet must pin chain ${LOCALNET.chainId}.`,
      );
    }
    if (indexerUrl) {
      throw new NetworkPolicyError(
        "LOCALNET_INDEXER_FORBIDDEN",
        "Localnet has no indexer; indexer-backed features must be unavailable.",
      );
    }
    return {
      network,
      rpcUrl: LOCALNET.rpcUrl,
      chainId,
      indexerUrl: "",
      indexer: { available: false, reason: "LOCALNET_NO_INDEXER" },
    };
  }

  const rpc = rpcUrl.href.replace(/\/$/, "");
  if (rpc !== SHADOWNET.rpcUrl) {
    throw new NetworkPolicyError(
      "SHADOWNET_RPC_MISMATCH",
      `Shadownet RPC must be exactly ${SHADOWNET.rpcUrl}.`,
    );
  }
  if (chainId !== SHADOWNET.chainId) {
    throw new NetworkPolicyError(
      "SHADOWNET_CHAIN_MISMATCH",
      `Shadownet must pin chain ${SHADOWNET.chainId}.`,
    );
  }
  if (indexerUrl.replace(/\/$/, "") !== SHADOWNET.indexerUrl) {
    throw new NetworkPolicyError(
      "SHADOWNET_INDEXER_MISMATCH",
      `Shadownet indexer must be exactly ${SHADOWNET.indexerUrl}.`,
    );
  }
  return {
    network,
    rpcUrl: SHADOWNET.rpcUrl,
    chainId,
    indexerUrl: SHADOWNET.indexerUrl,
    indexer: { available: true },
  };
}

export const networkIdentities = Object.freeze({
  localnet: LOCALNET,
  shadownet: SHADOWNET,
});
