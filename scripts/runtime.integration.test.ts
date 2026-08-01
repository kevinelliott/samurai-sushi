import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertApprovedRuntimeState, validateRuntimePin } from "@samurai-sushi/network";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");

describe("shared runtime integration", () => {
  it("uses the exact clean candidate runtime revision", async () => {
    const pin = validateRuntimePin(
      JSON.parse(await readFile(resolve(projectRoot, ".tezos-runtime.json"), "utf8")) as unknown,
    );
    const runtimeRoot = resolve(projectRoot, pin.repository);
    const [{ stdout: revision }, { stdout: porcelain }] = await Promise.all([
      execFileAsync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", runtimeRoot, "status", "--porcelain=v1"]),
    ]);
    expect(() => assertApprovedRuntimeState(pin, { revision: revision.trim(), porcelain })).not.toThrow();
  });
});
