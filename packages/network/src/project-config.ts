import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export class CompetingNetworkConfigError extends Error {
  readonly code = "COMPETING_NETWORK_CONFIG";

  constructor(readonly files: readonly string[]) {
    super(`Network keys are forbidden in project environment files: ${files.join(", ")}.`);
    this.name = "CompetingNetworkConfigError";
  }
}

const NETWORK_LINE = /^\s*(?:export\s+)?(?:TEZOS_|NEXT_PUBLIC_TEZOS_)[A-Z0-9_]*\s*=/m;

async function environmentFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.startsWith(".env") &&
        entry.name !== ".env.example",
    )
    .map((entry) => resolve(directory, entry.name));
}

export async function findCompetingNetworkConfig(projectRoot: string): Promise<string[]> {
  const candidates = [
    ...(await environmentFiles(projectRoot)),
    ...(await environmentFiles(resolve(projectRoot, "apps/web"))),
  ];
  const conflicts: string[] = [];
  for (const filename of candidates) {
    const contents = await readFile(filename, "utf8");
    if (NETWORK_LINE.test(contents)) conflicts.push(filename);
  }
  return conflicts.sort();
}

export async function assertNoCompetingNetworkConfig(projectRoot: string): Promise<void> {
  const conflicts = await findCompetingNetworkConfig(projectRoot);
  if (conflicts.length > 0) throw new CompetingNetworkConfigError(conflicts);
}
