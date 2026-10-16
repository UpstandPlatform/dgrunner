import { describe, it, expect } from "vitest";
import path from "node:path";
import { DEFAULT_RUNNER_DIR } from "../src/config/constants.js";
import { metadataMatchesRunner, type RunnerMetadata } from "../src/core/runner-manager.js";

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
