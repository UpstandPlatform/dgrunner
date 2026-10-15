import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
  minify: false,
});
