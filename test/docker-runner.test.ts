import { beforeEach, describe, it, expect, vi } from "vitest";
import { startDockerRunner } from "../src/core/docker-runner.js";

const { execCommandMock, execInteractiveMock, saveMetadataMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  execInteractiveMock: vi.fn(),
  saveMetadataMock: vi.fn(),
}));

vi.mock("../src/utils/exec.js", () => ({
  execCommand: execCommandMock,
  execInteractive: execInteractiveMock,
}));

vi.mock("../src/core/runner-manager.js", () => ({
  saveLocalMetadata: saveMetadataMock,
}));
import {
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  DOCKER_DISTRO_PRESETS,
  getDockerRunnerStatus,
  getDockerRunnerWorkVolumeName,
  removeDockerRunner,
  tailDockerRunnerLogs,
} from "../src/core/docker-runner.js";

describe("Docker Runner Module", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    saveMetadataMock.mockResolvedValue(undefined);
  });

  it("should have official runner image and container defaults", () => {
    expect(DEFAULT_CONTAINER_NAME).toBe("upstand-dgrunner-linux");
    expect(DEFAULT_DOCKER_RUNNER_IMAGE).toBe("ghcr.io/actions/actions-runner:latest");
  });

  it("uses isolated, deterministic work volumes for each runner container", () => {
    const first = getDockerRunnerWorkVolumeName("runner-one");
    const second = getDockerRunnerWorkVolumeName("runner-two");
    expect(first).toMatch(/^dgrunner-work-[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
    expect(getDockerRunnerWorkVolumeName("runner-one")).toBe(first);
  });

  it("should define standard Linux distribution presets for Docker", () => {
    expect(DOCKER_DISTRO_PRESETS).toHaveProperty("ubuntu-24.04");
    expect(DOCKER_DISTRO_PRESETS).toHaveProperty("ubuntu-22.04");
    expect(DOCKER_DISTRO_PRESETS).toHaveProperty("debian");

    const ubuntu24 = DOCKER_DISTRO_PRESETS["ubuntu-24.04"];
    expect(ubuntu24.image).toBe("ghcr.io/actions/actions-runner:latest");
    expect(ubuntu24.defaultLabels).toContain("ubuntu-24.04");

    const ubuntu22 = DOCKER_DISTRO_PRESETS["ubuntu-22.04"];
    expect(ubuntu22.image).toBe("ghcr.io/actions/actions-runner:2.316.0");
    expect(ubuntu22.defaultLabels).toContain("ubuntu-22.04");

    const debian = DOCKER_DISTRO_PRESETS["debian"];
    expect(debian.defaultLabels).toContain("debian");
  });

  it("should query container status safely when container does not exist", async () => {
    execCommandMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not found" });
    const status = await getDockerRunnerStatus("non-existent-test-runner-container-999");
    expect(status).toBeDefined();
    expect(status.exists).toBe(false);
    expect(status.running).toBe(false);
    expect(status.status).toBe("Not Created");
  });

  it("does not mount the host Docker socket or expose the registration token by default", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "configured", stderr: "" });
    const token = "runner-token-value-123456";

    const result = await startDockerRunner({
      containerName: "test-runner",
      url: "https://github.com/example/repo",
      token,
      runnerName: "test-runner",
      labels: ["self-hosted", "linux"],
    });

    expect(result.success).toBe(true);
    const runCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "run");
    const configureCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "exec");
    expect(runCall).toBeDefined();
    expect(runCall?.[1]).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(runCall?.[1]).not.toContain(token);
    expect(runCall?.[1]).toContain(getDockerRunnerWorkVolumeName("test-runner") + ":/home/runner/_work");
    expect(runCall?.[1]).not.toContain("dgrunner-linux-work:/home/runner/_work");
    expect(runCall?.[1]?.join(" ")).toContain("chown -R");
    expect(runCall?.[1]?.join(" ")).toContain("/home/runner/_work/_tool");
    expect(configureCall?.[1]).not.toContain(token);
    expect(configureCall?.[2]).toMatchObject({ input: `${token}\n` });
  });

  it("mounts the host Docker socket only when explicitly requested", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "configured", stderr: "" });

    const result = await startDockerRunner({
      containerName: "test-runner",
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
      mountDockerSocket: true,
    });

    expect(result.success).toBe(true);
    const runCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "run");
    expect(runCall?.[1]).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("removes its workspace volume after successful runner removal", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unregistered", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "test-runner", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[{"Name":"dgrunner-work-0000000000000000"}]', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "dgrunner-work-0000000000000000", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" });

    const result = await removeDockerRunner("runner-token", "test-runner");

    expect(result.success).toBe(true);
    expect(execCommandMock.mock.calls.map((call) => call[1])).toContainEqual([
      "volume", "rm", getDockerRunnerWorkVolumeName("test-runner"),
    ]);
  });

  it("limits Docker log output for both static and followed logs", async () => {
    await tailDockerRunnerLogs("test-runner", false, 23);
    await tailDockerRunnerLogs("test-runner", true, 11);

    expect(execInteractiveMock).toHaveBeenNthCalledWith(1, "docker", [
      "logs", "--tail", "23", "test-runner",
    ]);
    expect(execInteractiveMock).toHaveBeenNthCalledWith(2, "docker", [
      "logs", "--tail", "11", "-f", "test-runner",
    ]);
  });
});

