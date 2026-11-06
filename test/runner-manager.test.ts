import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";
import { DEFAULT_CONTAINER_NAME } from "../src/core/docker-runner.js";
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
  listLocalRunnerMetadata,
  readMetadataForRunner,
  removeLocalMetadata,
  resolveRunnerDirectory,
  saveLocalMetadata,
  configureRunner,
  removeRunner,
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
      metadata({ mode: "docker", runnerDir: `docker:${DEFAULT_CONTAINER_NAME}`, containerName: DEFAULT_CONTAINER_NAME }),
      DEFAULT_RUNNER_DIR,
    )).toBe(true);
  });

  it("routes each Docker runner by its own container name", () => {
    const customDockerRunner = metadata({
      mode: "docker",
      runnerDir: "docker:dgrunner-gpu",
      containerName: "dgrunner-gpu",
    });
    expect(metadataMatchesRunner(customDockerRunner, "docker:dgrunner-gpu")).toBe(true);
    expect(metadataMatchesRunner(customDockerRunner, DEFAULT_RUNNER_DIR)).toBe(false);
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
      await expect(readMetadataForRunner(DEFAULT_RUNNER_DIR, baseDir)).resolves.toBeNull();
      await expect(readMetadataForRunner("docker:test-runner", baseDir)).resolves.toMatchObject({ mode: "docker" });
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("stores and resolves multiple Docker runner metadata records independently", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-metadata-registry-"));
    const buildRunner = metadata({
      mode: "docker",
      runnerDir: "docker:dgrunner-build",
      containerName: "dgrunner-build",
      name: "build-runner",
    });
    const gpuRunner = metadata({
      mode: "docker",
      runnerDir: "docker:dgrunner-gpu",
      containerName: "dgrunner-gpu",
      name: "gpu-runner",
    });

    try {
      await saveLocalMetadata(buildRunner, baseDir);
      await saveLocalMetadata(gpuRunner, baseDir);

      await expect(listLocalRunnerMetadata(baseDir)).resolves.toHaveLength(2);
      await expect(readMetadataForRunner("docker:dgrunner-build", baseDir)).resolves.toMatchObject({ name: "build-runner" });
      await expect(readMetadataForRunner("docker:dgrunner-gpu", baseDir)).resolves.toMatchObject({ name: "gpu-runner" });
      await expect(resolveRunnerDirectory("gpu-runner", DEFAULT_RUNNER_DIR, baseDir)).resolves.toMatchObject({
        runnerDir: "docker:dgrunner-gpu",
      });

      await removeLocalMetadata(buildRunner, baseDir);
      await expect(listLocalRunnerMetadata(baseDir)).resolves.toHaveLength(1);
      await expect(readMetadataForRunner("docker:dgrunner-gpu", baseDir)).resolves.toMatchObject({ name: "gpu-runner" });
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("keeps case-distinct native paths separate on case-sensitive filesystems", async () => {
    if (process.platform === "win32") return;
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-case-paths-"));
    const uppercaseDir = path.join(baseDir, "Runner");
    const lowercaseDir = path.join(baseDir, "runner");
    const uppercase = metadata({ runnerDir: uppercaseDir, name: "uppercase-runner" });
    const lowercase = metadata({ runnerDir: lowercaseDir, name: "lowercase-runner" });

    try {
      await saveLocalMetadata(uppercase, baseDir);
      await saveLocalMetadata(lowercase, baseDir);

      await expect(listLocalRunnerMetadata(baseDir)).resolves.toHaveLength(2);
      await expect(readMetadataForRunner(uppercaseDir, baseDir)).resolves.toMatchObject({ name: "uppercase-runner" });
      await expect(readMetadataForRunner(lowercaseDir, baseDir)).resolves.toMatchObject({ name: "lowercase-runner" });
      await expect(resolveRunnerDirectory(uppercaseDir, DEFAULT_RUNNER_DIR, baseDir)).resolves.toMatchObject({
        runnerDir: uppercaseDir,
      });
      await expect(resolveRunnerDirectory(lowercaseDir, DEFAULT_RUNNER_DIR, baseDir)).resolves.toMatchObject({
        runnerDir: lowercaseDir,
      });

      const metaFile = path.join(baseDir, "runners", (await fs.readdir(path.join(baseDir, "runners")))[0]!);
      expect((await fs.stat(metaFile)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("Runner token handling", () => {
  it("passes native registration tokens through the runner input environment", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-config-token-"));
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    execCommandMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "configuration rejected" });

    try {
      await configureRunner({
        runnerDir,
        url: "https://github.com/example/repo",
        token: "runner-registration-token-123456",
        name: "runner",
        labels: ["self-hosted", "linux"],
      });

      const [command, args, options] = execCommandMock.mock.calls.at(-1)!;
      expect(command).toBe("./config.sh");
      expect(args).not.toContain("runner-registration-token-123456");
      expect(args).not.toContain("--token");
      expect(options?.env).toMatchObject({ ACTIONS_RUNNER_INPUT_TOKEN: "runner-registration-token-123456" });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("passes native removal tokens through the runner input environment", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-remove-token-"));
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remove rejected" });

    try {
      await removeRunner(runnerDir, "runner-removal-token-123456");

      const [command, args, options] = execCommandMock.mock.calls.at(-1)!;
      expect(command).toBe("./config.sh");
      expect(args).toEqual(["remove"]);
      expect(options?.env).toMatchObject({ ACTIONS_RUNNER_INPUT_TOKEN: "runner-removal-token-123456" });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
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
        exitCode: 1,
        stdout: "",
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
      expect(execCommandMock.mock.calls[2]).toEqual([
        "docker",
        ["stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}", "abc123def456"],
        { timeoutMs: 5_000 },
      ]);
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("lists multiple independently named Docker runners", async () => {
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-multiple-docker-"));
    execCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "build12345678\tdgrunner-build\tUp 2 minutes",
          "gpu1234567890\tdgrunner-gpu\tUp 1 minute",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "build12345678\t71MiB / 8GiB",
          "gpu1234567890\t120MiB / 8GiB",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    try {
      const processes = await listRunnerProcesses(runnerDir);
      expect(processes).toHaveLength(2);
      expect(processes.map(({ name, memoryMb }) => ({ name, memoryMb }))).toEqual([
        { name: "dgrunner-build (docker)", memoryMb: 71 },
        { name: "dgrunner-gpu (docker)", memoryMb: 120 },
      ]);
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("includes Linux host process resident memory when procfs exposes it", async () => {
    if (process.platform !== "linux") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-memory-"));
    const expectedExecutable = path.join(runnerDir, "bin", "Runner.Listener");
    const originalReadlink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (target, ...args) => {
      const targetPath = String(target);
      if (targetPath === `/proc/${process.pid}/exe`) return expectedExecutable;
      if (targetPath === `/proc/${process.pid}/cwd`) return runnerDir;
      return originalReadlink(target as any, ...(args as any));
    });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: process.pid + " " + path.join(runnerDir, "bin", "Runner.Listener") + " run",
        stderr: "",
      });

    try {
      const processes = await listRunnerProcesses(runnerDir);
      expect(processes[0]?.pid).toBe(process.pid);
      expect(processes[0]?.memoryMb).toEqual(expect.any(Number));
    } finally {
      vi.restoreAllMocks();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });
});

describe("Foreground runner and live log handling", () => {
  it("gives a setup hint when asked to start an uninstalled runner", async () => {
    const runnerDir = path.join(os.tmpdir(), `dgrunner-missing-${Date.now()}-${Math.random()}`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runForeground(runnerDir)).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Run 'dgrunner setup' first"));
      expect(execCommandMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      execCommandMock.mockReset();
    }
  });

  it("does not write a Windows .path file for an unconfigured runner", async () => {
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-unconfigured-"));
    const configScript = process.platform === "win32" ? "config.cmd" : "config.sh";
    const runScript = process.platform === "win32" ? "run.cmd" : "run.sh";
    await fs.writeFile(path.join(runnerDir, configScript), "", "utf-8");
    await fs.writeFile(path.join(runnerDir, runScript), "", "utf-8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runForeground(runnerDir)).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("installed but not configured"));
      await expect(fs.access(path.join(runnerDir, ".path"))).rejects.toThrow();
      expect(execCommandMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("reports setup guidance from start when native runner files are missing", async () => {
    const runnerDir = path.join(os.tmpdir(), `dgrunner-start-missing-${Date.now()}-${Math.random()}`);
    execCommandMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not found" });

    try {
      await expect(startService(runnerDir)).resolves.toMatchObject({
        success: false,
        message: expect.stringContaining("Run 'dgrunner setup' first"),
      });
    } finally {
      execCommandMock.mockReset();
    }
  });

  it("reports a missing start script before starting a partially installed runner", async () => {
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-start-incomplete-"));
    const configScript = process.platform === "win32" ? "config.cmd" : "config.sh";
    const startScript = process.platform === "win32" ? "run.cmd" : "run.sh";
    await fs.writeFile(path.join(runnerDir, configScript), "", "utf-8");
    await fs.writeFile(path.join(runnerDir, ".runner"), "{}", "utf-8");
    execCommandMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not running" });

    try {
      await expect(startService(runnerDir)).resolves.toMatchObject({
        success: false,
        message: expect.stringContaining(`'${startScript}' is missing`),
      });
      await expect(fs.access(path.join(runnerDir, ".path"))).rejects.toThrow();
    } finally {
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("reports only the runner executable name when Linux pgrep returns a full path", async () => {
    if (process.platform === "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-name-"));
    const expectedExecutable = path.join(runnerDir, "bin", "Runner.Listener");
    const originalReadlink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (target, ...args) => {
      const targetPath = String(target);
      if (targetPath === "/proc/12345/exe") return expectedExecutable;
      if (targetPath === "/proc/12345/cwd") return runnerDir;
      return originalReadlink(target as any, ...(args as any));
    });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "12345 " + path.join(runnerDir, "bin", "Runner.Listener") + " run",
        stderr: "",
      });

    try {
      const processes = await listRunnerProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]?.name).toBe("Runner.Listener");
    } finally {
      vi.restoreAllMocks();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("does not report a Runner.Listener process outside the configured runner directory", async () => {
    if (process.platform !== "linux") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-scope-"));
    const managed = path.join(runnerDir, "bin", "Runner.Listener");
    const originalReadlink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (target, ...args) => {
      const targetPath = String(target);
      if (targetPath === "/proc/321/exe") return managed;
      if (targetPath === "/proc/321/cwd") return runnerDir;
      if (targetPath === "/proc/654/exe") return "/opt/unrelated/bin/Runner.Listener";
      if (targetPath === "/proc/654/cwd") return "/opt/unrelated";
      return originalReadlink(target as any, ...(args as any));
    });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "docker unavailable" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "321 " + managed + " run",
          "654 /opt/unrelated/bin/Runner.Listener run",
        ].join("\n"),
        stderr: "",
      });

    try {
      const processes = await listRunnerProcesses(runnerDir);
      expect(processes.map(({ pid }) => pid)).toEqual([321]);
    } finally {
      vi.restoreAllMocks();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("does not stop another process just because its arguments mention Runner.Listener", async () => {
    if (process.platform !== "linux") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-process-spoof-"));
    const unrelatedExecutable = "/usr/bin/python3";
    const originalReadlink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (target, ...args) => {
      const targetPath = String(target);
      if (targetPath === "/proc/321/exe") return unrelatedExecutable;
      if (targetPath === "/proc/321/cwd") return runnerDir;
      return originalReadlink(target as any, ...(args as any));
    });
    execCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: `321 ${unrelatedExecutable} -c 'print("/opt/Runner.Listener")'`,
      stderr: "",
    });

    try {
      const status = await getRunnerStatus(runnerDir);
      expect(status.serviceRunning).toBe(false);
    } finally {
      vi.restoreAllMocks();
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("verifies the executable path before reporting a macOS Runner.Listener process", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-macos-process-"));
    const expectedExecutable = path.resolve(runnerDir, "bin", "Runner.Listener");
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "321\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: `p321\nftxt\nn${expectedExecutable}\n`, stderr: "" });

    try {
      const status = await getRunnerStatus(runnerDir);
      expect(status.serviceRunning).toBe(true);
      expect(execCommandMock.mock.calls.map((call) => call[0])).toEqual(["pgrep", "lsof"]);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("does not report a macOS process when lsof identifies a different executable", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-macos-spoof-"));
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "456\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "p456\nftxt\nn/usr/bin/python3\n", stderr: "" });

    try {
      const status = await getRunnerStatus(runnerDir);
      expect(status.serviceRunning).toBe(false);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      execCommandMock.mockReset();
      await fs.rm(runnerDir, { recursive: true, force: true });
    }
  });

  it("refuses to attach a second process when the managed service is already running", async () => {
    if (process.platform === "win32") return;
    const runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-active-"));
    await fs.writeFile(path.join(runnerDir, "svc.sh"), "");
    await fs.writeFile(path.join(runnerDir, ".service"), "actions.runner.example.service\n");
    await fs.writeFile(path.join(runnerDir, "config.sh"), "");
    await fs.writeFile(path.join(runnerDir, "run.sh"), "");
    await fs.writeFile(path.join(runnerDir, ".runner"), "{}");
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: runnerDir, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "active", stderr: "" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runForeground(runnerDir)).resolves.toBe(1);
      expect(execCommandMock).toHaveBeenCalledTimes(3);
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
      await tailRunnerLogs({ runnerDir: "docker:test-runner", baseDir, follow: true, lines: 17 });
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
