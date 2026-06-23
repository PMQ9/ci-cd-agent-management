import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { agentPrompts, templates } from "../src/db/schema.js";
import { SEED_PROMPTS, SEED_TEMPLATES } from "../src/seed-data.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));
installDbLifecycle(holder);

const { seedDefaults } = await import("../src/seed.js");

describe("seedDefaults", () => {
  it("inserts the default templates and prompts", async () => {
    await seedDefaults();
    const tpls = await holder.db.select().from(templates);
    const prompts = await holder.db.select().from(agentPrompts);
    expect(tpls).toHaveLength(SEED_TEMPLATES.length);
    expect(prompts).toHaveLength(SEED_PROMPTS.length);
    // exactly one active pr_review template (guarded by the partial unique index)
    expect(tpls.filter((t: any) => t.kind === "pr_review" && t.isActive)).toHaveLength(1);
  });

  it("is idempotent — running twice does not duplicate rows", async () => {
    await seedDefaults();
    await seedDefaults();
    const tpls = await holder.db.select().from(templates);
    const prompts = await holder.db.select().from(agentPrompts);
    expect(tpls).toHaveLength(SEED_TEMPLATES.length);
    expect(prompts).toHaveLength(SEED_PROMPTS.length);
  });

  it("does NOT clobber a dashboard-edited row (ON CONFLICT DO NOTHING on slug/key)", async () => {
    // Pre-insert a template with a seed slug but edited content + an edited prompt.
    const seedSlug = SEED_TEMPLATES[0]!.slug;
    const seedKey = SEED_PROMPTS[0]!.key;
    await holder.db.insert(templates).values({
      slug: seedSlug,
      name: "Edited name",
      kind: SEED_TEMPLATES[0]!.kind,
      description: "",
      content: "EDITED CONTENT",
      isActive: false,
    });
    await holder.db.insert(agentPrompts).values({
      key: seedKey,
      label: "Edited",
      description: "",
      content: "EDITED PROMPT",
      editable: true,
    });

    await seedDefaults();

    const [tpl] = await holder.db.select().from(templates).where(eq(templates.slug, seedSlug));
    const [prompt] = await holder.db.select().from(agentPrompts).where(eq(agentPrompts.key, seedKey));
    expect(tpl.content).toBe("EDITED CONTENT");
    expect(prompt.content).toBe("EDITED PROMPT");
  });
});
