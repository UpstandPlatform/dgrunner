import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { execCommand, execInteractive } from "../src/utils/exec.js";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";

describe("Exec Utility", () => {
  it("should successfully execute npm without ENOENT", async () => {
    const res = await execCommand("npm", ["--version"], { timeoutMs: 15000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("executes Windows batch files with spaces in the path and arguments", async () => {
    if (process.platform !== "win32") return;
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner exec "));
    const script = path.join(tempDir, "script with spaces.cmd");
    try {
      await fsPromises.writeFile(script, "@echo off\r\necho %*\r\n", "utf8");
      const result = await execCommand(script, ["arg1", "argument with spaces"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"argument with spaces"');
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a timeout as failure when the child is terminated", async () => {
    const result = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 100,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Command timed out");
  });

  it("caps captured child output and marks truncation", async () => {
    const result = await execCommand(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stderr.write('y'.repeat(2 * 1024 * 1024));",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(1_050_000);
    expect(result.stderr.length).toBeLessThan(1_050_000);
    expect(result.stdout).toContain("[output truncated after 1048576 bytes]");
    expect(result.stderr).toContain("[output truncated after 1048576 bytes]");
  });

  it("treats a child closed by signal as failure", async () => {
    if (process.platform === "win32") return;
    const result = await execInteractive(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM');",
    ]);
    expect(result).not.toBe(0);
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

