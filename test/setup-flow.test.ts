import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  inputMock,
  passwordMock,
  selectMock,
  confirmMock,
  doctorMock,
  execInteractiveMock,
  installedWslDistrosMock,
  downloadRunnerMock,
  configureRunnerMock,
  installServiceMock,
  startServiceMock,
} = vi.hoisted(() => ({
  inputMock: vi.fn(),
  passwordMock: vi.fn(),
  selectMock: vi.fn(),
  confirmMock: vi.fn(),
  doctorMock: vi.fn(),
  execInteractiveMock: vi.fn(),
  installedWslDistrosMock: vi.fn(),
  downloadRunnerMock: vi.fn(),
  configureRunnerMock: vi.fn(),
  installServiceMock: vi.fn(),
  startServiceMock: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  input: inputMock,
  password: passwordMock,
  select: selectMock,
  confirm: confirmMock,
}));

vi.mock("../src/core/doctor.js", () => ({ runDoctorChecks: doctorMock }));
vi.mock("../src/core/wsl.js", () => ({
  isWsl: vi.fn(() => false),
  detectLinuxDistro: vi.fn(async () => undefined),
  getInstalledWslDistros: installedWslDistrosMock,
  getAvailableOnlineWslDistros: vi.fn(async () => []),
}));
vi.mock("../src/utils/exec.js", () => ({
  execCommand: vi.fn(),
  execInteractive: execInteractiveMock,
}));
vi.mock("../src/core/runner-installer.js", () => ({ downloadAndInstallRunner: downloadRunnerMock }));
vi.mock("../src/core/runner-manager.js", () => ({
  configureRunner: configureRunnerMock,
  installService: installServiceMock,
  startService: startServiceMock,
}));
vi.mock("../src/core/guide.js", () => ({ writeVerificationWorkflow: vi.fn() }));

import { buildWslSetupArgs, runSetupFlow } from "../src/commands/setup.js";
import { validateRunnerLabels } from "../src/core/security.js";

describe("Setup flow validation", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("forwards provided WSL setup options through a login shell", () => {
    const args = buildWslSetupArgs({
      env: "wsl",
      url: "https://github.com/example/repo",
      token: "runner-token",
      name: "runner one",
      labels: "self-hosted,linux",
      force: true,
      service: false,
    }, "Ubuntu 24.04");

    expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu 24.04", "bash", "-l", "-c"]);
    expect(args[5]).toContain("exec npx @upstand/dgrunner setup \"$@\"");
    expect(args.slice(-11)).toEqual([
      "dgrunner",
      "--url", "https://github.com/example/repo",
      "--name", "runner one",
      "--labels", "self-hosted,linux",
      "--env", "wsl",
      "--force",
      "--no-service",
    ]);
    expect(args).not.toContain("runner-token");
  });

  it("transfers non-interactive WSL setup and preserves the command arguments", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    installedWslDistrosMock.mockResolvedValue(["Ubuntu"]);
    execInteractiveMock.mockResolvedValue(0);

    try {
      await runSetupFlow({
        env: "wsl",
        distro: "Ubuntu",
        url: "https://github.com/example/repo",
        token: "runner-token",
        name: "runner",
        labels: "self-hosted,linux",
      });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }

    expect(execInteractiveMock).toHaveBeenCalledOnce();
    const [command, args] = execInteractiveMock.mock.calls[0]!;
    expect(command).toBe("wsl.exe");
    expect(args).toContain("-l");
    expect(args).toContain("--url");
    expect(args).toContain("https://github.com/example/repo");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("runner-token");
    expect(args).toContain("--env");
    expect(args).toContain("wsl");
    expect(args).toContain("--name");
    expect(args).toContain("runner");
  });

  it("does not ask for runner scope when a repository URL was supplied", async () => {
    doctorMock.mockResolvedValue({ ok: true, hasWarnings: false, checks: [] });
    passwordMock.mockResolvedValue("runner-token");
    inputMock.mockResolvedValueOnce("runner-name").mockResolvedValueOnce("self-hosted,linux");
    confirmMock.mockResolvedValue(false);
    downloadRunnerMock.mockResolvedValue(undefined);
    configureRunnerMock.mockResolvedValue({ success: true, output: "" });
    installServiceMock.mockResolvedValue({ success: true, message: "installed" });
    startServiceMock.mockResolvedValue({ success: true, message: "started" });

    await runSetupFlow({ env: "native", url: "https://github.com/example/repo" });

    expect(selectMock).not.toHaveBeenCalled();
    expect(passwordMock).toHaveBeenCalledOnce();
    expect(configureRunnerMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://github.com/example/repo",
      token: "runner-token",
    }));
  });

  it("rejects a supplied URL before prompting for a registration token", async () => {
    doctorMock.mockResolvedValue({ ok: true, hasWarnings: false, checks: [] });
    selectMock.mockResolvedValue("repo");
    passwordMock.mockReset();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("setup exited");
    }) as never);

    await expect(runSetupFlow({ env: "native", url: "https://attacker.example/owner/repo" }))
      .rejects.toThrow("setup exited");
    expect(exit).toHaveBeenCalledWith(1);
    expect(passwordMock).not.toHaveBeenCalled();
  });

  it("treats native setup on Windows as a Windows runner target", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const previousExitCode = process.exitCode;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    doctorMock.mockResolvedValue({ ok: true, hasWarnings: false, checks: [] });
    downloadRunnerMock.mockResolvedValue(undefined);
    configureRunnerMock.mockResolvedValue({ success: true, output: "" });

    try {
      await runSetupFlow({
        env: "native",
        url: "https://github.com/example/repo",
        token: "runner-token-value-123456",
        name: "runner",
        service: false,
      });

      expect(configureRunnerMock).toHaveBeenCalledWith(expect.objectContaining({
        labels: ["self-hosted", "dgrunner", "windows", process.arch],
      }));
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      process.exitCode = previousExitCode;
    }
  });

  it("rejects a Windows runner target from Linux even when --force is set", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const previousExitCode = process.exitCode;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      await runSetupFlow({
        env: "windows",
        url: "https://github.com/example/repo",
        token: "runner-token-value-123456",
        force: true,
      });
      expect(process.exitCode).toBe(1);
      expect(doctorMock).not.toHaveBeenCalled();
      expect(downloadRunnerMock).not.toHaveBeenCalled();
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      process.exitCode = previousExitCode;
    }
  });

  it("rejects conflicting OS and environment flags before any checks run", async () => {
    const previousExitCode = process.exitCode;
    try {
      await runSetupFlow({ env: "docker", os: "windows" });
      expect(process.exitCode).toBe(1);
      expect(doctorMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects --no-service for Docker because it would silently ignore the flag", async () => {
    const previousExitCode = process.exitCode;
    try {
      await runSetupFlow({ env: "docker", service: false });
      expect(process.exitCode).toBe(1);
      expect(doctorMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("bounds labels and rejects terminal control characters", () => {
    expect(validateRunnerLabels(["self-hosted", "linux"]).valid).toBe(true);
    expect(validateRunnerLabels(["linux\u001b[31mred"]).error).toContain("control characters");
    expect(validateRunnerLabels(Array.from({ length: 101 }, (_, index) => `label-${index}`)).error).toContain("100 labels");
    expect(validateRunnerLabels([]).error).toContain("At least one");
  });

  it("does not claim the runner is active when --no-service is requested", async () => {
    const previousExitCode = process.exitCode;
    doctorMock.mockResolvedValue({ ok: true, hasWarnings: false, checks: [] });
    downloadRunnerMock.mockResolvedValue(undefined);
    configureRunnerMock.mockResolvedValue({ success: true, output: "" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runSetupFlow({
        env: "native",
        service: false,
        url: "https://github.com/example/repo",
        token: "runner-token-value-123456",
        name: "runner",
        labels: "self-hosted,linux",
      });
      expect(startServiceMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(" ")).toContain("not currently running");
      expect(logSpy.mock.calls.flat().join(" ")).toContain("dgrunner run");
    } finally {
      logSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
