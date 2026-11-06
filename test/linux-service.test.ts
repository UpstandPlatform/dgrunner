import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { execCommandMock } = vi.hoisted(() => ({ execCommandMock: vi.fn() }));
vi.mock("../src/utils/exec.js", () => ({
  execCommand: execCommandMock,
  execInteractive: vi.fn(),
}));

import {
  installLinuxRunnerService,
  readLinuxServiceUnit,
  startLinuxRunnerService,
  uninstallLinuxRunnerService,
} from "../src/core/linux-service.js";

describe("Linux service management", () => {
  let runnerDir: string;
  let platformDescriptor: PropertyDescriptor | undefined;
  let uidDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dgrunner-linux-service-"));
    platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  });

  afterEach(async () => {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor);
    else delete (process as NodeJS.Process & { getuid?: () => number }).getuid;
    await fs.rm(runnerDir, { recursive: true, force: true });
  });

  it("installs a fixed systemd unit without executing the runner's mutable service script as root", async () => {
    await fs.writeFile(path.join(runnerDir, "runsvc.sh"), "#!/bin/bash\n");
    execCommandMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await installLinuxRunnerService(runnerDir);

    expect(result.success).toBe(true);
    const teeCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "tee");
    expect(teeCall?.[0]).toBe("sudo");
    expect(String(teeCall?.[1]?.[2]).replace(/\\/g, "/")).toMatch(/^\/etc\/systemd\/system\/dgrunner-[a-f0-9]{20}\.service$/);
    expect(teeCall?.[2]?.input).toContain("User=1000");
    expect(teeCall?.[2]?.input).toContain("ExecStart=/bin/bash");
    expect(teeCall?.[2]?.input).toContain("runsvc.sh");
    expect(execCommandMock.mock.calls.some((call) => call[1]?.includes("./svc.sh"))).toBe(false);
    await expect(readLinuxServiceUnit(runnerDir)).resolves.toMatchObject({ installed: true });
  });

  it("starts a validated legacy runner unit through systemctl arguments", async () => {
    await fs.writeFile(path.join(runnerDir, ".service"), "actions.runner.example-repo.runner.service\n");
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: runnerDir, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await expect(startLinuxRunnerService(runnerDir)).resolves.toMatchObject({ success: true });
    expect(execCommandMock).toHaveBeenCalledWith(
      "sudo",
      ["systemctl", "start", "actions.runner.example-repo.runner.service"],
      expect.objectContaining({ timeoutMs: 120000 })
    );
  });

  it("rejects a malformed or option-like service marker without invoking systemctl", async () => {
    await fs.writeFile(path.join(runnerDir, ".service"), "--now\n");

    await expect(startLinuxRunnerService(runnerDir)).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("invalid systemd unit"),
    });
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it("disables and removes only the validated unit during uninstall", async () => {
    const suffix = crypto.createHash("sha256").update(path.resolve(runnerDir)).digest("hex").slice(0, 20);
    const unitName = "dgrunner-" + suffix + ".service";
    await fs.writeFile(path.join(runnerDir, ".dgrunner-service"), unitName + "\n");
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: runnerDir, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const result = await uninstallLinuxRunnerService(runnerDir);
    expect(result.success, result.message).toBe(true);
    expect(execCommandMock.mock.calls.map((call) => call[1])).toEqual([
      ["show", "--property=WorkingDirectory", "--value", unitName],
      ["systemctl", "disable", "--now", unitName],
      ["rm", "-f", "--", path.join("/etc/systemd/system", unitName)],
      ["systemctl", "daemon-reload"],
    ]);
    await expect(fs.access(path.join(runnerDir, ".dgrunner-service"))).rejects.toThrow();
  });
});
