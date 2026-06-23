import { db } from "./db/client.js";
import { agentPrompts, templates } from "./db/schema.js";
import { SEED_PROMPTS, SEED_TEMPLATES } from "./seed-data.js";

/**
 * Insert the default templates + agent prompts if absent. Idempotent (ON CONFLICT DO
 * NOTHING on the unique slug/key), so a user's dashboard edits are never clobbered on
 * redeploy. Runs on boot after migrations.
 */
export async function seedDefaults(): Promise<void> {
  await db
    .insert(templates)
    .values(
      SEED_TEMPLATES.map((t) => ({
        slug: t.slug,
        name: t.name,
        kind: t.kind,
        description: t.description,
        content: t.content,
        isActive: t.isActive,
      })),
    )
    .onConflictDoNothing({ target: templates.slug });

  await db
    .insert(agentPrompts)
    .values(
      SEED_PROMPTS.map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description,
        content: p.content,
        editable: p.editable,
      })),
    )
    .onConflictDoNothing({ target: agentPrompts.key });

  console.log(
    `[seed] ensured ${SEED_TEMPLATES.length} template(s) + ${SEED_PROMPTS.length} prompt(s)`,
  );
}
