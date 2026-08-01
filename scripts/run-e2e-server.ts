import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { networkIdentities, validateRuntimePin } from "@samurai-sushi/network";
import { runProfiledCommand } from "./command-runner";

const projectRoot = resolve(import.meta.dirname, "..");
const pin = validateRuntimePin(
  JSON.parse(await readFile(resolve(projectRoot, ".tezos-runtime.json"), "utf8")) as unknown,
);
const localnet = networkIdentities.localnet;

process.exitCode = await runProfiledCommand(projectRoot, "dev", {
  ...process.env,
  TEZOS_NETWORK: "localnet",
  TEZOS_RPC_URL: localnet.rpcUrl,
  TEZOS_CHAIN_ID: localnet.chainId,
  TEZOS_INDEXER_URL: localnet.indexerUrl,
  NEXT_PUBLIC_TEZOS_NETWORK: "localnet",
  NEXT_PUBLIC_TEZOS_RPC_URL: localnet.rpcUrl,
  NEXT_PUBLIC_TEZOS_CHAIN_ID: localnet.chainId,
  NEXT_PUBLIC_TEZOS_INDEXER_URL: localnet.indexerUrl,
  SAMURAI_TEZOS_RUNTIME_REVISION: pin.revision,
});
