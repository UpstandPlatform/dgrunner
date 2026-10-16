import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerDoctorCommand } from "../src/commands/doctor.js";
import { runDoctorChecks } from "../src/core/doctor.js";

describe("Doctor Module", () => {
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
    expect(platformCheck).toBeDefined();
    if (process.platform === "win32") {
      expect(platformCheck?.status).toBe("pass");
    }
  });
});

