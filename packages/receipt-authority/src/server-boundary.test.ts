import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

function resolveServerExport(conditions: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [...conditions.map((condition) => `--conditions=${condition}`), "--import", "tsx", "packages/receipt-authority/src/server-import-probe.ts"],
    { cwd: root, encoding: "utf8" },
  );
}

describe("receipt authority server-only export boundary", () => {
  it("resolves issuance only for the server condition and rejects browser resolution", () => {
    const server = resolveServerExport([]);
    expect(server.status, `${server.stdout}\n${server.stderr}`).toBe(0);
    const browser = resolveServerExport(["browser"]);
    expect(browser.status).not.toBe(0);
    expect(`${browser.stdout}\n${browser.stderr}`).toContain("Receipt commitment and issuance modules are server-only.");
  });

  it("keeps private-input modules and deterministic fixtures out of the package root", () => {
    const index = readFileSync(resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(index).not.toMatch(/commitment|issuance|test-fixture/);
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(manifest.exports?.["./commitment"]).toBeUndefined();
    expect(manifest.exports?.["./issuance"]).toBeUndefined();
    expect(manifest.exports?.["./test-fixture"]).toBeUndefined();
    expect(manifest.exports?.["./server"]).toEqual({
      types: "./src/server.ts",
      browser: "./src/browser-rejected.ts",
      default: "./src/server.ts",
    });
  });
});
