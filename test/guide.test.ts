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
    expect(yaml).toContain("permissions:\n  contents: read");
    expect(yaml).toContain("actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8");
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

  it("does not overwrite an existing workflow unless overwrite is explicit", async () => {
    const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-existing-"));
    const workflowPath = path.join(projectRoot, ".github", "workflows", "verify-runner.yml");
    try {
      await fsPromises.mkdir(path.dirname(workflowPath), { recursive: true });
      await fsPromises.writeFile(workflowPath, "user-owned workflow\n", "utf-8");

      await expect(writeVerificationWorkflow(projectRoot)).rejects.toThrow(/already exists|EEXIST/i);
      await expect(fsPromises.readFile(workflowPath, "utf-8")).resolves.toBe("user-owned workflow\n");

      await writeVerificationWorkflow(projectRoot, {}, true);
      await expect(fsPromises.readFile(workflowPath, "utf-8")).resolves.toContain("Verify dgrunner Self-Hosted Runner");
    } finally {
      await fsPromises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("replaces a hard-linked workflow atomically without modifying its other link", async () => {
    const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-hardlink-"));
    const workflowsDir = path.join(projectRoot, ".github", "workflows");
    const workflowPath = path.join(workflowsDir, "verify-runner.yml");
    const otherLink = path.join(projectRoot, "user-file.txt");
    try {
      await fsPromises.mkdir(workflowsDir, { recursive: true });
      await fsPromises.writeFile(otherLink, "user-owned content\n", "utf-8");
      await fsPromises.link(otherLink, workflowPath);

      await writeVerificationWorkflow(projectRoot, {}, true);

      await expect(fsPromises.readFile(otherLink, "utf-8")).resolves.toBe("user-owned content\n");
      await expect(fsPromises.readFile(workflowPath, "utf-8")).resolves.toContain("Verify dgrunner Self-Hosted Runner");
    } finally {
      await fsPromises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("refuses to write workflow files through a directory symlink outside the project", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-link-project-"));
    const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-link-outside-"));
    try {
      await fsPromises.mkdir(path.join(projectRoot, ".github"), { recursive: true });
      await fsPromises.symlink(outsideRoot, path.join(projectRoot, ".github", "workflows"), "dir");

      await expect(writeVerificationWorkflow(projectRoot)).rejects.toThrow(/outside the project root/i);
      await expect(fsPromises.readdir(outsideRoot)).resolves.toEqual([]);
    } finally {
      await fsPromises.rm(projectRoot, { recursive: true, force: true });
      await fsPromises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("does not create directories outside the project through a .github symlink", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-parent-link-"));
    const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-guide-parent-outside-"));
    try {
      await fsPromises.symlink(outsideRoot, path.join(projectRoot, ".github"), "dir");

      await expect(writeVerificationWorkflow(projectRoot)).rejects.toThrow(/outside the project root/i);
      await expect(fsPromises.readdir(outsideRoot)).resolves.toEqual([]);
    } finally {
      await fsPromises.rm(projectRoot, { recursive: true, force: true });
      await fsPromises.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
