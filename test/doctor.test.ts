import { describe, it, expect } from "vitest";
import { runDoctorChecks } from "../src/core/doctor.js";

describe("Doctor Module", () => {
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
  });
});
