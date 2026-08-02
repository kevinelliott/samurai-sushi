export const ACCOUNT_COOKIE_NAMES = Object.freeze({
  guest: "__Host-samurai-guest",
  claim: "__Host-samurai-guest-claim",
  player: "__Host-samurai-player",
} as const);

export type AccountCookieKind = keyof typeof ACCOUNT_COOKIE_NAMES;
export const MAX_COOKIE_BYTES = 4_096;
export const MAX_COOKIE_COUNT = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function canonicalSecret(value: string): boolean {
  if (!SECRET_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

export class CookieRejectedError extends Error {
  constructor() {
    super("The cookie header is invalid.");
    this.name = "CookieRejectedError";
  }
}

export function parseAccountCookies(header: string | null): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (header === null || header.length === 0) return result;
  const hasControl = [...header].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (Buffer.byteLength(header, "utf8") > MAX_COOKIE_BYTES || /[,"%]/.test(header) || hasControl) {
    throw new CookieRejectedError();
  }
  const parts = header.split(";");
  if (parts.length > MAX_COOKIE_COUNT) throw new CookieRejectedError();
  for (const raw of parts) {
    const part = raw.trim();
    const equals = part.indexOf("=");
    if (!part || equals <= 0 || equals !== part.lastIndexOf("=")) throw new CookieRejectedError();
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (!COOKIE_NAME_PATTERN.test(name) || result.has(name)) throw new CookieRejectedError();
    result.set(name, value);
  }
  for (const name of Object.values(ACCOUNT_COOKIE_NAMES)) {
    const value = result.get(name);
    if (value !== undefined && !canonicalSecret(value)) throw new CookieRejectedError();
  }
  return result;
}

const attributes = "Path=/; Secure; HttpOnly; SameSite=Strict";

export function setAccountCookie(kind: AccountCookieKind, secret: string): string {
  if (!canonicalSecret(secret)) throw new CookieRejectedError();
  return `${ACCOUNT_COOKIE_NAMES[kind]}=${secret}; ${attributes}`;
}

export function clearAccountCookie(kind: AccountCookieKind): string {
  return `${ACCOUNT_COOKIE_NAMES[kind]}=; ${attributes}; Max-Age=0`;
}
