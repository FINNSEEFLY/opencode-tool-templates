import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  SKILL_DESCRIPTION,
  SKILL_ID,
  SKILL_NAME,
  parseSkillFile,
  registerSkill,
} from "../src/skill";
import { makeHarness } from "./harness";
import { tempDir, writeTemp } from "./temp";

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

describe("skill registration", () => {
  it("registers the bundled skill", async () => {
    const h = makeHarness();
    await h.setup();

    const skill = h.skills.get("tool-templates");
    expect(skill).toBeDefined();
    expect(skill.name).toBe("tool-templates");
    expect(skill.description).toContain("template_call");
    expect(skill.description).toContain("template_build");
    expect(skill.content).toContain("template_call");
    expect(skill.content).toContain("template_build");
    expect(skill.content).toContain("$params");
  });

  it("keeps the skill self-contained", async () => {
    const h = makeHarness();
    await h.setup();

    const skill = h.skills.get("tool-templates");
    expect(skill).toBeDefined();
    expect(skill.content).not.toContain("docs/");
    expect(skill.content).toContain("### Inputs");
    expect(skill.content).toContain("### Output");
  });

  it("can skip skill registration", async () => {
    const h = makeHarness({ options: { registerSkill: false } });
    await h.setup();

    expect(h.skills.size).toBe(0);
  });

  it("parses frontmatter and body", () => {
    const parsed = parseSkillFile(
      "---\nname: custom\ndescription: test skill\n---\nBody",
    );
    expect(parsed).toEqual({
      name: "custom",
      description: "test skill",
      content: "Body",
    });
  });

  it("handles CRLF and quoted frontmatter values", () => {
    const parsed = parseSkillFile(
      "---\r\nname: \"custom\"\r\ndescription: 'test skill'\r\n---\r\nBody",
    );
    expect(parsed).toEqual({
      name: "custom",
      description: "test skill",
      content: "Body",
    });
  });

  it("returns the whole file when frontmatter is absent", () => {
    expect(parseSkillFile("Body")).toEqual({ content: "Body" });
  });

  it("keeps colons inside description values", () => {
    const parsed = parseSkillFile(
      "---\nname: custom\ndescription: test: skill\n---\nBody",
    );
    expect(parsed).toEqual({
      name: "custom",
      description: "test: skill",
      content: "Body",
    });
  });

  it("treats unterminated frontmatter as content", () => {
    const text = "---\nname: custom\ndescription: test\nBody";
    expect(parseSkillFile(text)).toEqual({ content: text });
  });

  it("falls back for empty frontmatter values", async () => {
    const h = makeHarness();
    const path = await writeTemp(
      await tempDir(),
      "SKILL.md",
      "---\nname:\ndescription:   \n---\nBody",
    );

    const registration = await registerSkill(h.ctx.skill, path);
    expect(registration).toBeDefined();

    const skill = h.skills.get(SKILL_ID);
    expect(skill.name).toBe(SKILL_NAME);
    expect(skill.description).toBe(SKILL_DESCRIPTION);
    expect(skill.content).toBe("Body");
  });

  it("returns undefined and logs when skill.transform throws", async () => {
    const h = makeHarness();
    const errors = captureErrors();
    const transform = h.ctx.skill.transform;
    h.ctx.skill.transform = async () => {
      throw new Error("boom");
    };
    try {
      const registration = await registerSkill(h.ctx.skill);

      expect(registration).toBeUndefined();
      expect(errors.calls).toHaveLength(1);
      expect(String(errors.calls[0]?.[0])).toContain("failed to register SKILL.md");
      expect(errors.calls[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      h.ctx.skill.transform = transform;
      errors.restore();
    }
  });

  it("registers tools when skill registration fails during setup", async () => {
    const h = makeHarness();
    const errors = captureErrors();
    h.ctx.skill.transform = async () => {
      throw new Error("boom");
    };
    try {
      await h.setup();

      expect([...h.tools.values()].map((tool) => tool.name).toSorted()).toEqual([
        "build",
        "call",
      ]);
      expect(h.skills.size).toBe(0);
      expect(errors.calls).toHaveLength(1);
    } finally {
      errors.restore();
    }
  });

  it("disposes the registered skill", async () => {
    const h = makeHarness();
    const registration = await registerSkill(h.ctx.skill);
    if (!registration) throw new Error("Expected a skill registration");

    expect(h.skills.has(SKILL_ID)).toBe(true);
    await registration.dispose();
    expect(h.skills.has(SKILL_ID)).toBe(false);
  });

  it("distinguishes a read failure from a transform failure", async () => {
    const h = makeHarness();
    const errors = captureErrors();
    try {
      const result = await registerSkill(
        h.ctx.skill,
        join(await tempDir(), "missing.md"),
      );
      expect(result).toBeUndefined();
      expect(h.skills.size).toBe(0);
      expect(errors.calls).toHaveLength(1);
      expect(String(errors.calls[0]?.[0])).toContain("failed to read SKILL.md");
      expect(String(errors.calls[0]?.[0])).not.toContain("failed to register SKILL.md");
    } finally {
      errors.restore();
    }
  });
});
