import { describe, expect, it } from "vitest";
import { ACCOUNT_COOKIE_NAMES, clearAccountCookie, parseAccountCookies, setAccountCookie } from "./cookies";

const secret = Buffer.alloc(32, 7).toString("base64url");

describe("account authority cookies", () => {
  it("uses the complete host-only cookie contract for set and clear", () => {
    expect(setAccountCookie("guest", secret)).toBe(
      `${ACCOUNT_COOKIE_NAMES.guest}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(clearAccountCookie("player")).toBe(
      `${ACCOUNT_COOKIE_NAMES.player}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  });

  it.each([
    `${ACCOUNT_COOKIE_NAMES.guest}=${secret}; ${ACCOUNT_COOKIE_NAMES.guest}=${secret}`,
    `${ACCOUNT_COOKIE_NAMES.guest}="${secret}"`,
    `${ACCOUNT_COOKIE_NAMES.guest}=${secret}%00`,
    `${ACCOUNT_COOKIE_NAMES.guest}=${secret},x=y`,
    `${ACCOUNT_COOKIE_NAMES.guest}=${secret.slice(0, -1)}B`,
  ])("rejects ambiguous or noncanonical authority cookies: %s", (header) => {
    expect(() => parseAccountCookies(header)).toThrow();
  });

  it("accepts all three independently canonical bearer classes", () => {
    const parsed = parseAccountCookies(Object.values(ACCOUNT_COOKIE_NAMES).map((name) => `${name}=${secret}`).join("; "));
    expect(parsed.size).toBe(3);
  });
});
