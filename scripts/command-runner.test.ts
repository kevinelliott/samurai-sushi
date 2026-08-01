import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  materializeApprovedRuntime,
  projectProfileEnvironment,
  runProfiledCommand,
} from "./command-runner";
import type { RuntimePin } from "@samurai-sushi/network";

const projectRoot = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
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

  it("executes an archived commit tree that cannot drift with the sibling checkout", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "samurai-runtime-fixture-"));
    const runtimeRoot = resolve(root, "runtime");
    await mkdir(resolve(runtimeRoot, "scripts"), { recursive: true });
    await execFileAsync("git", ["init", runtimeRoot]);
    await writeFile(resolve(runtimeRoot, "scripts/profile.mjs"), "export const identity = 'approved';\n");
    await execFileAsync("git", ["-C", runtimeRoot, "add", "."]);
    await execFileAsync("git", [
      "-C",
      runtimeRoot,
      "-c",
      "user.name=Runtime Test",
      "-c",
      "user.email=runtime@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const { stdout } = await execFileAsync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"]);
    const pin: RuntimePin = {
      schemaVersion: 1,
      repository: "../runtime",
      revision: stdout.trim(),
      profileEntrypoint: "scripts/profile.mjs",
    };
    const execution = await materializeApprovedRuntime(runtimeRoot, pin);
    try {
      await writeFile(resolve(runtimeRoot, "scripts/profile.mjs"), "export const identity = 'drifted';\n");
      await expect(readFile(resolve(execution.root, pin.profileEntrypoint), "utf8")).resolves.toContain(
        "approved",
      );
    } finally {
      await execution.cleanup();
    }
  });

  it("hands the shared profile only the validated profile-scoped signer name", () => {
    const environment = projectProfileEnvironment("shadownet", "a".repeat(40), {
      SAMURAI_SHADOWNET_SIGNER_PRIVATE_KEY: "command-secret",
    });
    expect(environment.SAMURAI_SHADOWNET_SIGNER_PRIVATE_KEY).toBe("command-secret");
    expect(environment.SAMURAI_SIGNER_PRIVATE_KEY).toBeUndefined();
    expect(() =>
      projectProfileEnvironment("shadownet", "a".repeat(40), {
        SAMURAI_LOCALNET_SIGNER_PRIVATE_KEY: "wrong-profile",
      }),
    ).toThrow(/forbidden while running the shadownet profile/);
  });
});
