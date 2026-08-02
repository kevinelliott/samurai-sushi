const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

export class StrictJsonError extends Error {
  constructor() {
    super("The JSON request is invalid.");
    this.name = "StrictJsonError";
  }
}

export class BodyTooLargeError extends StrictJsonError {
  constructor() {
    super();
    this.name = "BodyTooLargeError";
  }
}

export function parseStrictJson(text: string): unknown {
  let offset = 0;
  let nodes = 0;
  const MAX_DEPTH = 32;
  const MAX_NODES = 4_096;
  const MAX_STRING_CODE_UNITS = 16_384;
  const MAX_CONTAINER_ENTRIES = 256;
  const invalid = (): never => { throw new StrictJsonError(); };
  const whitespace = (): void => {
    while (offset < text.length) {
      const character = text[offset];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") break;
      offset += 1;
    }
  };
  const string = (): string => {
    if (text[offset] !== '"') invalid();
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        const parsed = (() => {
          try { return JSON.parse(text.slice(start, offset)) as string; } catch { return invalid(); }
        })();
        if (parsed.length > MAX_STRING_CODE_UNITS) invalid();
        for (let index = 0; index < parsed.length; index += 1) {
          const code = parsed.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = parsed.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
            index += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
        }
        return parsed;
      }
      if (character === "\\") {
        const escaped = text[offset++];
        if (!escaped || !/["\\/bfnrtu]/.test(escaped)) invalid();
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset, offset + 4))) invalid();
          offset += 4;
        }
      } else if (!character || character.charCodeAt(0) <= 0x1f) invalid();
    }
    return invalid();
  };
  const value = (depth = 0): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "{") {
      offset += 1;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === "}") { offset += 1; return result; }
      while (offset < text.length) {
        whitespace();
        const key = string();
        if (keys.size >= MAX_CONTAINER_ENTRIES) invalid();
        if (keys.has(key) || key === "__proto__" || key === "constructor" || key === "prototype") invalid();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") invalid();
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") invalid();
      }
      invalid();
    }
    if (character === "[") {
      offset += 1;
      const result: unknown[] = [];
      whitespace();
      if (text[offset] === "]") { offset += 1; return result; }
      while (offset < text.length) {
        if (result.length >= MAX_CONTAINER_ENTRIES) invalid();
        result.push(value(depth + 1));
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") invalid();
      }
      invalid();
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return parsed; }
    }
    NUMBER_PATTERN.lastIndex = offset;
    const match = NUMBER_PATTERN.exec(text);
    if (!match) return invalid();
    offset = NUMBER_PATTERN.lastIndex;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) invalid();
    return parsed;
  };
  if (text.length === 0 || text.charCodeAt(0) === 0xfeff) invalid();
  const parsed = value();
  whitespace();
  if (offset !== text.length) invalid();
  return parsed;
}

export function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new StrictJsonError();
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    throw new StrictJsonError();
  }
  return record;
}

export function plainObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new StrictJsonError();
  }
  return value as Readonly<Record<string, unknown>>;
}
