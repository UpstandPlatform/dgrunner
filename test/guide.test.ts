import { describe, it, expect } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateVerificationWorkflowYaml, writeVerificationWorkflow } from "../src/core/guide.js";

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

  it("preserves permissions on an existing workflows directory", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-"));
    const workflowsDir = path.join(projectRoot, ".github", "workflows");
    try {
      await fsPromises.mkdir(workflowsDir, { recursive: true });
      await fsPromises.chmod(workflowsDir, 0o755);
      await writeVerificationWorkflow(projectRoot);
      const mode = (await fsPromises.stat(workflowsDir)).mode & 0o777;
      expect(mode).toBe(0o755);
    } finally {
      await fsPromises.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
