import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { execCommand, resolveExecutable } from "../src/utils/exec.js";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";

describe("Exec Utility", () => {
  it("should resolve Windows command wrappers to cmd.exe /d /c on Windows", () => {
    const res = resolveExecutable("npm", ["install", "-g"]);
    if (process.platform === "win32") {
      expect(res.actualCmd.toLowerCase()).toContain("cmd.exe");
      expect(res.actualArgs).toEqual(["/d", "/c", "npm", "install", "-g"]);
    } else {
      expect(res.actualCmd).toBe("npm");
      expect(res.actualArgs).toEqual(["install", "-g"]);
    }
  });

  it("should successfully execute npm without ENOENT", async () => {
    const res = await execCommand("npm", ["--version"], { timeoutMs: 15000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("should successfully execute config.cmd on Windows when present", async () => {
    if (process.platform !== "win32") return;
    const configCmd = path.join(DEFAULT_RUNNER_DIR, "config.cmd");
    if (!fs.existsSync(configCmd)) {
      const result = await execCommand("cmd.exe", ["/c", "echo", "exec-test"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("exec-test");
      return;
    }
    const result = await execCommand(configCmd, ["--help"], {
      cwd: DEFAULT_RUNNER_DIR,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Configures the runner");
  });
});

