import { describe, it, expect } from "vitest";
import { generateVerificationWorkflowYaml } from "../src/core/guide.js";

describe("Guide & Workflow Generator", () => {
  it("should generate valid workflow YAML with default self-hosted labels", () => {
    const yaml = generateVerificationWorkflowYaml();
    expect(yaml).toContain("name: Verify dgrunner Self-Hosted Runner");
    expect(yaml).toContain('runs-on: ["self-hosted","dgrunner"]');
    expect(yaml).toContain("verify-docker:");
    expect(yaml).toContain("verify-security:");
  });

  it("should incorporate custom runner labels in the runs-on field", () => {
    const yaml = generateVerificationWorkflowYaml({
      labels: ["self-hosted", "my-pc", "gpu"],
    });
    expect(yaml).toContain('runs-on: ["self-hosted","my-pc","gpu"]');
  });

  it("should include Docker verification container steps", () => {
    const yaml = generateVerificationWorkflowYaml();
    expect(yaml).toContain("docker run --rm alpine:latest");
  });
});
