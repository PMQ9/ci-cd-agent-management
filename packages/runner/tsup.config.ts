import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  noExternal: [/^@agentpr\//],
  banner: { js: "#!/usr/bin/env node" },
});
