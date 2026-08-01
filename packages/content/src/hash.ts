import { createHash } from "node:crypto";
import type { ContentBundle, VersionedEntity } from "./model";

const HASH_DOMAIN = "samurai-sushi:content-row:v1\n";

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} must be a canonical safe integer.`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((nested, index) => canonicalize(nested, `${path}[${index}]`));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => path !== "$" || key !== "contentHash")
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, nested]) => {
          if (nested === undefined || typeof nested === "function" || typeof nested === "symbol" || typeof nested === "bigint") {
            throw new TypeError(`${path}.${key} is not canonical JSON.`);
          }
          return [key, canonicalize(nested, `${path}.${key}`)];
        }),
    );
  }
  throw new TypeError(`${path} is not canonical JSON.`);
}

export function canonicalContentJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

export function contentHashFor(value: unknown): string {
  return `sha256:${createHash("sha256").update(HASH_DOMAIN).update(canonicalContentJson(value)).digest("hex")}`;
}

type ContentCollections = Pick<
  ContentBundle,
  "species" | "ingredients" | "cutStyles" | "components" | "families" | "dishes" | "recipes" | "variants" | "seasonalityRules"
>;

export function contentManifestHashFor(bundle: ContentCollections): string {
  const groups: readonly [string, readonly VersionedEntity[]][] = [
    ["component", bundle.components],
    ["cut-style", bundle.cutStyles],
    ["dish", bundle.dishes],
    ["family", bundle.families],
    ["ingredient", bundle.ingredients],
    ["recipe", bundle.recipes],
    ["seasonality-rule", bundle.seasonalityRules],
    ["species", bundle.species],
    ["variant", bundle.variants],
  ];
  const manifest = groups.flatMap(([kind, rows]) => rows.map((row) => ({ kind, id: row.id, version: row.version, contentHash: row.contentHash })))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.id}@${left.version}`;
      const rightKey = `${right.kind}:${right.id}@${right.version}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return contentHashFor(manifest);
}

export const contentHashDomain = HASH_DOMAIN;
