import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runProfiledCommand } from "./command-runner";

const projectRoot = resolve(import.meta.dirname, "..");
const localnetEnvironment = {
  TEZOS_NETWORK: "localnet",
  TEZOS_RPC_URL: "http://127.0.0.1:8732",
  TEZOS_CHAIN_ID: "NetXtJqPyJGB6Pc",
  TEZOS_INDEXER_URL: "",
  NEXT_PUBLIC_TEZOS_NETWORK: "localnet",
  NEXT_PUBLIC_TEZOS_RPC_URL: "http://127.0.0.1:8732",
  NEXT_PUBLIC_TEZOS_CHAIN_ID: "NetXtJqPyJGB6Pc",
  NEXT_PUBLIC_TEZOS_INDEXER_URL: "",
  SAMURAI_TEZOS_RUNTIME_REVISION: "28487957a156c38b159ec03f36cbba509284c62e",
};

describe("project command contract", () => {
  it("does not spawn the child when readiness validation fails", async () => {
    const spawn = vi.fn(async () => 0);
    await expect(
      runProfiledCommand(projectRoot, "build", { ...localnetEnvironment, TEZOS_CHAIN_ID: "NetWrong" }, spawn),
    ).rejects.toThrow(/exactly match|pin chain/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("defines Localnet defaults, explicit Shadownet counterparts, and no Mainnet command", async () => {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const role of ["dev", "build", "start"] as const) {
      expect(packageJson.scripts[role]).toBe(`tsx scripts/run-network-command.ts localnet ${role}`);
      expect(packageJson.scripts[`${role}:shadownet`]).toBe(
        `tsx scripts/run-network-command.ts shadownet ${role}`,
      );
      expect(packageJson.scripts[`${role}:raw`]).toBe(`tsx scripts/run-profiled-command.ts ${role}`);
    }
    expect(packageJson.scripts["test:integration"]).toContain("localnet test:integration");
    expect(packageJson.scripts["test:shadownet"]).toContain("shadownet test:integration");
    expect(Object.keys(packageJson.scripts).some((name) => name.includes("mainnet"))).toBe(false);
  });
});
