import { describe, expect, it } from "bun:test";
import { validateSchema } from "./schema";

describe("validateSchema", () => {
  it("reports missing required properties", () => {
    expect(
      validateSchema(
        {},
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      ),
    ).toEqual(["$.name: missing required property"]);
  });

  it("reports wrong types", () => {
    expect(validateSchema(42, { type: "string" })).toEqual([
      "$: expected string, got integer",
    ]);
    expect(validateSchema("42", { type: "number" })).toEqual([
      "$: expected number, got string",
    ]);
  });

  it("rejects extra properties when additionalProperties is false", () => {
    expect(
      validateSchema(
        { name: "x", extra: true },
        {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      ),
    ).toEqual(["$.extra: unexpected property"]);
  });

  it("accepts anyOf when one branch matches", () => {
    const schema = {
      anyOf: [{ type: "number" }, { type: "string", minLength: 2 }],
    };

    expect(validateSchema(7, schema)).toEqual([]);
    expect(validateSchema("ab", schema)).toEqual([]);
    expect(validateSchema("a", schema)).toEqual(["$: no anyOf branch matched"]);
  });

  it("returns after anyOf without evaluating sibling constraints", () => {
    const matching = {
      anyOf: [{ type: "string" }],
      type: "number",
      minLength: 100,
    };
    expect(validateSchema("ok", matching)).toEqual([]);

    const failing = {
      anyOf: [{ type: "number" }],
      type: "string",
    };
    expect(validateSchema("ok", failing)).toEqual(["$: no anyOf branch matched"]);
  });

  it("validates array items", () => {
    const schema = { type: "array", items: { type: "number" } };

    expect(validateSchema([1, 2], schema)).toEqual([]);
    expect(validateSchema([1, "2"], schema)).toEqual([
      "$[1]: expected number, got string",
    ]);
  });

  it("validates enum and minLength", () => {
    expect(validateSchema("a", { enum: ["a", "b"] })).toEqual([]);
    expect(validateSchema("c", { enum: ["a", "b"] })).toEqual([
      '$: "c" is not in the enum',
    ]);
    expect(validateSchema("ab", { type: "string", minLength: 2 })).toEqual([]);
    expect(validateSchema("a", { type: "string", minLength: 2 })).toEqual([
      "$: expected at least 2 characters",
    ]);
  });

  it("ignores unsupported keywords", () => {
    expect(validateSchema("anything", { const: "expected" })).toEqual([]);
    expect(validateSchema("b", { pattern: "^a" })).toEqual([]);
    expect(validateSchema([1], { minItems: 2 })).toEqual([]);
    expect(validateSchema("x", { oneOf: [{ type: "number" }] })).toEqual([]);
    expect(validateSchema("anything", { allOf: [{ type: "number" }] })).toEqual([]);
    expect(validateSchema("anything", { $ref: "#/definitions/missing" })).toEqual([]);
  });
});
