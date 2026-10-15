import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  DOCKER_DISTRO_PRESETS,
  getDockerRunnerStatus,
} from "../src/core/docker-runner.js";

describe("Docker Runner Module", () => {
  it("should have official runner image and container defaults", () => {
    expect(DEFAULT_CONTAINER_NAME).toBe("upstand-dgrunner-linux");
    expect(DEFAULT_DOCKER_RUNNER_IMAGE).toBe("ghcr.io/actions/actions-runner:latest");
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
    const status = await getDockerRunnerStatus("non-existent-test-runner-container-999");
    expect(status).toBeDefined();
    expect(status.exists).toBe(false);
    expect(status.running).toBe(false);
    expect(status.status).toBe("Not Created");
  });
});

