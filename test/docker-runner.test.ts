import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  getDockerRunnerStatus,
} from "../src/core/docker-runner.js";

describe("Docker Runner Module", () => {
  it("should have official runner image and container defaults", () => {
    expect(DEFAULT_CONTAINER_NAME).toBe("upstand-dgrunner-linux");
    expect(DEFAULT_DOCKER_RUNNER_IMAGE).toBe("ghcr.io/actions/actions-runner:latest");
  });

  it("should query container status safely when container does not exist", async () => {
    const status = await getDockerRunnerStatus("non-existent-test-runner-container-999");
    expect(status).toBeDefined();
    expect(status.exists).toBe(false);
    expect(status.running).toBe(false);
    expect(status.status).toBe("Not Created");
  });
});
