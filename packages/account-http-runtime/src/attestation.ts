import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ACCOUNT_HTTP_ROUTES } from "./contract";

export class RouteContractError extends Error {
  constructor() {
    super("The account route contract is incomplete or drifted.");
    this.name = "RouteContractError";
  }
}

function expectedSource(id: string): string {
  return `import { handleNextRoute } from "@samurai-sushi/account-http-runtime/next";\n`
    + `export const runtime = "nodejs";\n`
    + `export const dynamic = "force-dynamic";\n`
    + `export async function POST(request: Request): Promise<Response> { return handleNextRoute("${id}", request); }\n`;
}

export async function assertAccountRouteContract(appRoot: string): Promise<void> {
  const expected = new Map(ACCOUNT_HTTP_ROUTES.map(([id, path]) => [
    `app${path}/route.ts`,
    id,
  ]));
  const files = (await readdir(appRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.startsWith("app/api/account/") && entry.endsWith("/route.ts"))
    .sort();
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new RouteContractError();
  for (const [file, id] of expected) {
    let source: string;
    try { source = await readFile(resolve(appRoot, file), "utf8"); } catch { throw new RouteContractError(); }
    if (source !== expectedSource(id)) throw new RouteContractError();
  }
}


export async function assertBuiltAccountRouteContract(appRoot: string): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(resolve(appRoot, ".next/server/app-paths-manifest.json"), "utf8")) as unknown;
  } catch { throw new RouteContractError(); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new RouteContractError();
  const actual = Object.keys(manifest as Record<string, unknown>)
    .filter((path) => path.startsWith("/api/account/"))
    .sort();
  const expected = ACCOUNT_HTTP_ROUTES.map(([, path]) => `${path}/route`).sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) throw new RouteContractError();
}
