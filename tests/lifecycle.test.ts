import { describe, expect, it } from "bun:test";
import { OPENCODE_REQUIREMENT } from "../src/errors";
import { SKILL_ID } from "../src/skill";
import { makeHarness } from "./harness";

const captureErrors = () => {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
};

describe("plugin lifecycle", () => {
  it("reports OPENCODE_REQUIREMENT when ctx.tool is missing", async () => {
    const h = makeHarness();
    h.ctx.tool = undefined;

    await expect(h.setup()).rejects.toThrow(OPENCODE_REQUIREMENT);
  });

  it("continues disposing tools when skill disposal rejects", async () => {
    const h = makeHarness();
    const original = h.ctx.skill.transform;
    h.ctx.skill.transform = async (callback: (editor: any) => void) => {
      await original(callback);
      return {
        dispose: async () => {
          throw new Error("skill dispose failed");
        },
      };
    };
    const errors = captureErrors();
    try {
      await h.setup();
      await h.dispose();

      expect(h.skills.has(SKILL_ID)).toBe(true);
      expect([...h.tools.values()].some((tool) => tool.name === "call")).toBe(false);
      expect(errors.calls).toHaveLength(1);
      expect(String(errors.calls[0]?.[0])).toContain(
        "failed to dispose skill registration",
      );
      expect(errors.calls[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      h.ctx.skill.transform = original;
      errors.restore();
    }
  });

  it("continues disposing skills when tool disposal rejects", async () => {
    const h = makeHarness();
    const original = h.ctx.tool.transform;
    h.ctx.tool.transform = async (callback: (editor: any) => void) => {
      await original(callback);
      return {
        dispose: async () => {
          throw new Error("tools dispose failed");
        },
      };
    };
    const errors = captureErrors();
    try {
      await h.setup();
      await h.dispose();

      expect(h.skills.has(SKILL_ID)).toBe(false);
      expect([...h.tools.values()].some((tool) => tool.name === "call")).toBe(true);
      expect(errors.calls).toHaveLength(1);
      expect(String(errors.calls[0]?.[0])).toContain(
        "failed to dispose tools registration",
      );
      expect(errors.calls[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      h.ctx.tool.transform = original;
      errors.restore();
    }
  });
});
