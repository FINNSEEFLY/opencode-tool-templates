import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import {
  formatRenderError,
  HELPER_NAMES,
  HELPER_SPECS,
  renderTemplate,
} from "../src/render";

const EXPECTED_HELPER_NAMES = [
  "if",
  "unless",
  "each",
  "with",
  "lookup",
  "json",
  "join",
  "eq",
  "ne",
  "and",
  "or",
  "not",
] as const;

const BUILTIN_HELPER_NAMES = ["if", "unless", "each", "with", "lookup"] as const;

const CUSTOM_HELPER_NAMES = ["json", "join", "eq", "ne", "and", "or", "not"] as const;

const CUSTOM_HELPER_CASES: Record<
  string,
  { source: string; params: Record<string, unknown>; expected: string }
> = {
  json: {
    source: "{{json value}}",
    params: { value: { a: 1 } },
    expected: '{\n  "a": 1\n}',
  },
  join: { source: '{{join items ","}}', params: { items: ["a", "b"] }, expected: "a,b" },
  eq: {
    source: "{{#if (eq a b)}}yes{{else}}no{{/if}}",
    params: { a: 1, b: 1 },
    expected: "yes",
  },
  ne: {
    source: "{{#if (ne a b)}}yes{{else}}no{{/if}}",
    params: { a: 1, b: 2 },
    expected: "yes",
  },
  and: {
    source: "{{#if (and a b)}}yes{{else}}no{{/if}}",
    params: { a: true, b: true },
    expected: "yes",
  },
  or: {
    source: "{{#if (or a b)}}yes{{else}}no{{/if}}",
    params: { a: false, b: true },
    expected: "yes",
  },
  not: {
    source: "{{#if (not a)}}yes{{else}}no{{/if}}",
    params: { a: false },
    expected: "yes",
  },
};

describe("helper registry", () => {
  it("keeps the helper set unchanged", () => {
    expect(HELPER_NAMES).toEqual([...EXPECTED_HELPER_NAMES]);
    expect(Object.keys(HELPER_SPECS)).toEqual([...EXPECTED_HELPER_NAMES, "log"]);
  });

  it("registers every custom helper from its spec", () => {
    const custom = Object.entries(HELPER_SPECS).filter(
      ([, spec]) => spec.kind === "custom",
    );
    expect(custom.map(([name]) => name)).toEqual([...CUSTOM_HELPER_NAMES]);
    for (const [name] of custom) {
      const testCase = CUSTOM_HELPER_CASES[name];
      if (!testCase) throw new Error(`Missing render case for ${name}`);
      expect(renderTemplate(testCase.source, testCase.params, '"<inline>"')).toBe(
        testCase.expected,
      );
    }
  });

  it("marks every helper kind and custom arity", () => {
    for (const name of BUILTIN_HELPER_NAMES) {
      expect(HELPER_SPECS[name].kind).toBe("builtin");
    }
    for (const name of CUSTOM_HELPER_NAMES) {
      const spec = HELPER_SPECS[name];
      expect(spec.kind).toBe("custom");
      if (spec.kind !== "custom") throw new Error(`${name} must be custom`);
      expect(typeof spec.run).toBe("function");
      expect(spec.min).toBeGreaterThanOrEqual(1);
      expect(spec.max === undefined || spec.max >= spec.min).toBe(true);
    }
    expect(HELPER_SPECS.log.kind).toBe("disabled");
  });

  it("excludes disabled helpers from the allowed list", () => {
    for (const [name, spec] of Object.entries(HELPER_SPECS)) {
      expect(HELPER_NAMES.includes(name)).toBe(spec.kind !== "disabled");
    }
  });
});

const captureToolError = (run: () => unknown): ToolError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("Expected a ToolError");
};

const expectToolError = (run: () => unknown, pattern: RegExp) => {
  expect(captureToolError(run).message).toMatch(pattern);
};

const FORBIDDEN_INTERNALS = /\[object Object\]|knownHelpersOnly|could not be found/;
const RAW_LOCATION = / - \d+:\d+/;

const expectCleanDiagnostic = (message: string) => {
  expect(message).not.toMatch(FORBIDDEN_INTERNALS);
  expect(message).not.toMatch(RAW_LOCATION);
  expect(message).not.toContain("line undefined");
};

describe("renderTemplate", () => {
  it("renders flat and CAPS variables", () => {
    expect(
      renderTemplate(
        "Hello {{TASK_ID}} / {{taskId}}",
        { TASK_ID: "T-1", taskId: "t-2" },
        '"<inline>"',
      ),
    ).toBe("Hello T-1 / t-2");
  });

  it("renders the $params namespace", () => {
    expect(renderTemplate("{{$params.TASK_ID}}", { TASK_ID: "T-1" }, '"<inline>"')).toBe(
      "T-1",
    );
  });

  it("does not escape text", () => {
    expect(renderTemplate("{{value}}", { value: '<tag> & "quote"' }, '"<inline>"')).toBe(
      '<tag> & "quote"',
    );
  });

  it("renders the built-in and custom helpers", () => {
    expect(renderTemplate("{{json value}}", { value: { a: 1 } }, '"<inline>"')).toBe(
      '{\n  "a": 1\n}',
    );
    expect(
      renderTemplate('{{join items ", "}}', { items: ["a", "b"] }, '"<inline>"'),
    ).toBe("a, b");
    expect(
      renderTemplate(
        "{{#if (eq a b)}}yes{{else}}no{{/if}}",
        { a: 1, b: 1 },
        '"<inline>"',
      ),
    ).toBe("yes");
    expect(
      renderTemplate(
        "{{#if (and a b)}}yes{{else}}no{{/if}}",
        { a: true, b: true },
        '"<inline>"',
      ),
    ).toBe("yes");
    expect(
      renderTemplate(
        "{{#if (or a b)}}yes{{else}}no{{/if}}",
        { a: false, b: true },
        '"<inline>"',
      ),
    ).toBe("yes");
    expect(
      renderTemplate("{{#if (not a)}}yes{{else}}no{{/if}}", { a: false }, '"<inline>"'),
    ).toBe("yes");
  });

  it("rejects join on a non-array", () => {
    expectToolError(
      () => renderTemplate('{{join nonArray ", "}}', { nonArray: "abc" }, '"<inline>"'),
      /^Template "<inline>" failed: join expects an array$/,
    );
  });

  it("renders an undefined json value as null", () => {
    expect(renderTemplate("{{json value}}", { value: undefined }, '"<inline>"')).toBe(
      "null",
    );
    expect(renderTemplate("{{json missing}}", {}, '"<inline>"')).toBe("null");
  });

  it("uses #each and #with fallbacks for missing values", () => {
    expect(
      renderTemplate("{{#each missing}}X{{else}}EMPTY{{/each}}", {}, '"<inline>"'),
    ).toBe("EMPTY");
    expect(
      renderTemplate("{{#with missing}}X{{else}}EMPTY{{/with}}", {}, '"<inline>"'),
    ).toBe("EMPTY");
  });

  it("shadows every helper name but keeps it available through $params", () => {
    for (const name of HELPER_NAMES) {
      expectToolError(
        () => renderTemplate(`{{${name}}}`, { [name]: "PARAM" }, '"<inline>"'),
        /^Template "<inline>" failed:/,
      );
      expect(
        renderTemplate(`{{$params.${name}}}`, { [name]: "PARAM" }, '"<inline>"'),
      ).toBe("PARAM");
    }
  });

  it("supports #if with a missing variable", () => {
    expect(renderTemplate("{{#if missing}}yes{{else}}no{{/if}}", {}, '"<inline>"')).toBe(
      "no",
    );
  });

  it("rejects a missing direct variable and suggests $params", () => {
    expectToolError(
      () => renderTemplate("Hello {{name}}", {}, '"<inline>"'),
      /"name" is not defined \(line 1\)[\s\S]*\$params\.name/,
    );
  });

  it("rejects an unknown helper", () => {
    expectToolError(
      () => renderTemplate("{{unknown 1}}", {}, '"<inline>"'),
      /Allowed helpers:/,
    );
  });

  it("suggests the $params namespace for helper collisions", () => {
    expectToolError(
      () => renderTemplate("{{if}}", { if: "value" }, '"<inline>"'),
      /\$params\.if/,
    );
    expectToolError(
      () => renderTemplate("{{json}}", { json: "value" }, '"<inline>"'),
      /\$params\.json/,
    );
    expectToolError(
      () => renderTemplate("{{eq a}}", { eq: "value", a: 1 }, '"<inline>"'),
      /\$params\.eq/,
    );
    expectToolError(
      () => renderTemplate("{{not}}", { not: "value" }, '"<inline>"'),
      /\$params\.not/,
    );
  });

  it("rejects extra arguments to bundled helpers", () => {
    expectToolError(
      () => renderTemplate("{{json a b}}", { a: 1, b: 2 }, '"<inline>"'),
      /json expects 1 argument/,
    );
    expectToolError(
      () => renderTemplate("{{join a b c}}", { a: [1], b: ",", c: "x" }, '"<inline>"'),
      /join expects 1-2 arguments/,
    );
    expectToolError(
      () => renderTemplate("{{eq a b c}}", { a: 1, b: 1, c: 1 }, '"<inline>"'),
      /eq expects 2 arguments/,
    );
    expectToolError(
      () => renderTemplate("{{ne a b c}}", { a: 1, b: 2, c: 3 }, '"<inline>"'),
      /ne expects 2 arguments/,
    );
    expectToolError(
      () => renderTemplate("{{not a b}}", { a: true, b: false }, '"<inline>"'),
      /not expects 1 argument/,
    );
    expectToolError(
      () => renderTemplate("{{#if (and a)}}yes{{/if}}", { a: true }, '"<inline>"'),
      /and expects at least 2 arguments/,
    );
  });

  it("rejects named arguments to bundled helpers", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["{{json a b=1}}", { a: { x: 1 } }],
      ['{{join items sep=";"}}', { items: ["a", "b"] }],
      ["{{eq a b extra=1}}", { a: 1, b: 1 }],
      ["{{ne a b extra=1}}", { a: 1, b: 2 }],
      ["{{and a b extra=1}}", { a: true, b: true }],
      ["{{or a b extra=1}}", { a: false, b: true }],
      ["{{not a b=1}}", { a: true }],
    ];
    for (const [source, params] of cases) {
      expectToolError(
        () => renderTemplate(source, params, '"<inline>"'),
        /does not accept named arguments/,
      );
    }
    expectToolError(
      () => renderTemplate('{{join items sep=";"}}', { items: ["a"] }, '"<inline>"'),
      /join does not accept named arguments: sep/,
    );
  });

  it("accepts bundled helpers without named arguments", () => {
    expect(
      renderTemplate('{{join items ";"}}', { items: ["a", "b"] }, '"<inline>"'),
    ).toBe("a;b");
    expect(renderTemplate("{{json value}}", { value: { a: 1 } }, '"<inline>"')).toBe(
      '{\n  "a": 1\n}',
    );
  });

  it("does not treat the word not in a missing-variable error as a collision", () => {
    try {
      renderTemplate("{{missing}}", { not: "value" }, '"<inline>"');
    } catch (error) {
      expect((error as Error).message).not.toContain("$params.not");
      return;
    }
    throw new Error("Expected a ToolError");
  });

  it("rejects the removed log helper cleanly", () => {
    expectToolError(
      () => renderTemplate('{{log "x"}}', {}, '"<inline>"'),
      /Unknown helper "log" \(line 1\)[\s\S]*Allowed helpers:/,
    );
  });

  it("rejects partials", () => {
    expectToolError(
      () => renderTemplate("{{> missing}}", {}, '"<inline>"'),
      /Partials are not supported/,
    );
  });

  it("does not add a partial hint for a missing variable named partials", () => {
    try {
      renderTemplate("{{partials}}", {}, '"<inline>"');
    } catch (error) {
      expect((error as Error).message).toMatch(/"partials" is not defined/);
      expect((error as Error).message).not.toContain("Partials are not supported");
      return;
    }
    throw new Error("Expected a ToolError");
  });

  it("blocks prototype access and prototype-named variables", () => {
    expectToolError(
      () => renderTemplate("{{constructor.name}}", {}, '"<inline>"'),
      /not defined|No default value|Cannot read|undefined/,
    );
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expectToolError(
        () => renderTemplate(`{{${name}}}`, {}, '"<inline>"'),
        /not defined|No default value/,
      );
    }
    expectToolError(
      () => renderTemplate("{{$params.toString}}", {}, '"<inline>"'),
      /not defined|No default value/,
    );
    expectToolError(
      () => renderTemplate("{{this.toString}}", {}, '"<inline>"'),
      /not defined|No default value/,
    );
  });

  it("supports the remaining standard helpers", () => {
    expect(
      renderTemplate(
        "{{#each items}}{{this}}{{/each}}",
        { items: ["a", "b"] },
        '"<inline>"',
      ),
    ).toBe("ab");
    expect(
      renderTemplate("{{#with obj}}{{x}}{{/with}}", { obj: { x: "X" } }, '"<inline>"'),
    ).toBe("X");
    expect(
      renderTemplate("{{#unless flag}}no{{/unless}}", { flag: false }, '"<inline>"'),
    ).toBe("no");
    expect(renderTemplate('{{lookup obj "x"}}', { obj: { x: "X" } }, '"<inline>"')).toBe(
      "X",
    );
    expect(
      renderTemplate("{{#if (ne a b)}}different{{/if}}", { a: 1, b: 2 }, '"<inline>"'),
    ).toBe("different");
  });
});

describe("render diagnostics", () => {
  it("normalizes a missing inline variable and names the line", () => {
    const error = captureToolError(() =>
      renderTemplate("Hello\n{{name}}", {}, '"<inline>"'),
    );

    expect(error.message).toBe(
      'Template "<inline>" failed: "name" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.name}} if the name collides with a helper.',
    );
    expectCleanDiagnostic(error.message);
  });

  it("normalizes an unknown helper and lists every allowed helper", () => {
    const error = captureToolError(() => renderTemplate("{{bogus 1}}", {}, '"<inline>"'));

    expect(error.message).toBe(
      `Template "<inline>" failed: Unknown helper "bogus" (line 1). Allowed helpers: ${HELPER_NAMES.join(", ")}.`,
    );
    expectCleanDiagnostic(error.message);
  });

  it("normalizes a missing partial", () => {
    const error = captureToolError(() =>
      renderTemplate("{{> missing}}", {}, '"<inline>"'),
    );

    expect(error.message).toBe('Template "<inline>" failed: Partials are not supported.');
    expectCleanDiagnostic(error.message);
  });

  it("normalizes partial arguments and keeps the line", () => {
    const error = captureToolError(() =>
      renderTemplate("{{> missing 1 2}}", {}, '"<inline>"'),
    );

    expect(error.message).toBe(
      'Template "<inline>" failed: Partials are not supported (line 1).',
    );
    expectCleanDiagnostic(error.message);
  });

  it("keeps helper arity errors free of a line when Handlebars omits it", () => {
    const error = captureToolError(() =>
      renderTemplate("{{json a b}}", { a: 1, b: 2 }, '"<inline>"'),
    );

    expect(error.message).toBe('Template "<inline>" failed: json expects 1 argument');
    expectCleanDiagnostic(error.message);
  });

  it("keeps the helper collision hint", () => {
    const error = captureToolError(() =>
      renderTemplate("{{if}}", { if: "value" }, '"<inline>"'),
    );

    expect(error.message).toContain(
      'Template "<inline>" failed: #if requires exactly one argument',
    );
    expect(error.message).toContain(
      'A parameter named "if" collides with the Handlebars helper "if".',
    );
    expect(error.message).toContain("{{$params.if}}");
    expectCleanDiagnostic(error.message);
  });

  it("does not report a collision for a prefix-matching unknown helper", () => {
    const cases: Array<[string, string]> = [
      ["iffy", "if"],
      ["eachy", "each"],
      ["jsonify", "json"],
      ["notable", "not"],
    ];

    for (const [unknown, helper] of cases) {
      const error = captureToolError(() =>
        renderTemplate(`{{${unknown} 1}}`, { [helper]: "value" }, '"<inline>"'),
      );

      expect(error.message).toContain(`Unknown helper "${unknown}" (line 1).`);
      expect(error.message).not.toContain(
        `collides with the Handlebars helper "${helper}"`,
      );
      expect(error.message).not.toContain(`{{$params.${helper}}}`);
      expectCleanDiagnostic(error.message);
    }
  });

  it("keeps a known line number for fallback errors", () => {
    const error = captureToolError(() =>
      renderTemplate("{{foo/../bar}}", {}, '"<inline>"'),
    );

    expect(error.message).toBe(
      'Template "<inline>" failed: Invalid path: foo/.. (line 1)',
    );
    expectCleanDiagnostic(error.message);
  });

  it("sanitizes internal tokens in fallback errors", () => {
    const message = formatRenderError(
      {
        message: "Cannot render [object Object] with knownHelpersOnly - 1:2",
        lineNumber: 1,
      },
      {},
      '"<inline>"',
    );

    expect(message).toBe(
      'Template "<inline>" failed: Cannot render the template context with the helper allowlist (line 1)',
    );
    expect(message).not.toContain("[object Object]");
    expect(message).not.toContain("knownHelpersOnly");
  });

  it("normalizes prototype-access failures", () => {
    const error = captureToolError(() =>
      renderTemplate("{{constructor.name}}", {}, '"<inline>"'),
    );

    expect(error.message).toBe(
      'Template "<inline>" failed: "name" is not defined (line 1). If it is a parameter, pass it in $params; use {{$params.name}} if the name collides with a helper.',
    );
    expectCleanDiagnostic(error.message);
  });
});
