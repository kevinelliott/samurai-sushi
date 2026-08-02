import { createHash } from "node:crypto";

export interface SpriteRequirement {
  readonly key: string;
  readonly dimensions: string;
}

export interface SpriteAttestation {
  readonly fileDigest: string;
  readonly symbolDigests: Readonly<Record<string, string>>;
}

function sameAttestation(actual: SpriteAttestation, expected: SpriteAttestation): boolean {
  const actualKeys = Object.keys(actual.symbolDigests).sort();
  const expectedKeys = Object.keys(expected.symbolDigests).sort();
  return actual.fileDigest === expected.fileDigest
    && actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual.symbolDigests[key] === expected.symbolDigests[key]);
}

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }

export function attestFirstServiceSprite(source: string, requirements: readonly SpriteRequirement[]): SpriteAttestation {
  if (!source.startsWith("<svg ") || !source.endsWith("</svg>\n") || /<(?:script|foreignObject|image)\b|href=["'](?:https?:|\/)/u.test(source)) {
    throw new Error("Invalid first-service sprite document.");
  }
  const expected = new Map(requirements.map((item) => [item.key, item.dimensions]));
  if (expected.size !== requirements.length) throw new Error("Duplicate first-service sprite requirement.");
  const observed = new Map<string, string>();
  const symbols = /<symbol id="([a-z0-9-]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/gu;
  for (const match of source.matchAll(symbols)) {
    const [, key, viewBox, body] = match;
    if (!key || !viewBox || body === undefined || observed.has(key)) throw new Error("Duplicate or malformed first-service sprite symbol.");
    const dimensions = expected.get(key);
    if (!dimensions) throw new Error(`Orphan first-service sprite symbol: ${key}`);
    const [width, height] = dimensions.split("x");
    if (viewBox !== `0 0 ${width} ${height}` || body.length === 0) throw new Error(`First-service sprite viewBox/body mismatch: ${key}`);
    observed.set(key, sha256(match[0]));
  }
  const missing = [...expected.keys()].filter((key) => !observed.has(key));
  if (missing.length > 0 || observed.size !== expected.size) throw new Error(`Missing first-service sprite symbols: ${missing.join(",")}`);
  return Object.freeze({ fileDigest: sha256(source), symbolDigests: Object.freeze(Object.fromEntries([...observed.entries()].sort())) });
}

export function verifyFirstServiceSpriteAttestation(
  source: string,
  requirements: readonly SpriteRequirement[],
  expected: SpriteAttestation,
): SpriteAttestation {
  const actual = attestFirstServiceSprite(source, requirements);
  if (!sameAttestation(actual, expected)) throw new Error("First-service sprite bytes do not match the pinned attestation.");
  return actual;
}
