import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";
const { execCommandMock } = vi.hoisted(() => ({ execCommandMock: vi.fn() }));
vi.mock("../src/utils/exec.js", () => ({
  execCommand: execCommandMock,
  execInteractive: vi.fn(),
}));
import {
  metadataMatchesRunner,
  runForeground,
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
    execCommandMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "active (running)",
      stderr: "",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runForeground(runnerDir)).resolves.toBe(1);
      expect(execCommandMock).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    } finally {
      errorSpy.mockRestore();
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
