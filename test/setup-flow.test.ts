import { afterEach, describe, expect, it, vi } from "vitest";

const { inputMock, passwordMock, selectMock, confirmMock, doctorMock } = vi.hoisted(() => ({
  inputMock: vi.fn(),
  passwordMock: vi.fn(),
  selectMock: vi.fn(),
  confirmMock: vi.fn(),
  doctorMock: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  input: inputMock,
  password: passwordMock,
  select: selectMock,
  confirm: confirmMock,
}));

vi.mock("../src/core/doctor.js", () => ({ runDoctorChecks: doctorMock }));

import { runSetupFlow } from "../src/commands/setup.js";

describe("Setup flow validation", () => {
  afterEach(() => vi.restoreAllMocks());

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
