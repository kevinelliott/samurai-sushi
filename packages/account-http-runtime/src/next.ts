import { ACCOUNT_ROUTE_IDS, PUBLIC_HTTP_FAILURES, type AccountRouteId } from "./contract";
import type { AccountRuntimeConfig } from "./config";
import { composeAccountRuntime, type AccountRuntimeServices } from "./composition";
import { handleAccountHttpRequest } from "./http";

interface RuntimeState {
  readonly identity: string;
  readonly config: AccountRuntimeConfig;
  readonly runtime: Promise<AccountRuntimeServices>;
}

const stateKey = Symbol.for("samurai-sushi.account-http-runtime.state.v1");
type RuntimeGlobal = typeof globalThis & { [stateKey]?: RuntimeState };
const runtimeGlobal = globalThis as RuntimeGlobal;

function configIdentity(config: AccountRuntimeConfig): string {
  return [config.canonicalOrigin, config.chainId, config.databaseUrl, config.rawHeaderGuard,
    ...Object.values(config.keys).map((key) => `${key.version}:${key.keyIdentity}:${key.activatedAt.toISOString()}`),
    ...config.resumeVerificationKeys.map((key) => [key.version, key.keyIdentity, key.activatedAt.toISOString(),
      key.retiredAt?.toISOString() ?? "", key.verifyUntil?.toISOString() ?? "", key.compromisedAt?.toISOString() ?? ""].join(":")),
    config.receiptPolicy ? [config.receiptPolicy.destination, config.receiptPolicy.issuerKeyId,
      config.receiptPolicy.issuerPolicyVersion].join(":") : "receipt-disabled",
  ].join("|");
}

function unavailable(): Response {
  return new Response(JSON.stringify(PUBLIC_HTTP_FAILURES.runtime.body), {
    status: PUBLIC_HTTP_FAILURES.runtime.status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

export async function handleNextRoute(operation: AccountRouteId, request: Request): Promise<Response> {
  if (!ACCOUNT_ROUTE_IDS.has(operation)) return unavailable();
  try {
    const state = runtimeGlobal[stateKey];
    if (!state) return unavailable();
    return await handleAccountHttpRequest(operation, request, await state.runtime, state.config);
  } catch {
    return unavailable();
  }
}

export async function initializeAccountRuntime(config: AccountRuntimeConfig): Promise<void> {
  const identity = configIdentity(config);
  const existing = runtimeGlobal[stateKey];
  if (existing && existing.identity !== identity) throw new Error("Account runtime configuration drift.");
  if (existing) {
    await existing.runtime;
    return;
  }
  const state: RuntimeState = { identity, config, runtime: composeAccountRuntime(config) };
  runtimeGlobal[stateKey] = state;
  try {
    await state.runtime;
  } catch (error) {
    if (runtimeGlobal[stateKey] === state) delete runtimeGlobal[stateKey];
    throw error;
  }
}

export async function closeAccountRuntime(): Promise<void> {
  const state = runtimeGlobal[stateKey];
  delete runtimeGlobal[stateKey];
  if (state) await state.runtime.then((runtime) => runtime.close()).catch(() => undefined);
}

export async function resetAccountRuntimeForTests(): Promise<void> {
  await closeAccountRuntime();
}
