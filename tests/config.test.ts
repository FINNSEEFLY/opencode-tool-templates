import { describe, expect, it } from "bun:test";
import { CONFIG_KEYS, LIMIT_KEYS, LIMIT_SPECS, resolveConfig } from "../src/config";

const configError = (raw: unknown): string => {
  try {
    resolveConfig(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected resolveConfig to throw");
};

const knownKeyList = (message: string, marker: string): string[] => {
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Missing ${marker}`);
  return message
    .slice(markerIndex + marker.length)
    .trim()
    .replace(/\.$/, "")
    .split(", ");
};

describe("resolveConfig", () => {
  it("uses defaults", () => {
    const config = resolveConfig({});
    expect(config.namespace).toBe("template");
    expect(config.templatePaths).toEqual(["**/*"]);
    expect(config.buildPaths).toEqual(["**/*"]);
    expect(config.allowHardLinkedTemplates).toBe(false);
    expect(config.allowedTools).toEqual([]);
    expect(config.deniedTools).toEqual([]);
    expect(config.defaultSeparator).toBe("\n\n");
    expect(config.defaultSkipEmpty).toBe(true);
    expect(config.allowedOutputFormats).toEqual(["text", "json"]);
    expect(config.registerSkill).toBe(true);
    expect(config.limits.maxTemplateBytes).toBe(1_048_576);
    expect(config.limits.maxRenderedBytes).toBe(2_097_152);
    expect(config.limits.maxChainParts).toBe(100);
  });

  it("clips the namespace and falls back for blank values", () => {
    expect(resolveConfig({ namespace: "  custom  " }).namespace).toBe("custom");
    expect(resolveConfig({ namespace: "   " }).namespace).toBe("template");
    expect(resolveConfig({ namespace: 42 }).namespace).toBe("template");
    expect(resolveConfig({ namespace: "x".repeat(100) }).namespace).toHaveLength(64);
  });

  it("trims namespace text clipped at the boundary", () => {
    expect(resolveConfig({ namespace: "a".repeat(63) + " b" }).namespace).toBe(
      "a".repeat(63),
    );
  });

  it("trims a path pattern clipped at the boundary", () => {
    const pattern = "x".repeat(1023) + " y";
    expect(resolveConfig({ templatePaths: [pattern] }).templatePaths).toEqual([
      "x".repeat(1023),
    ]);
  });

  it("normalizes template paths and removes duplicates", () => {
    const config = resolveConfig({
      templatePaths: [" **/* ", "templates/**/*", "", 42, "**/*"],
    });
    expect(config.templatePaths).toEqual(["**/*", "templates/**/*"]);
  });

  it("keeps explicitly empty path lists", () => {
    expect(resolveConfig({ templatePaths: [] }).templatePaths).toEqual([]);
    expect(resolveConfig({ buildPaths: [] }).buildPaths).toEqual([]);
  });

  it("fails closed for non-array path lists", () => {
    expect(() => resolveConfig({ templatePaths: "**/*" })).toThrow(
      /templatePaths must be an array/,
    );
    expect(() => resolveConfig({ buildPaths: "**/*" })).toThrow(
      /buildPaths must be an array/,
    );
  });

  it("normalizes allowed and denied tools", () => {
    const config = resolveConfig({
      allowedTools: [" subagent ", "subagent", "read"],
      deniedTools: ["shell"],
    });
    expect(config.allowedTools).toEqual(["subagent", "read"]);
    expect(config.deniedTools).toEqual(["shell"]);
  });

  it("fails closed for non-array tool allowlists", () => {
    expect(() => resolveConfig({ allowedTools: "subagent" })).toThrow(
      /allowedTools must be an array/,
    );
    expect(() => resolveConfig({ deniedTools: "shell" })).toThrow(
      /deniedTools must be an array/,
    );
  });

  it("fails closed for invalid tool allowlist entries", () => {
    const invalid = [
      [""],
      ["   "],
      [42],
      ["subagent", 42],
      ["*"],
      ["bad name"],
      ["bad.name"],
      ["x".repeat(129)],
      Array.from({ length: 201 }, (_, index) => `tool${index}`),
    ];
    for (const value of invalid) {
      expect(() => resolveConfig({ allowedTools: value })).toThrow(/allowedTools/);
      expect(() => resolveConfig({ deniedTools: value })).toThrow(/deniedTools/);
    }
  });

  it("rejects an invalid namespace", () => {
    expect(() => resolveConfig({ namespace: "bad name" })).toThrow(/namespace/);
    expect(resolveConfig({ namespace: "company.templates" }).namespace).toBe(
      "company.templates",
    );
  });

  it("accepts valid namespace segments", () => {
    for (const namespace of ["company.templates", "tool-name_1", "A0_-"]) {
      expect(resolveConfig({ namespace }).namespace).toBe(namespace);
    }
  });

  it("rejects invalid namespace segments", () => {
    for (const namespace of ["bad name", "bad/name", "a..b", ".a", "a.", ".."]) {
      expect(() => resolveConfig({ namespace })).toThrow(/namespace/);
    }
  });

  it("allows an empty separator and falls back for a non-string", () => {
    expect(resolveConfig({ defaultSeparator: "" }).defaultSeparator).toBe("");
    expect(resolveConfig({ defaultSeparator: 42 }).defaultSeparator).toBe("\n\n");
    expect(
      resolveConfig({ defaultSeparator: "x".repeat(2000) }).defaultSeparator,
    ).toHaveLength(1024);
  });

  it("honors defaultSkipEmpty false", () => {
    expect(resolveConfig({ defaultSkipEmpty: false }).defaultSkipEmpty).toBe(false);
    expect(resolveConfig({ defaultSkipEmpty: true }).defaultSkipEmpty).toBe(true);
    expect(resolveConfig({ defaultSkipEmpty: "false" }).defaultSkipEmpty).toBe(true);
  });

  it("normalizes allowed output formats", () => {
    expect(
      resolveConfig({ allowedOutputFormats: ["json"] }).allowedOutputFormats,
    ).toEqual(["json"]);
    expect(
      resolveConfig({ allowedOutputFormats: ["text"] }).allowedOutputFormats,
    ).toEqual(["text"]);
    expect(
      resolveConfig({ allowedOutputFormats: ["json", "json", "bad"] })
        .allowedOutputFormats,
    ).toEqual(["json"]);
    expect(resolveConfig({ allowedOutputFormats: [] }).allowedOutputFormats).toEqual([
      "text",
      "json",
    ]);
  });

  it("falls back for malformed output format lists", () => {
    expect(resolveConfig({ allowedOutputFormats: "text" }).allowedOutputFormats).toEqual([
      "text",
      "json",
    ]);
    expect(resolveConfig({ allowedOutputFormats: ["bad"] }).allowedOutputFormats).toEqual(
      ["text", "json"],
    );
  });

  it("caps path pattern count and length", () => {
    const patterns = Array.from({ length: 70 }, (_, index) => `p${index}/**/*`);
    expect(resolveConfig({ templatePaths: patterns }).templatePaths).toHaveLength(64);
    expect(
      resolveConfig({ templatePaths: ["x".repeat(2000)] }).templatePaths[0],
    ).toHaveLength(1024);
  });

  it("honors registerSkill false", () => {
    expect(resolveConfig({ registerSkill: false }).registerSkill).toBe(false);
    expect(resolveConfig({ registerSkill: true }).registerSkill).toBe(true);
  });

  it("only allows hard-linked templates for true", () => {
    expect(resolveConfig({}).allowHardLinkedTemplates).toBe(false);
    expect(
      resolveConfig({ allowHardLinkedTemplates: true }).allowHardLinkedTemplates,
    ).toBe(true);
    for (const value of ["true", 1, null]) {
      expect(
        resolveConfig({ allowHardLinkedTemplates: value }).allowHardLinkedTemplates,
      ).toBe(false);
    }
  });

  it("registers allowHardLinkedTemplates as a known option", () => {
    expect(CONFIG_KEYS.has("allowHardLinkedTemplates")).toBe(true);
  });

  it("clamps limits and falls back for invalid values", () => {
    const clamped = resolveConfig({
      limits: {
        maxTemplateBytes: 1,
        maxRenderedBytes: 999_999_999,
        maxChainParts: 0,
      },
    });
    expect(clamped.limits.maxTemplateBytes).toBe(1024);
    expect(clamped.limits.maxRenderedBytes).toBe(20_971_520);
    expect(clamped.limits.maxChainParts).toBe(1);

    const fallback = resolveConfig({
      limits: { maxTemplateBytes: "x", maxRenderedBytes: Number.NaN },
    });
    expect(fallback.limits.maxTemplateBytes).toBe(1_048_576);
    expect(fallback.limits.maxRenderedBytes).toBe(2_097_152);
  });

  it("accepts every known option", () => {
    const config = resolveConfig({
      namespace: "custom",
      templatePaths: ["templates/**/*"],
      buildPaths: ["build/**/*"],
      allowHardLinkedTemplates: true,
      allowedTools: ["read"],
      deniedTools: ["shell"],
      defaultSeparator: "|",
      defaultSkipEmpty: false,
      allowedOutputFormats: ["json"],
      registerSkill: false,
      limits: {
        maxTemplateBytes: 2048,
        maxRenderedBytes: 4096,
        maxChainParts: 10,
      },
    });
    expect(config).toEqual({
      namespace: "custom",
      templatePaths: ["templates/**/*"],
      buildPaths: ["build/**/*"],
      allowHardLinkedTemplates: true,
      allowedTools: ["read"],
      deniedTools: ["shell"],
      defaultSeparator: "|",
      defaultSkipEmpty: false,
      allowedOutputFormats: ["json"],
      registerSkill: false,
      limits: {
        maxTemplateBytes: 2048,
        maxRenderedBytes: 4096,
        maxChainParts: 10,
      },
    });
  });

  it("rejects unknown top-level options", () => {
    const unknownKeys = [
      "templatePath",
      "allowedTool",
      "buildPath",
      "deniedTool",
      "defaultSeparatorr",
      "unknownOption",
    ];
    for (const key of unknownKeys) {
      expect(() => resolveConfig({ [key]: [] })).toThrow(
        new RegExp(`Unknown plugin option "${key}"`),
      );
    }
  });

  it("suggests close options and lists every known option", () => {
    const message = configError({ allowedTool: [] });
    expect(message).toContain('Unknown plugin option "allowedTool"');
    expect(message).toContain('Did you mean "allowedTools"?');
    expect(knownKeyList(message, "Known options:").toSorted()).toEqual(
      [...CONFIG_KEYS].toSorted(),
    );
    expect(configError({ templatePath: [] })).toContain('Did you mean "templatePaths"?');
    expect(configError({ unknownOption: true })).not.toContain("Did you mean");
  });

  it("suggests known keys at edit distance 2", () => {
    const cases = [
      { raw: { allowedTol: [] }, suggestion: "allowedTools" },
      { raw: { limits: { maxRenderedByt: 1024 } }, suggestion: "maxRenderedBytes" },
    ];
    for (const { raw, suggestion } of cases) {
      expect(configError(raw)).toContain(`Did you mean "${suggestion}"?`);
    }
  });

  it("does not suggest known keys at edit distance 3", () => {
    expect(configError({ allowedTo: [] })).not.toContain("Did you mean");
    expect(configError({ limits: { maxRenderedBy: 1024 } })).not.toContain(
      "Did you mean",
    );
  });

  it("reports empty and odd unknown keys", () => {
    const keys = ["", "\u0000", "😀", "x".repeat(256)];
    for (const key of keys) {
      expect(configError({ [key]: [] })).toContain("Unknown plugin option");
      expect(configError({ limits: { [key]: 1 } })).toContain("Unknown limits option");
    }
  });

  it("rejects unknown limits options and lists every known limit", () => {
    const message = configError({ limits: { maxRenderedByte: 1024 } });
    expect(message).toContain('Unknown limits option "maxRenderedByte"');
    expect(message).toContain('Did you mean "maxRenderedBytes"?');
    expect(knownKeyList(message, "Known limits:").toSorted()).toEqual(
      [...LIMIT_KEYS].toSorted(),
    );
  });

  it("rejects non-object options", () => {
    for (const raw of [[], "options", 42, true]) {
      expect(() => resolveConfig(raw)).toThrow(/Plugin options must be an object/);
    }
  });

  it("rejects non-object limits", () => {
    for (const limits of [[], "limits", 42, true, () => undefined, null]) {
      expect(() => resolveConfig({ limits })).toThrow(/limits must be an object/);
    }
  });

  it("treats undefined and null options as defaults", () => {
    const defaults = resolveConfig({});
    expect(resolveConfig(undefined)).toEqual(defaults);
    expect(resolveConfig(null)).toEqual(defaults);
  });

  it("treats undefined limits as defaults", () => {
    expect(resolveConfig({ limits: undefined }).limits).toEqual(resolveConfig({}).limits);
  });

  it("ignores inherited properties", () => {
    const raw = Object.create({
      templatePaths: [],
      unknownOption: true,
      defaultSkipEmpty: false,
      registerSkill: false,
    });
    raw.limits = Object.create({ maxTemplateBytes: 1024, maxRenderedByte: 1 });
    const config = resolveConfig(raw);
    expect(config.templatePaths).toEqual(["**/*"]);
    expect(config.defaultSkipEmpty).toBe(true);
    expect(config.registerSkill).toBe(true);
    expect(config.limits.maxTemplateBytes).toBe(1_048_576);
  });
});

describe("limit specs", () => {
  it("keeps the test matrix in sync with every limit key", () => {
    expect(Object.keys(LIMIT_SPECS)).toEqual([...LIMIT_KEYS]);
  });

  for (const key of LIMIT_KEYS) {
    const spec = LIMIT_SPECS[key];

    it(`resolves ${key} across defaults, bounds, and invalid values`, () => {
      const resolve = (value: unknown) =>
        resolveConfig({ limits: { [key]: value } }).limits[key];

      expect(resolveConfig({}).limits[key]).toBe(spec.default);
      expect(resolve(undefined)).toBe(spec.default);
      expect(resolve(spec.min)).toBe(spec.min);
      expect(resolve(spec.max)).toBe(spec.max);
      expect(resolve(spec.min - 1)).toBe(spec.min);
      expect(resolve(spec.max + 1)).toBe(spec.max);

      const fraction = Math.floor((spec.min + spec.max) / 2) + 0.75;
      expect(resolve(fraction)).toBe(Math.floor(fraction));

      expect(resolve(-1)).toBe(spec.min);
      for (const invalid of [Infinity, -Infinity, Number.NaN]) {
        expect(resolve(invalid)).toBe(spec.default);
      }
    });
  }
});
