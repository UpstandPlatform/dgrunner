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
  DGRUNNER_VOLUME_MANAGED_LABEL,
  DGRUNNER_VOLUME_CONTAINER_LABEL,
  getDefaultDockerRunnerName,
  getDockerRunnerStatus,
  getDockerRunnerWorkVolumeName,
  removeDockerRunner,
  startDockerContainer,
  stopDockerRunner,
  restartDockerRunner,
  tailDockerRunnerLogs,
  validateDockerContainerName,
  validateDockerImageReference,
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

  it("generates distinct stable default runner names for custom containers", () => {
    expect(getDefaultDockerRunnerName(DEFAULT_CONTAINER_NAME, "build_host"))
      .toBe("build-host-linux-docker");
    expect(getDefaultDockerRunnerName("dgrunner-build", "build_host"))
      .toMatch(/^build-host-linux-docker-[a-f0-9]{12}$/);
    expect(getDefaultDockerRunnerName("dgrunner-build", "build_host"))
      .not.toBe(getDefaultDockerRunnerName("dgrunner-gpu", "build_host"));
  });

  it("validates explicit Docker container names before invoking Docker", async () => {
    expect(validateDockerContainerName("dgrunner-gpu_1")).toBeNull();
    expect(validateDockerContainerName("../runner")).toContain("Docker container names");
    const result = await startDockerRunner({
      containerName: "../runner",
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
    });
    expect(result.success).toBe(false);
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it("validates Docker image references before invoking Docker", async () => {
    expect(validateDockerImageReference("ghcr.io/actions/actions-runner:latest")).toBeNull();
    expect(validateDockerImageReference("my-org/custom-runner:v1.2.3")).toBeNull();

    const result = await startDockerRunner({
      image: "--mount=type=bind,source=/,target=/host",
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("valid image reference");
    expect(execCommandMock).not.toHaveBeenCalled();
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
    const token = "runner-token-value-123456";
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: getDockerRunnerWorkVolumeName("test-runner"), stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: `configured ${token}`, stderr: "" });

    const result = await startDockerRunner({
      containerName: "test-runner",
      url: "https://github.com/example/repo",
      token,
      runnerName: "test-runner",
      labels: ["self-hosted", "linux"],
    });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(token);
    expect(result.output).toContain("[REDACTED]");
    const runCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "run");
    const configureCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "exec");
    expect(runCall).toBeDefined();
    expect(runCall?.[1]).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(runCall?.[1]).not.toContain(token);
    expect(runCall?.[1]).toContain(getDockerRunnerWorkVolumeName("test-runner") + ":/home/runner/_work");
    expect(runCall?.[1]).not.toContain("dgrunner-linux-work:/home/runner/_work");
    expect(runCall?.[1]?.join(" ")).toContain("chown -R");
    expect(runCall?.[1]?.join(" ")).toContain("/home/runner/_work/_tool");
    expect(runCall?.[1]?.join(" ")).toContain("com.upstand.dgrunner.managed=true");
    const volumeCreateCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "volume" && call[1]?.[1] === "create");
    expect(volumeCreateCall?.[1]).toContain(`${DGRUNNER_VOLUME_MANAGED_LABEL}=true`);
    expect(volumeCreateCall?.[1]).toContain(`${DGRUNNER_VOLUME_CONTAINER_LABEL}=test-runner`);
    expect(configureCall?.[1]).not.toContain(token);
    expect(configureCall?.[1]).not.toContain("--token");
    expect(configureCall?.[1]?.join(" ")).toContain("ACTIONS_RUNNER_INPUT_TOKEN");
    expect(configureCall?.[2]).toMatchObject({ input: `${token}\n` });
  });

  it("does not replace a custom-name Docker container that is not managed by dgrunner", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"other.label":"value"}', stderr: "" });

    const result = await startDockerRunner({
      containerName: "existing-service",
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
      runnerName: "actions-runner",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not managed by dgrunner");
    expect(execCommandMock.mock.calls.map((call) => call[1]?.[0])).toEqual(["inspect", "volume", "inspect"]);
  });

  it("does not replace the default container when it belongs to a different runner", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          "com.upstand.dgrunner.managed": "true",
          "com.upstand.dgrunner.runner-name": "existing-runner",
          "com.upstand.dgrunner.runner-url": "https://github.com/example/repo",
        }),
        stderr: "",
      });

    const result = await startDockerRunner({
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
      runnerName: "new-runner",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("different runner registration");
    expect(execCommandMock.mock.calls.map((call) => call[1]?.[0])).toEqual(["inspect", "volume", "inspect"]);
  });

  it("does not replace an unverified legacy default container", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unrelated", stderr: "" });

    const result = await startDockerRunner({
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
      runnerName: "legacy-runner",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not managed by dgrunner");
    expect(execCommandMock.mock.calls.some((call) => call[1]?.[0] === "rm" && call[1]?.[1] === "-f")).toBe(false);
  });

  it("mounts the host Docker socket only when explicitly requested", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: getDockerRunnerWorkVolumeName(DEFAULT_CONTAINER_NAME), stderr: "" })
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
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"com.upstand.dgrunner.managed":"true"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unregistered", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "test-runner", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          [DGRUNNER_VOLUME_MANAGED_LABEL]: "true",
          [DGRUNNER_VOLUME_CONTAINER_LABEL]: "test-runner",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: getDockerRunnerWorkVolumeName("test-runner"), stderr: "" });

    const result = await removeDockerRunner("runner-removal-token-123456", "test-runner");

    expect(result.success).toBe(true);
    expect(execCommandMock.mock.calls.map((call) => call[1])).toContainEqual([
      "volume", "rm", getDockerRunnerWorkVolumeName("test-runner"),
    ]);
  });

  it("removes a Docker runner with its token on stdin and outside process arguments", async () => {
    const token = "runner-removal-token-123456";
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"com.upstand.dgrunner.managed":"true"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unregistered", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "test-runner", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Error: no such volume" });

    const result = await removeDockerRunner(token, "test-runner");

    expect(result.success).toBe(true);
    const unregisterCall = execCommandMock.mock.calls.find((call) => call[1]?.[0] === "exec");
    expect(unregisterCall?.[1]).not.toContain(token);
    expect(unregisterCall?.[1]).not.toContain("--token");
    expect(unregisterCall?.[1]?.join(" ")).toContain("ACTIONS_RUNNER_INPUT_TOKEN");
    expect(unregisterCall?.[2]).toMatchObject({ input: `${token}\n` });
  });

  it("does not remove an existing Docker volume without dgrunner ownership labels", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"other":"application"}', stderr: "" });

    const result = await startDockerRunner({
      containerName: "test-runner",
      url: "https://github.com/example/repo",
      token: "runner-token-value-123456",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not verified as owned by dgrunner");
    expect(execCommandMock.mock.calls.some((call) => call[1]?.[1] === "rm")).toBe(false);
    expect(execCommandMock.mock.calls.some((call) => call[1]?.[0] === "run")).toBe(false);
  });

  it("refuses to unregister or delete a custom container that is not dgrunner-managed", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"other.label":"value"}', stderr: "" });

    const result = await removeDockerRunner("runner-removal-token-123456", "unrelated-container");

    expect(result.success).toBe(false);
    expect(result.output).toContain("not verified as a dgrunner-managed container");
    expect(execCommandMock).toHaveBeenCalledTimes(2);
  });

  it("does not start, stop, or restart a container without dgrunner ownership", async () => {
    for (const lifecycleAction of [startDockerContainer, stopDockerRunner, restartDockerRunner]) {
      execCommandMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '{"other.label":"value"}', stderr: "" });

      const result = await lifecycleAction("unrelated-container");

      expect(result.success).toBe(false);
      expect(execCommandMock.mock.calls.map((call) => call[1]?.[0])).toEqual(["inspect", "inspect"]);
      execCommandMock.mockReset();
    }
  });

  it("requires matching runner identity before removing a legacy default container", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          "com.upstand.dgrunner.runner-name": "another-runner",
          "com.upstand.dgrunner.runner-url": "https://github.com/example/other",
        }),
        stderr: "",
      });

    const result = await removeDockerRunner(
      "runner-removal-token-123456",
      DEFAULT_CONTAINER_NAME,
      true,
      { name: "expected-runner", url: "https://github.com/example/repo" }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("not verified as a dgrunner-managed container");
    expect(execCommandMock).toHaveBeenCalledTimes(2);
  });

  it("redacts the removal token if Docker removes the container unsuccessfully", async () => {
    const token = "runner-removal-token-123456";
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":true,"Status":"running"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"com.upstand.dgrunner.managed":"true"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: `unregistered ${token}`, stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: `failed ${token}`, stderr: "" });

    const result = await removeDockerRunner(token, "test-runner");

    expect(result.success).toBe(false);
    expect(result.output).not.toContain(token);
    expect(result.output).toContain("[REDACTED]");
  });

  it("restores a stopped Docker runner if unregistering fails", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":false,"Status":"exited"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"com.upstand.dgrunner.managed":"true"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "invalid token" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" });

    const result = await removeDockerRunner("runner-removal-token-123456", "test-runner");

    expect(result.success).toBe(false);
    expect(execCommandMock.mock.calls.map((call) => call[1]?.[0])).toEqual([
      "inspect", "inspect", "start", "exec", "stop",
    ]);
  });

  it("restores a previously stopped container if Docker cannot remove it", async () => {
    execCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"Running":false,"Status":"exited"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"com.upstand.dgrunner.managed":"true"}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unregistered", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "cannot remove" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" });

    const result = await removeDockerRunner("runner-removal-token-123456", "test-runner");

    expect(result.success).toBe(false);
    expect(execCommandMock.mock.calls.map((call) => call[1]?.[0])).toEqual([
      "inspect", "inspect", "start", "exec", "rm", "stop",
    ]);
  });

  it("limits Docker log output for both static and followed logs", async () => {
    execInteractiveMock.mockResolvedValueOnce(17).mockResolvedValueOnce(0);
    await expect(tailDockerRunnerLogs("test-runner", false, 23)).resolves.toBe(17);
    await tailDockerRunnerLogs("test-runner", true, 11);

    expect(execInteractiveMock).toHaveBeenNthCalledWith(1, "docker", [
      "logs", "--tail", "23", "test-runner",
    ]);
    expect(execInteractiveMock).toHaveBeenNthCalledWith(2, "docker", [
      "logs", "--tail", "11", "-f", "test-runner",
    ]);
  });
});

