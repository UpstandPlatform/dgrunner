import { defineConfig } from "tsup";
import fs from "node:fs";
import path from "node:path";

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
  splitting: false,
  minify: false,
  onSuccess: async () => {
    // Ensure strict LF line endings on dist/index.js so Linux/POSIX systems don't fail with '/usr/bin/env: node\r'
    const outPath = path.resolve("dist/index.js");
    if (fs.existsSync(outPath)) {
      const content = fs.readFileSync(outPath, "utf-8");
      const normalized = content.replace(/\r\n/g, "\n");
      fs.writeFileSync(outPath, normalized, "utf-8");
      try {
        fs.chmodSync(outPath, 0o755);
      } catch {
        // Ignored on platforms without POSIX permissions
      }
    }
  },
});
