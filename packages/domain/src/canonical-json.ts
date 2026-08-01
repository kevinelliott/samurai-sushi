import { PersistenceDomainError } from "./errors";
import type { JsonValue } from "./model";

function invalid(path: string, message: string): never {
  throw new PersistenceDomainError("INVALID_COMMAND_SHAPE", `${path} ${message}`);
}

export function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) invalid(path, "contains an unpaired high surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(path, "contains an unpaired low surrogate.");
    }
  }
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid(path, "must be a finite number other than negative zero.");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) invalid(path, "must not be an unsafe integer.");
    return value;
  }
  if (!value || typeof value !== "object") invalid(path, "is not canonical JSON.");
  if (ancestors.has(value)) invalid(path, "must not contain a cycle.");

  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) invalid(`${path}[${index}]`, "must not be an array hole.");
      result.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
    }
    ancestors.delete(value);
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "must contain only plain JSON objects.");

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) invalid(path, "must not contain symbol keys.");

  ancestors.add(value);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(descriptors).sort()) {
    assertValidUnicode(key, `${path} key`);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${path}.${key}`, "must be an enumerable data property.");
    }
    result[key] = canonicalize(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$", new Set()));
}
