import { describe, expect, it } from "vitest";
import { parseStrictJson, StrictJsonError } from "./strict-json";

describe("strict JSON transport parser", () => {
  it("parses an exact object without prototype authority", () => {
    expect(parseStrictJson('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, "x"] });
  });

  it.each([
    '{"a":1,"a":2}',
    '{"__proto__":{}}',
    '{"a":1} trailing',
    '\ufeff{}',
    '{"a":"\\ud800"}',
    `{"a":${"[".repeat(33)}0${"]".repeat(33)}}`,
  ])("rejects ambiguous or unbounded JSON: %s", (input) => {
    expect(() => parseStrictJson(input)).toThrow(StrictJsonError);
  });
});
