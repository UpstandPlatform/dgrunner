import { describe, it, expect } from "vitest";
import path from "node:path";
import { execCommand } from "../src/utils/exec.js";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";

describe("Exec Utility", () => {
  it("should successfully execute config.cmd on Windows when present", async () => {
    if (process.platform !== "win32") return;
    const configCmd = path.join(DEFAULT_RUNNER_DIR, "config.cmd");
    const result = await execCommand(configCmd, ["--help"], {
      cwd: DEFAULT_RUNNER_DIR,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Configures the runner");
  });
});
