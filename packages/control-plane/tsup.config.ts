import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/db/migrate-cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  // Bundle the workspace package (its exports point at TS source) into the output.
  noExternal: [/^@agentpr\//],
});
