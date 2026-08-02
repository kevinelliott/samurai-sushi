import type { IncomingMessage, ServerResponse } from "node:http";
import { ACCOUNT_ROUTE_PATHS, PUBLIC_HTTP_FAILURES, RAW_HEADER_GUARD } from "./contract";
import type { AccountRuntimeConfig } from "./config";

function headerInventory(rawHeaders: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  if (rawHeaders.length % 2 !== 0) return values;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
  }
  return values;
}

function rejected(response: ServerResponse, status: number = PUBLIC_HTTP_FAILURES.request.status): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(PUBLIC_HTTP_FAILURES.request.body));
}

export function guardRawAccountRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AccountRuntimeConfig,
): boolean {
  const path = (request.url ?? "").split("?", 1)[0] ?? "";
  if (![...ACCOUNT_ROUTE_PATHS.values()].includes(path) || request.method !== "POST" || request.url !== path) {
    rejected(response, request.method === "POST" ? 400 : 405);
    return false;
  }
  const headers = headerInventory(request.rawHeaders);
  const one = (name: string): string | null => {
    const values = headers.get(name);
    return values?.length === 1 ? values[0]! : null;
  };
  const origin = one("origin");
  const host = one("host");
  const expectedHost = new URL(config.canonicalOrigin).host;
  const cookies = headers.get("cookie") ?? [];
  const forbidden = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", RAW_HEADER_GUARD];
  const contentLength = headers.get("content-length") ?? [];
  const transferEncoding = headers.get("transfer-encoding") ?? [];
  const contentType = headers.get("content-type") ?? [];
  if (origin !== config.canonicalOrigin || host !== expectedHost || cookies.length > 1
    || cookies.some((value) => value.includes(",")) || forbidden.some((name) => headers.has(name))
    || contentLength.length > 1 || transferEncoding.length > 1
    || (contentLength.length === 1 && transferEncoding.length === 1)
    || (transferEncoding.length === 1 && transferEncoding[0]?.toLowerCase() !== "chunked")
    || contentType.length !== 1 || contentType[0] !== "application/json"
    || headers.has("content-encoding")) {
    rejected(response);
    return false;
  }
  const canonical = new URL(config.canonicalOrigin);
  const protocol = canonical.protocol.slice(0, -1);
  request.headers[RAW_HEADER_GUARD] = config.rawHeaderGuard;
  request.headers["x-forwarded-host"] = canonical.host;
  request.headers["x-forwarded-proto"] = protocol;
  request.headers["x-forwarded-port"] = canonical.port || (protocol === "https" ? "443" : "80");
  request.headers["x-forwarded-for"] = request.socket.remoteAddress ?? "127.0.0.1";
  return true;
}
