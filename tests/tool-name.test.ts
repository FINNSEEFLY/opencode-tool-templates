import { describe, expect, it } from "bun:test";
import { resolveConfig } from "../src/config";
import {
  MAX_TOOL_NAME_LENGTH,
  TOOL_NAME_PATTERN,
  effectiveToolName,
  isEffectiveToolName,
  normalizeToolName,
} from "../src/tool-name";

const NORMALIZE_CASES = [
  { value: "bad name", expected: "bad_name" },
  { value: "ok-name_1", expected: "ok-name_1" },
  { value: "company.templates", expected: "company_templates" },
  { value: "a/b:c", expected: "a_b_c" },
  { value: "", expected: "" },
] as const;

const EFFECTIVE_NAME_CASES = [
  { namespace: "template", name: "call", expected: "template_call" },
  {
    namespace: "company.templates",
    name: "call",
    expected: "company_templates_call",
  },
  { namespace: undefined, name: "read", expected: "read" },
  { namespace: "custom", name: "bad name", expected: "custom_bad_name" },
  {
    namespace: "company.templates",
    name: "bad.name",
    expected: "company_templates_bad_name",
  },
  { namespace: undefined, name: "bad.name", expected: "bad_name" },
] as const;

const VALID_NAME_CASES = [
  { label: "a single character", value: "a" },
  { label: "hyphens and underscores", value: "tool-name_1" },
  { label: "maximum length", value: "A".repeat(MAX_TOOL_NAME_LENGTH) },
] as const;

const INVALID_NAME_CASES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "an empty string", value: "" },
  { label: "whitespace", value: "   " },
  { label: "a dot", value: "bad.name" },
  { label: "a space", value: "bad name" },
  { label: "a slash", value: "bad/name" },
  { label: "an overlong name", value: "a".repeat(MAX_TOOL_NAME_LENGTH + 1) },
  { label: "a number", value: 42 },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "an object", value: {} },
  { label: "an array", value: [] },
  { label: "a boolean", value: true },
];

describe("normalizeToolName", () => {
  for (const { value, expected } of NORMALIZE_CASES) {
    it(`normalizes ${JSON.stringify(value)} to ${JSON.stringify(expected)}`, () => {
      expect(normalizeToolName(value)).toBe(expected);
    });
  }
});

describe("effectiveToolName", () => {
  for (const { namespace, name, expected } of EFFECTIVE_NAME_CASES) {
    it(`builds ${expected}`, () => {
      expect(effectiveToolName(namespace, name)).toBe(expected);
    });
  }
});

describe("isEffectiveToolName", () => {
  for (const { label, value } of VALID_NAME_CASES) {
    it(`accepts ${label}`, () => {
      expect(isEffectiveToolName(value)).toBe(true);
    });
  }

  for (const { label, value } of INVALID_NAME_CASES) {
    it(`rejects ${label}`, () => {
      expect(isEffectiveToolName(value)).toBe(false);
    });
  }
});

describe("TOOL_NAME_PATTERN", () => {
  it("matches the effective name grammar", () => {
    for (const value of ["a", "A0_-", "tool-name_1"]) {
      expect(TOOL_NAME_PATTERN.test(value)).toBe(true);
    }
    for (const value of ["", "bad name", "bad.name", "bad/name"]) {
      expect(TOOL_NAME_PATTERN.test(value)).toBe(false);
    }
  });
});

describe("shared tool name rules", () => {
  it("accepts valid names at the length boundary in config", () => {
    const name = "a".repeat(MAX_TOOL_NAME_LENGTH);
    expect(resolveConfig({ allowedTools: [name] }).allowedTools).toEqual([name]);
    expect(() =>
      resolveConfig({ allowedTools: ["a".repeat(MAX_TOOL_NAME_LENGTH + 1)] }),
    ).toThrow(/at most 128 characters/);
  });
});
