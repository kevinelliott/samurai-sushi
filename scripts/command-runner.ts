import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertApprovedRuntimeState,
  assertNoCompetingNetworkConfig,
  runtimeRevisionFromEnvironment,
  validateSigningEnvironment,
  validateNetworkEnvironment,
  validateRuntimePin,
  type NetworkEnvironment,
  type NetworkName,
  type RuntimePin,
} from "@samurai-sushi/network";

const execFileAsync = promisify(execFile);

export type CommandRole = "dev" | "build" | "start" | "test:integration";
type SpawnChild = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<number>;

export const rawCommands: Readonly<Record<CommandRole, readonly string[]>> = Object.freeze({
  dev: ["pnpm", "--filter", "@samurai-sushi/web", "dev"],
  build: ["pnpm", "--filter", "@samurai-sushi/web", "build"],
  start: ["pnpm", "--filter", "@samurai-sushi/web", "start"],
  "test:integration": ["pnpm", "exec", "vitest", "run", "--config", "vitest.integration.config.ts"],
});

export function parseCommandRole(value: string | undefined): CommandRole {
  if (!value || !(value in rawCommands)) throw new Error(`Unsupported project command role ${JSON.stringify(value)}.`);
  return value as CommandRole;
}

export function parseNetworkName(value: string | undefined): NetworkName {
  if (value !== "localnet" && value !== "shadownet") {
    throw new Error(`Unsupported network profile ${JSON.stringify(value)}.`);
  }
  return value;
}

export async function spawnChild(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`Child process exited from signal ${signal}.`));
      resolveExit(code ?? 1);
    });
  });
}

export async function runProfiledCommand(
  projectRoot: string,
  role: CommandRole,
  environment: NetworkEnvironment,
  runner: SpawnChild = spawnChild,
): Promise<number> {
  await assertNoCompetingNetworkConfig(projectRoot);
  validateNetworkEnvironment(environment);
  const pin = validateRuntimePin(
    JSON.parse(await readFile(resolve(projectRoot, ".tezos-runtime.json"), "utf8")) as unknown,
  );
  if (runtimeRevisionFromEnvironment(environment) !== pin.revision) {
    throw new Error("Injected runtime revision does not match the committed candidate pin.");
  }
  const [command, ...args] = rawCommands[role];
  if (!command) throw new Error(`No raw command for ${role}.`);
  return runner(command, args, environment);
}

export async function materializeApprovedRuntime(
  runtimeRoot: string,
  pin: RuntimePin,
): Promise<{ readonly root: string; cleanup(): Promise<void> }> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "samurai-sushi-runtime-"));
  const executionRoot = resolve(temporaryRoot, "runtime");
  const archivePath = resolve(temporaryRoot, "runtime.tar");
  await mkdir(executionRoot);
  try {
    await execFileAsync("git", [
      "-C",
      runtimeRoot,
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      pin.revision,
    ]);
    await execFileAsync("tar", ["-xf", archivePath, "-C", executionRoot]);
    await rm(archivePath, { force: true });
    await readFile(resolve(executionRoot, pin.profileEntrypoint), "utf8");
    return {
      root: executionRoot,
      cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function projectProfileEnvironment(
  network: NetworkName,
  revision: string,
  source: NetworkEnvironment,
): NetworkEnvironment {
  const environment = {
    ...source,
    SAMURAI_TEZOS_RUNTIME_REVISION: revision,
  };
  validateSigningEnvironment(network, environment);
  return environment;
}

export async function runNetworkCommand(
  projectRoot: string,
  network: NetworkName,
  role: CommandRole,
  runner: SpawnChild = spawnChild,
): Promise<number> {
  const pin = validateRuntimePin(
    JSON.parse(await readFile(resolve(projectRoot, ".tezos-runtime.json"), "utf8")) as unknown,
  );
  const runtimeRoot = resolve(projectRoot, pin.repository);
  const [{ stdout: revision }, { stdout: porcelain }] = await Promise.all([
    execFileAsync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", runtimeRoot, "status", "--porcelain=v1"]),
  ]);
  assertApprovedRuntimeState(pin, { revision: revision.trim(), porcelain });
  const environment = projectProfileEnvironment(network, pin.revision, process.env);
  const execution = await materializeApprovedRuntime(runtimeRoot, pin);
  try {
    return await runner(
      process.execPath,
      [resolve(execution.root, pin.profileEntrypoint), network, "--", "pnpm", `${role}:raw`],
      environment as NodeJS.ProcessEnv,
    );
  } finally {
    await execution.cleanup();
  }
}
