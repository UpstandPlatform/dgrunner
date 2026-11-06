import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerDoctorCommand } from "../src/commands/doctor.js";
import { isTargetEnvironmentCompatible, runDoctorChecks } from "../src/core/doctor.js";

describe("Doctor Module", () => {
  it("rejects runner targets that cannot be configured from the current host environment", () => {
    expect(isTargetEnvironmentCompatible("windows", "linux")).toBe(false);
    expect(isTargetEnvironmentCompatible("windows", "win32")).toBe(true);
    expect(isTargetEnvironmentCompatible("wsl", "linux", false)).toBe(false);
    expect(isTargetEnvironmentCompatible("wsl", "linux", true)).toBe(true);
    expect(isTargetEnvironmentCompatible("docker", "linux")).toBe(true);
    expect(isTargetEnvironmentCompatible("native", "darwin")).toBe(false);
  });

  it("exposes environment-specific checks through the CLI", () => {
    const program = new Command();
    registerDoctorCommand(program);
    const doctor = program.commands.find((command) => command.name() === "doctor");
    expect(doctor?.options.some((option) => option.long === "--env")).toBe(true);
  });

  it("should run all pre-flight checks and return structured report", async () => {
    const report = await runDoctorChecks();
    expect(report).toBeDefined();
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(4);

    const platformCheck = report.checks.find((c) => c.id === "platform");
    expect(platformCheck).toBeDefined();
    expect(["pass", "fail"]).toContain(platformCheck?.status);

    const gitCheck = report.checks.find((c) => c.id === "git");
    expect(gitCheck).toBeDefined();

    const dockerCheck = report.checks.find((c) => c.id === "docker");
    expect(dockerCheck).toBeDefined();
  }, 60000);

  it("should configure checks appropriately for targetEnv: docker", async () => {
    const report = await runDoctorChecks({ targetEnv: "docker" });
    const platformCheck = report.checks.find((c) => c.id === "platform");
    expect(platformCheck).toBeDefined();
    expect(platformCheck?.status).toBe("pass");
    expect(platformCheck?.message).toContain("running Docker Linux runner");
  });

  it("should configure checks appropriately for targetEnv: windows", async () => {
    const report = await runDoctorChecks({ targetEnv: "windows" });
    const platformCheck = report.checks.find((c) => c.id === "platform");
    const isolationCheck = report.checks.find((c) => c.id === "runner-isolation");
    expect(platformCheck).toBeDefined();
    expect(isolationCheck?.status).toBe("warn");
    expect(isolationCheck?.detail).toContain("does not currently isolate native jobs");
    if (process.platform === "win32") {
      expect(platformCheck?.status).toBe("pass");
    }
  });

  it("checks WSL prerequisites without adding the Windows Git Bash check", async () => {
    const report = await runDoctorChecks({ targetEnv: "wsl" });
    expect(report.checks.some((check) => check.id === "git-bash")).toBe(false);
    expect(report.checks.some((check) => check.id === "wsl-cli")).toBe(true);
    const isolationCheck = report.checks.find((check) => check.id === "runner-isolation");
    expect(isolationCheck?.status).toBe("warn");
    expect(isolationCheck?.detail).toContain("Default WSL automounts can expose Windows drives");
    if (process.platform === "win32") {
      expect(report.checks.some((check) => check.id === "wsl-distros")).toBe(true);
    }
  }, 60000);
});

