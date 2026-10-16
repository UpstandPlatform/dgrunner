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
      "--token", "runner-token",
      "--name", "runner one",
      "--labels", "self-hosted,linux",
      "--force",
      "--no-service",
    ]);
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
    expect(args).toContain("--token");
    expect(args).toContain("runner-token");
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
});
