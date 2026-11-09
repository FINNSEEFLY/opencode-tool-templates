import { describe, expect, it } from "bun:test";
import { resolveConfig } from "../src/config";
import { clipText } from "../src/text";

describe("clipText", () => {
  it("trims before clipping", () => {
    expect(clipText(" ".repeat(70) + "custom", 64)).toBe("custom");
    expect(resolveConfig({ namespace: " ".repeat(70) + "custom" }).namespace).toBe(
      "custom",
    );
  });

  it("clips after trimming so trailing content is kept", () => {
    expect(clipText("  custom  ", 5)).toBe("custo");
    expect(clipText("abc def", 4)).toBe("abc");
  });

  it("returns undefined for empty, blank, and non-string values", () => {
    expect(clipText("", 64)).toBeUndefined();
    expect(clipText("   ", 64)).toBeUndefined();
    expect(clipText(42, 64)).toBeUndefined();
  });

  it("still clips long values", () => {
    expect(clipText("x".repeat(100), 64)).toHaveLength(64);
  });
});
