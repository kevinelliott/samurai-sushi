import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompetingNetworkConfigError,
  assertNoCompetingNetworkConfig,
  findCompetingNetworkConfig,
} from "./project-config";

const temporaryRoots: string[] = [];

async function projectRoot() {
  const root = await mkdtemp(join(tmpdir(), "samurai-network-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps/web"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project environment files", () => {
  it("allows unrelated application values and the committed example", async () => {
    const root = await projectRoot();
    await writeFile(join(root, ".env.local"), "DATABASE_URL=postgres://fixture\n");
    await writeFile(join(root, ".env.example"), "TEZOS_NETWORK=localnet\n");
    expect(await findCompetingNetworkConfig(root)).toEqual([]);
  });

  it.each([".env", ".env.local", ".env.development", ".env.production", ".env.shadownet"])(
    "rejects network authority in %s",
    async (filename) => {
      const root = await projectRoot();
      await writeFile(join(root, "apps/web", filename), "NEXT_PUBLIC_TEZOS_NETWORK=localnet\n");
      await expect(assertNoCompetingNetworkConfig(root)).rejects.toBeInstanceOf(
        CompetingNetworkConfigError,
      );
    },
  );

  it("cannot bypass network-key rejection through a symlinked environment file", async () => {
    const root = await projectRoot();
    const source = join(root, "network-values");
    await writeFile(source, "TEZOS_NETWORK=localnet\n");
    await symlink(source, join(root, "apps/web/.env.local"));
    await expect(assertNoCompetingNetworkConfig(root)).rejects.toBeInstanceOf(
      CompetingNetworkConfigError,
    );
  });
});
