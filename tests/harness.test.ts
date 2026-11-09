import { describe, expect, it } from "bun:test";
import { makeHarness } from "./harness";

describe("test harness lifecycle", () => {
  it("rejects a second setup and keeps the first registrations", async () => {
    const h = makeHarness();
    await h.setup();

    const toolIds = [...h.tools.keys()].toSorted();
    const skillIds = [...h.skills.keys()].map(String).toSorted();

    await expect(h.setup()).rejects.toThrow(/setup\(\) has already been called/);

    expect([...h.tools.keys()].toSorted()).toEqual(toolIds);
    expect([...h.skills.keys()].map(String).toSorted()).toEqual(skillIds);
  });

  it("disposes only skills added by the plugin transform", async () => {
    const h = makeHarness();
    const existing = {
      id: "existing",
      name: "Existing",
      description: "pre-existing skill",
      path: "",
      content: "",
    };
    h.skills.set("existing", existing);

    await h.setup();
    expect(h.skills.get("existing")).toBe(existing);
    expect(h.skills.has("tool-templates")).toBe(true);

    await h.dispose();

    expect(h.skills.get("existing")).toBe(existing);
    expect(h.skills.has("tool-templates")).toBe(false);
  });
});
