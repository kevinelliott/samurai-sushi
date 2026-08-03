import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { assertNoReceiptWebContamination, deterministicRegularFiles } from "./receipt-web-source-scan";

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "samurai-receipt-web-scan-"));
  for (const file of ["apps/web/app/z.ts", "apps/web/app/nested/a.ts", "apps/web/public/icon.txt"]) {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), "safe\n");
  }
  return root;
}

function executableFromPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the caller's original path without invoking an external locator.
    }
  }
  throw new Error(`Required test executable ${name} is unavailable.`);
}

describe("receipt web-source contamination scan", () => {
  it("walks only regular files in deterministic repository-relative POSIX order", () => {
    const root = fixture();
    expect(deterministicRegularFiles(root, ["apps/web/app", "apps/web/public"])).toEqual([
      "apps/web/app/nested/a.ts",
      "apps/web/app/z.ts",
      "apps/web/public/icon.txt",
    ]);
    expect(() => deterministicRegularFiles(root, ["../outside"]))
      .toThrow(/Web source scan root is unsafe/);
    expect(() => deterministicRegularFiles(root, [resolve(root, "apps/web/app")]))
      .toThrow(/Web source scan root is unsafe/);
  });

  it("rejects the existing contamination expressions and symbolic links fail closed", () => {
    const root = fixture();
    writeFileSync(resolve(root, "apps/web/public/icon.txt"), "issuerSignature\n");
    expect(() => assertNoReceiptWebContamination(root, ["apps/web/app", "apps/web/public"]))
      .toThrow(/Receipt authority or fixture secret crossed into the web source/);
    writeFileSync(resolve(root, "apps/web/public/icon.txt"), "safe\n");
    symlinkSync(resolve(root, "apps/web/app/z.ts"), resolve(root, "apps/web/app/linked.ts"));
    expect(() => deterministicRegularFiles(root, ["apps/web/app", "apps/web/public"]))
      .toThrow(/rejects symbolic link apps\/web\/app\/linked\.ts/);
  });

  it("rejects unsupported filesystem entries rather than silently omitting them", async () => {
    const root = mkdtempSync("/tmp/ssrs-");
    mkdirSync(resolve(root, "apps/web/app"), { recursive: true });
    mkdirSync(resolve(root, "apps/web/public"), { recursive: true });
    const socketPath = resolve(root, "apps/web/public/source.sock");
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });
    try {
      expect(() => deterministicRegularFiles(root, ["apps/web/app", "apps/web/public"]))
        .toThrow(/rejects unsupported filesystem entry apps\/web\/public\/source\.sock/);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("invokes the complete verifier with Node and pnpm available but no rg", () => {
    const controlledBin = mkdtempSync(resolve(tmpdir(), "samurai-receipt-path-"));
    symlinkSync(process.execPath, resolve(controlledBin, "node"));
    symlinkSync(executableFromPath("pnpm"), resolve(controlledBin, "pnpm"));
    const controlledEnvironment = { ...process.env, PATH: controlledBin };
    expect(() => accessSync(resolve(controlledBin, "node"), constants.X_OK)).not.toThrow();
    expect(() => accessSync(resolve(controlledBin, "pnpm"), constants.X_OK)).not.toThrow();
    const missingRg = spawnSync("rg", ["--version"], { env: controlledEnvironment, encoding: "utf8" });
    expect(missingRg.error).toMatchObject({ code: "ENOENT" });
    const result = spawnSync("node", ["--import", "tsx", "scripts/verify-receipt-authority.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: controlledEnvironment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('"deploymentClaim":"source-only-not-originated"');
  });
});
