import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";
const { execCommandMock, execInteractiveMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  execInteractiveMock: vi.fn(),
}));
vi.mock("../src/utils/exec.js", () => ({
  execCommand: execCommandMock,
  execInteractive: execInteractiveMock,
}));
import {
  metadataMatchesRunner,
  readMetadataForRunner,
  runForeground,
  startService,
  stopService,
  getRunnerStatus,
  restartService,
  tailRunnerLogs,
  listRunnerProcesses,
  writeRunnerLogChunk,
  type RunnerMetadata,
} from "../src/core/runner-manager.js";

const metadata = (overrides: Partial<RunnerMetadata> = {}): RunnerMetadata => ({
  runnerDir: DEFAULT_RUNNER_DIR,
  url: "https://github.com/example/repo",
  name: "runner",
  labels: ["self-hosted"],
  scope: "repo",
  configuredAt: "2026-01-01T00:00:00.000Z",
  os: "linux",
  arch: "x64",
  ...overrides,
});

describe("Runner metadata routing", () => {
  it("does not apply Docker metadata to a different explicit runner directory", () => {
    expect(metadataMatchesRunner(
      metadata({ mode: "docker", runnerDir: "docker:upstand-dgrunner-linux" }),
      path.join(DEFAULT_RUNNER_DIR, "another-runner"),
    )).toBe(false);
  });

  it("applies Docker metadata to the default managed runner directory", () => {
    expect(metadataMatchesRunner(
      metadata({ mode: "docker", runnerDir: "docker:upstand-dgrunner-linux" }),
      DEFAULT_RUNNER_DIR,
    )).toBe(true);
  });

  it("applies native metadata only to the runner directory recorded during setup", () => {
    const runnerDir = path.join(DEFAULT_RUNNER_DIR, "custom");
    const localMetadata = metadata({ runnerDir });
    expect(metadataMatchesRunner(localMetadata, runnerDir)).toBe(true);
    expect(metadataMatchesRunner(localMetadata, DEFAULT_RUNNER_DIR)).toBe(false);
  });

  it("does not route global Docker metadata to a different requested directory", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-metadata-"));
    const customRunnerDir = path.join(baseDir, "missing-runner");
    await fs.writeFile(path.join(baseDir, "dgrunner-meta.json"), JSON.stringify(
      metadata({ mode: "docker", runnerDir: "docker:test-runner", containerName: "test-runner" })
    ));

    try {
      await expect(readMetadataForRunner(customRunnerDir, baseDir)).resolves.toBeNull();
      await expect(readMetadataForRunner(DEFAULT_RUNNER_DIR, baseDir)).resolves.toMatchObject({ mode: "docker" });
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("Runner process memory reporting", () => {
  it("includes Docker container memory from a non-streaming stats snapshot", async () => {
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-list-"));
    execCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "abc123def456\tupstand-dgrunner-linux\tUp 8 seconds",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "abc123def456\t57.2MiB / 7.7GiB",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    try {
      const processes = await listRunnerProcesses(runnerDir);
      expect(processes[0]).toMatchObject({
        pid: "abc123def456",
        memoryMb: 57,
        status: "Up 8 seconds",
      });
      expect(execCommandMock.mock.calls[1]).toEqual([
        "docker",
        ["stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}", "abc123def456"],
        { timeoutMs: 5_000 },
      ]);
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("includes Linux host process resident memory when procfs exposes it", async () => {
    if (process.platform !== "linux") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-memory-"));
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `${process.pid} Runner.Listener`,
        stderr: "",
      });

    try {
      const processes = await listRunnerProcesses(runnerDir);
      expect(processes[0]?.pid).toBe(process.pid);
      expect(processes[0]?.memoryMb).toEqual(expect.any(Number));
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });
});

describe("Foreground runner and live log handling", () => {
  it("reports only the runner executable name when Linux pgrep returns a full path", async () => {
    if (process.platform === "win32") return;
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "12345 /home/runner/actions runner/bin/Runner.Listener run",
        stderr: "",
      });

    try {
      const processes = await listRunnerProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]?.name).toBe("Runner.Listener");
    } finally {
      execCommandMock.mockReset();
    }
  });

  it("refuses to attach a second process when the managed service is already running", async () => {
    if (process.platform === "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-active-"));
    await fs.writeFile(path.join(runnerDir, "svc.sh"), "");
    await fs.writeFile(path.join(runnerDir, ".service"), "actions.runner.example.service\n");
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "active (running)", stderr: "" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runForeground(runnerDir)).resolves.toBe(1);
      expect(execCommandMock).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    } finally {
      errorSpy.mockRestore();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("detects a foreground Windows listener before starting another instance", async () => {
    if (process.platform !== "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-start-active-"));
    execCommandMock.mockResolvedValue({ exitCode: 0, stdout: "24680", stderr: "" });

    try {
      await expect(startService(runnerDir)).resolves.toMatchObject({
        success: true,
        message: "Runner is already running with PID 24680.",
      });
      expect(execCommandMock.mock.calls[0]?.[2]?.env).toMatchObject({
        DGRUNNER_EXECUTABLE: path.resolve(runnerDir, "bin", "Runner.Listener.exe"),
      });
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("stops a foreground Windows listener even when no PID file exists", async () => {
    if (process.platform !== "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-stop-active-"));
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "13579", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    try {
      await expect(stopService(runnerDir)).resolves.toMatchObject({ success: true, message: "Runner process stopped." });
      expect(execCommandMock.mock.calls[1]?.[0]).toBe("taskkill.exe");
      expect(execCommandMock.mock.calls[1]?.[1]).toEqual(["/pid", "13579", "/t", "/f"]);
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("reports an active foreground Windows listener in status using a relative directory", async () => {
    if (process.platform !== "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-status-active-"));
    const relativeRunnerDir = path.relative(process.cwd(), runnerDir);
    execCommandMock.mockResolvedValue({ exitCode: 0, stdout: "97531", stderr: "" });

    try {
      const status = await getRunnerStatus(relativeRunnerDir);
      expect(status.serviceRunning).toBe(true);
      expect(status.activePid).toBe(97531);
      expect(execCommandMock.mock.calls[0]?.[2]?.env).toMatchObject({
        DGRUNNER_EXECUTABLE: path.resolve(relativeRunnerDir, "bin", "Runner.Listener.exe"),
      });
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("does not restart if stopping a Windows runner fails", async () => {
    if (process.platform !== "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-restart-failure-"));
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "11223", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Access is denied." })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    try {
      const result = await restartService(runnerDir);
      expect(result).toMatchObject({ success: false, message: "Access is denied." });
      expect(execCommandMock).toHaveBeenCalledTimes(3);
      expect(execCommandMock.mock.calls.some(([cmd]) => cmd === "taskkill.exe")).toBe(true);
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("forwards Docker log line limits and follow mode", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-docker-logs-"));
    await fs.writeFile(path.join(baseDir, "dgrunner-meta.json"), JSON.stringify(
      metadata({ mode: "docker", runnerDir: "docker:test-runner", containerName: "test-runner" })
    ));
    execInteractiveMock.mockResolvedValue(0);

    try {
      await tailRunnerLogs({ runnerDir: DEFAULT_RUNNER_DIR, baseDir, follow: true, lines: 17 });
      expect(execInteractiveMock).toHaveBeenCalledWith(
        "docker",
        ["logs", "--tail", "17", "-f", "test-runner"]
      );
    } finally {
      execInteractiveMock.mockReset();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("detects Linux runner processes with pgrep when /proc executable access is denied", async () => {
    if (process.platform !== "linux") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-proc-fallback-"));
    const originalReadlink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (target, ...args) => {
      const targetPath = String(target);
      if (targetPath === "/proc/321/exe") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      if (targetPath === "/proc/321/cwd") return runnerDir;
      return originalReadlink(target as any, ...(args as any));
    });
    execCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "321 ./bin/Runner.Listener run",
      stderr: "",
    });

    try {
      const status = await getRunnerStatus(runnerDir);
      expect(status.serviceRunning).toBe(true);
      expect(status.activePid).toBe(321);
      expect(execCommandMock).toHaveBeenCalledWith("pgrep", ["-af", "Runner.Listener"]);
    } finally {
      vi.restoreAllMocks();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("prefixes each complete log line and decodes UTF-8 across byte chunks", () => {
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    const state = { decoder: new StringDecoder("utf8"), pendingText: "" };
    const bytes = Buffer.from("first\nsecond\nunicode: 😀\n");
    const emojiStart = bytes.indexOf(Buffer.from("😀"));

    try {
      writeRunnerLogChunk("stdout", bytes.subarray(0, emojiStart + 2), state);
      writeRunnerLogChunk("stdout", bytes.subarray(emojiStart + 2), state);
      expect(output.join("")).toBe("[stdout] first\n[stdout] second\n[stdout] unicode: 😀\n");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
