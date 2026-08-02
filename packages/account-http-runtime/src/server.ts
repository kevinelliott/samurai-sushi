import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { assertAccountRouteContract, assertBuiltAccountRouteContract } from "./attestation";
import { loadAccountRuntimeConfig, RuntimeConfigurationError, type AccountRuntimeConfig } from "./config";
import { PUBLIC_HTTP_FAILURES } from "./contract";
import { guardRawAccountRequest } from "./raw-headers";
import { closeAccountRuntime, initializeAccountRuntime } from "./next";

function unavailable(response: ServerResponse): void {
  if (response.headersSent) return;
  response.statusCode = PUBLIC_HTTP_FAILURES.runtime.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(PUBLIC_HTTP_FAILURES.runtime.body));
}

function accountCandidate(target: string): boolean {
  const rawPath = target.split("?", 1)[0] ?? "";
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch { /* A malformed encoded account prefix is still rejected below. */ }
  const segments: string[] = [];
  for (const segment of decoded.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop(); else segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  return rawPath.startsWith("/api/account") || decoded.startsWith("/api/account")
    || normalized.startsWith("/api/account") || rawPath.startsWith("/api/%");
}

export interface AccountNextServer extends Server {
  closeAll(): Promise<void>;
}

export async function startAccountNextServer(options: {
  readonly appRoot: string;
  readonly port: number;
  readonly hostname?: string;
  readonly dev: boolean;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<AccountNextServer> {
  await assertAccountRouteContract(resolve(options.appRoot));
  let config: AccountRuntimeConfig | null;
  try {
    config = loadAccountRuntimeConfig(options.environment);
  } catch (error) {
    if (!(error instanceof RuntimeConfigurationError)) throw error;
    config = null;
  }
  if (config) await initializeAccountRuntime(config);
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const next = (await import("next")).default;
    const app = next({ dev: options.dev, dir: options.appRoot, hostname: options.hostname ?? "127.0.0.1", port: options.port });
    closeApp = () => app.close();
    await app.prepare();
    if (!options.dev) await assertBuiltAccountRouteContract(resolve(options.appRoot));
    const handler = app.getRequestHandler();
    server = createServer((request, response) => {
      if (accountCandidate(request.url ?? "")) {
        if (!config) {
          unavailable(response);
          return;
        }
        if (!guardRawAccountRequest(request, response, config)) return;
      }
      void handler(request, response).catch(() => {
        if (response.headersSent) response.destroy(); else unavailable(response);
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(options.port, options.hostname ?? "127.0.0.1", resolveListen);
    });
  } catch (error) {
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    await Promise.allSettled([closeApp?.(), config ? closeAccountRuntime() : Promise.resolve()]);
    throw error;
  }
  const managed = server as AccountNextServer;
  managed.closeAll = async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await Promise.all([closeApp!(), config ? closeAccountRuntime() : Promise.resolve()]);
  };
  return managed;
}
