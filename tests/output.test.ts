import { describe, expect, it } from "bun:test";
import type { JsonSchema } from "effect";
import { OUTPUT_FORMAT, OUTPUT_FORMATS, type OutputFormat } from "../src/config";
import {
  describeOutputFormats,
  FORMAT_HANDLERS,
  resolveOutputStrategy,
} from "../src/output";

const schema: JsonSchema.JsonSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};

const output = { value: "x" };
const prettyOutput = JSON.stringify(output, null, 2);

const bothFormatProperty = (description: string) => ({
  format: {
    type: "string",
    enum: [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
    description,
  },
});

const BOTH_TEXT_DEFAULT = bothFormatProperty(
  "Response format. Defaults to text; use json for structured output.",
);
const BOTH_JSON_DEFAULT = bothFormatProperty(
  "Response format. Defaults to json; use json for structured output.",
);

interface StrategyCase {
  readonly name: string;
  readonly allowed: readonly OutputFormat[];
  readonly preferred?: OutputFormat;
  readonly formats: readonly OutputFormat[];
  readonly defaultFormat: OutputFormat;
  readonly includeOutput: boolean;
  readonly formatProperty: Record<string, unknown>;
  readonly schema: JsonSchema.JsonSchema | undefined;
  readonly toolDescription: string;
}

const STRATEGY_CASES: readonly StrategyCase[] = [
  {
    name: "text only",
    allowed: [OUTPUT_FORMAT.text],
    preferred: OUTPUT_FORMAT.text,
    formats: [OUTPUT_FORMAT.text],
    defaultFormat: OUTPUT_FORMAT.text,
    includeOutput: false,
    formatProperty: {},
    schema: undefined,
    toolDescription: "Text output is forced; the format input is not accepted.",
  },
  {
    name: "json only",
    allowed: [OUTPUT_FORMAT.json],
    preferred: OUTPUT_FORMAT.text,
    formats: [OUTPUT_FORMAT.json],
    defaultFormat: OUTPUT_FORMAT.json,
    includeOutput: true,
    formatProperty: {},
    schema,
    toolDescription: "JSON output is forced; the format input is not accepted.",
  },
  {
    name: "text and json with a text default",
    allowed: [OUTPUT_FORMAT.json, OUTPUT_FORMAT.text],
    preferred: OUTPUT_FORMAT.text,
    formats: [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
    defaultFormat: OUTPUT_FORMAT.text,
    includeOutput: true,
    formatProperty: BOTH_TEXT_DEFAULT,
    schema,
    toolDescription:
      "Set format:json to return the target's structured output as content.",
  },
  {
    name: "text and json with a json default",
    allowed: [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
    preferred: OUTPUT_FORMAT.json,
    formats: [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
    defaultFormat: OUTPUT_FORMAT.json,
    includeOutput: true,
    formatProperty: BOTH_JSON_DEFAULT,
    schema,
    toolDescription:
      "Set format:json to return the target's structured output as content.",
  },
];

describe("resolveOutputStrategy", () => {
  for (const testCase of STRATEGY_CASES) {
    it(`configures ${testCase.name}`, () => {
      const strategy = resolveOutputStrategy(testCase.allowed, testCase.preferred);

      expect(strategy.formats).toEqual(testCase.formats);
      expect(strategy.defaultFormat).toBe(testCase.defaultFormat);
      expect(strategy.includeOutput).toBe(testCase.includeOutput);
      expect(strategy.formatProperty()).toEqual(testCase.formatProperty);
      expect(strategy.schema(schema)).toBe(testCase.schema);
      expect(describeOutputFormats(strategy)).toBe(testCase.toolDescription);
    });

    it(`selects formats for ${testCase.name}`, () => {
      const strategy = resolveOutputStrategy(testCase.allowed, testCase.preferred);

      for (const format of OUTPUT_FORMATS) {
        const expected = testCase.formats.includes(format)
          ? format
          : testCase.defaultFormat;
        expect(strategy.selectFormat(format)).toBe(expected);
      }

      for (const requested of [
        undefined,
        null,
        "",
        "xml",
        "toString",
        "constructor",
        "__proto__",
        0,
        false,
        {},
        [],
      ]) {
        expect(strategy.selectFormat(requested)).toBe(testCase.defaultFormat);
      }
    });

    it(`responds for ${testCase.name}`, () => {
      const strategy = resolveOutputStrategy(testCase.allowed, testCase.preferred);

      if (testCase.formats.includes(OUTPUT_FORMAT.text)) {
        expect(strategy.respond("content", output, OUTPUT_FORMAT.text)).toBe("content");
      } else {
        expect(() => strategy.respond("content", output, OUTPUT_FORMAT.text)).toThrow(
          "Unsupported output format",
        );
      }

      if (testCase.formats.includes(OUTPUT_FORMAT.json)) {
        expect(strategy.respond("content", output, OUTPUT_FORMAT.json)).toBe(
          prettyOutput,
        );
      } else {
        expect(() => strategy.respond("content", output, OUTPUT_FORMAT.json)).toThrow(
          "Unsupported output format",
        );
      }

      for (const format of ["xml", "toString", "constructor", "__proto__"]) {
        expect(() => strategy.respond("content", output, format as OutputFormat)).toThrow(
          "Unsupported output format",
        );
      }
    });
  }

  it("normalizes format order, duplicates, and invalid entries", () => {
    const reordered = resolveOutputStrategy([OUTPUT_FORMAT.json, OUTPUT_FORMAT.text]);
    expect(reordered.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json]);

    const duplicate = resolveOutputStrategy([OUTPUT_FORMAT.json, OUTPUT_FORMAT.json]);
    expect(duplicate.formats).toEqual([OUTPUT_FORMAT.json]);

    const mixed = resolveOutputStrategy([
      OUTPUT_FORMAT.json,
      "xml" as OutputFormat,
      OUTPUT_FORMAT.text,
    ]);
    expect(mixed.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json]);
  });

  it("falls back to the default formats for empty or invalid input", () => {
    for (const value of [
      [],
      ["xml"],
      ["toString", "constructor", "__proto__"],
      "text",
      42,
      null,
    ]) {
      const strategy = resolveOutputStrategy(value as never);
      expect(strategy.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json]);
      expect(strategy.defaultFormat).toBe(OUTPUT_FORMAT.text);
      expect(strategy.includeOutput).toBe(true);
    }
  });

  it("ignores a preferred format that is not allowed", () => {
    const text = resolveOutputStrategy([OUTPUT_FORMAT.text], OUTPUT_FORMAT.json);
    expect(text.defaultFormat).toBe(OUTPUT_FORMAT.text);
    expect(text.selectFormat(OUTPUT_FORMAT.json)).toBe(OUTPUT_FORMAT.text);

    const json = resolveOutputStrategy([OUTPUT_FORMAT.json], OUTPUT_FORMAT.text);
    expect(json.defaultFormat).toBe(OUTPUT_FORMAT.json);
    expect(json.selectFormat(OUTPUT_FORMAT.text)).toBe(OUTPUT_FORMAT.json);
  });

  it("only exposes the format property when there is a choice", () => {
    for (const format of OUTPUT_FORMATS) {
      expect(resolveOutputStrategy([format]).formatProperty()).toEqual({});
    }
    expect(
      resolveOutputStrategy([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json]).formatProperty(),
    ).toEqual(BOTH_TEXT_DEFAULT);
  });

  it("combines schema contributions deterministically", () => {
    expect(resolveOutputStrategy([OUTPUT_FORMAT.text]).schema(schema)).toBeUndefined();
    expect(resolveOutputStrategy([OUTPUT_FORMAT.json]).schema(schema)).toBe(schema);
    expect(
      resolveOutputStrategy([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json]).schema(schema),
    ).toBe(schema);
  });
});

describe("format registry", () => {
  it("has a handler for every output format", () => {
    // The `satisfies Record<OutputFormat, FormatHandler>` in src/output.ts is the
    // compile-time guard; this runtime check catches a format added without a handler.
    expect(Object.keys(FORMAT_HANDLERS).toSorted()).toEqual(
      [...OUTPUT_FORMATS].toSorted(),
    );

    for (const format of OUTPUT_FORMATS) {
      const handler = FORMAT_HANDLERS[format];
      expect(handler).toBeDefined();
      expect(handler.label.length).toBeGreaterThan(0);
      expect(typeof handler.providesOutput).toBe("boolean");
      expect(handler.hint.length).toBeGreaterThan(0);
      expect(typeof handler.schema).toBe("function");
      expect(typeof handler.respond).toBe("function");
    }
  });

  it("records output capabilities and hints", () => {
    expect(FORMAT_HANDLERS[OUTPUT_FORMAT.text]).toMatchObject({
      providesOutput: false,
      hint: "text content",
    });
    expect(FORMAT_HANDLERS[OUTPUT_FORMAT.json]).toMatchObject({
      providesOutput: true,
      hint: "structured output",
    });
  });

  it("derives includeOutput from handler capabilities", () => {
    for (const format of OUTPUT_FORMATS) {
      expect(resolveOutputStrategy([format]).includeOutput).toBe(
        FORMAT_HANDLERS[format].providesOutput,
      );
    }
  });

  it("labels the registered formats", () => {
    expect(FORMAT_HANDLERS[OUTPUT_FORMAT.text].label).toBe("Text");
    expect(FORMAT_HANDLERS[OUTPUT_FORMAT.json].label).toBe("JSON");
  });
});
