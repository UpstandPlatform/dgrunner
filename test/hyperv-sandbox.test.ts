import { describe, expect, it } from "vitest";
import { validateHyperVSandboxOptions } from "../src/core/hyperv-sandbox.js";

const baseOptions = {
  url: "https://github.com/example/private-repo",
  name: "dgrunner-release",
  labels: ["self-hosted", "Linux", "X64", "release-docker"],
  templatePath: "C:\\sandbox\\ubuntu-runner.vhdx",
  switchName: "dgrunner-nat",
  sshUser: "runner",
  sshKeyPath: "C:\\Users\\runner\\.ssh\\dgrunner_vm",
  runnerDirectory: "/home/runner/actions-runner",
  memoryGiB: 8,
  processors: 4,
  generation: 2 as const,
};

describe("Hyper-V sandbox runner validation", () => {
  it("rejects non-Windows hosts before invoking host virtualization tools", () => {
    const result = validateHyperVSandboxOptions(baseOptions);
    if (process.platform !== "win32") {
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Windows hosts");
    } else {
      expect(result.valid).toBe(true);
    }
  });

  it.runIf(process.platform === "win32")("requires a repository URL and base self-hosted labels", () => {
    expect(validateHyperVSandboxOptions({ ...baseOptions, url: "https://github.com/example" }).error)
      .toContain("repository URL");
    expect(validateHyperVSandboxOptions({ ...baseOptions, labels: ["linux", "x64"] }).error)
      .toContain("self-hosted, linux, and x64");
  });

  it.runIf(process.platform === "win32")("rejects paths, guest accounts, and VM sizes outside the supported ranges", () => {
    expect(validateHyperVSandboxOptions({ ...baseOptions, templatePath: "relative.vhdx" }).error)
      .toContain("absolute path");
    expect(validateHyperVSandboxOptions({ ...baseOptions, sshUser: "runner; rm -rf /" }).error)
      .toContain("simple Linux account name");
    expect(validateHyperVSandboxOptions({ ...baseOptions, memoryGiB: 1 }).error)
      .toContain("between 2 and 128 GiB");
    expect(validateHyperVSandboxOptions({ ...baseOptions, processors: 0 }).error)
      .toContain("between 1 and 64");
  });

  it.runIf(process.platform === "win32")("accepts a valid per-job VM configuration and normalizes labels", () => {
    const result = validateHyperVSandboxOptions({
      ...baseOptions,
      url: "https://github.com/example/private-repo/",
      labels: ["self-hosted", " Linux ", "X64", "release-docker", "release-docker"],
    });
    expect(result.valid).toBe(true);
    expect(result.normalized?.url).toBe("https://github.com/example/private-repo");
    expect(result.normalized?.labels).toEqual(["self-hosted", "Linux", "X64", "release-docker"]);
  });
});
