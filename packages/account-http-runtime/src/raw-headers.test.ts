import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountRuntimeConfig } from "./config";
import { guardRawAccountRequest } from "./raw-headers";

const config = {
  canonicalOrigin: "https://game.samurai-sushi.example",
  rawHeaderGuard: Buffer.alloc(32, 8).toString("base64url"),
} as AccountRuntimeConfig;

function attempt(extra: readonly string[] = []): { readonly accepted: boolean; readonly request: IncomingMessage; readonly status: number } {
  const request = {
    url: "/api/account/guest/issue",
    method: "POST",
    rawHeaders: [
      "Host", "game.samurai-sushi.example",
      "Origin", config.canonicalOrigin,
      "Content-Type", "application/json",
      ...extra,
    ],
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  const state = { status: 200 };
  const response = {
    set statusCode(value: number) { state.status = value; },
    get statusCode() { return state.status; },
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse;
  return { accepted: guardRawAccountRequest(request, response, config), request, status: state.status };
}

describe("raw account request authority", () => {
  it("binds canonical forwarded authority only after the wire inventory passes", () => {
    const result = attempt();
    expect(result.accepted).toBe(true);
    expect(result.request.headers).toMatchObject({
      "x-forwarded-host": "game.samurai-sushi.example",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "x-samurai-raw-header-guard": config.rawHeaderGuard,
    });
  });

  it.each([
    ["Content-Type", "application/json"],
    ["Content-Type", "application/json; charset=utf-8"],
    ["Content-Type", "Application/JSON"],
    ["X-Samurai-Raw-Header-Guard", config.rawHeaderGuard],
    ["X-Forwarded-Proto", "https"],
    ["Forwarded", "proto=https;host=game.samurai-sushi.example"],
  ])("rejects client-controlled or duplicate raw authority %s", (name, value) => {
    const result = attempt([name, value]);
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(400);
  });
});
