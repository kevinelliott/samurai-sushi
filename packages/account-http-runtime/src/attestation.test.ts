import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_HTTP_ROUTES } from "./contract";
import { assertAccountRouteContract, RouteContractError } from "./attestation";

const webRoot = resolve(import.meta.dirname, "../../../apps/web");

describe("account route source attestation", () => {
  it("pins the complete exact route module inventory", async () => {
    await expect(assertAccountRouteContract(webRoot)).resolves.toBeUndefined();
  });

  it("fails on a commented, method-drifted, or extra handler", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "samurai-route-attestation-"));
    for (const [, path] of ACCOUNT_HTTP_ROUTES) {
      const source = resolve(webRoot, `app${path}/route.ts`);
      const target = resolve(root, `app${path}/route.ts`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source, "utf8"));
    }
    const drifted = resolve(root, "app/api/account/guest/issue/route.ts");
    await writeFile(drifted, `${await readFile(drifted, "utf8")}\nexport const GET = POST;\n`);
    await expect(assertAccountRouteContract(root)).rejects.toBeInstanceOf(RouteContractError);
  });
});
