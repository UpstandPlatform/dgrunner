import os from "node:os";
import { execCommand, execInteractive } from "../utils/exec.js";
import { saveLocalMetadata } from "./runner-manager.js";

export const DEFAULT_CONTAINER_NAME = "upstand-dgrunner-linux";
export const DEFAULT_DOCKER_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:latest";

export interface DockerDistroPreset {
  id: string;
  name: string;
  image: string;
  defaultLabels: string[];
}

export const DOCKER_DISTRO_PRESETS: Record<string, DockerDistroPreset> = {
  "ubuntu-24.04": {
    id: "ubuntu-24.04",
    name: "Ubuntu 24.04 LTS (Noble)",
    image: "ghcr.io/actions/actions-runner:latest",
    defaultLabels: ["self-hosted", "linux", "x64", "docker", "ubuntu", "ubuntu-24.04", "dgrunner"],
  },
  "ubuntu-22.04": {
    id: "ubuntu-22.04",
    name: "Ubuntu 22.04 LTS (Jammy)",
    image: "ghcr.io/actions/actions-runner:2.316.0",
    defaultLabels: ["self-hosted", "linux", "x64", "docker", "ubuntu", "ubuntu-22.04", "dgrunner"],
  },
  "debian": {
    id: "debian",
    name: "Debian (Bookworm compatible)",
    image: "ghcr.io/actions/actions-runner:latest",
    defaultLabels: ["self-hosted", "linux", "x64", "docker", "debian", "dgrunner"],
  },
};

export interface DockerRunnerOptions {
  containerName?: string;
  runnerName?: string;
  url: string;
  token: string;
  labels?: string[];
  image?: string;
  distro?: string;
  mountDockerSocket?: boolean;
}

export interface DockerContainerStatus {
  exists: boolean;
  running: boolean;
  status: string;
  containerId?: string;
  startedAt?: string;
  memory?: string;
  cpu?: string;
}

/**
 * Checks if a Docker container exists and whether it is running.
 */
export async function getDockerRunnerStatus(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<DockerContainerStatus> {
  const res = await execCommand("docker", [
    "inspect",
    containerName,
    "--format",
    "{{json .State}}",
  ]);

  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return {
      exists: false,
      running: false,
      status: "Not Created",
    };
  }

  try {
    const state = JSON.parse(res.stdout);
    const running = state.Running === true;
    const status = state.Status || (running ? "running" : "stopped");
    return {
      exists: true,
      running,
      status: running ? "Running" : "Stopped",
      startedAt: state.StartedAt,
    };
  } catch {
    return {
      exists: true,
      running: res.stdout.toLowerCase().includes('"running":true'),
      status: "Unknown",
    };
  }
}

/**
 * Pulls and starts the official GitHub Actions runner container in Docker.
 */
export async function startDockerRunner(
  options: DockerRunnerOptions
): Promise<{ success: boolean; output: string }> {
  const containerName = options.containerName || DEFAULT_CONTAINER_NAME;
  const presetKey = options.distro ? options.distro.toLowerCase() : undefined;
  const preset = presetKey ? DOCKER_DISTRO_PRESETS[presetKey] : undefined;
  const image = options.image || preset?.image || DEFAULT_DOCKER_RUNNER_IMAGE;
  const distro = preset?.name || options.distro || (options.image ? "Custom Docker Image" : DOCKER_DISTRO_PRESETS["ubuntu-24.04"].name);
  const runnerName = options.runnerName || `${os.hostname().toLowerCase()}-linux-docker`;
  const labels = options.labels && options.labels.length > 0
    ? options.labels
    : (preset?.defaultLabels || ["self-hosted", "linux", "x64", "docker", "dgrunner"]);
  const labelsStr = labels.join(",");

  // Check if container already exists and remove it to prevent conflicts
  const status = await getDockerRunnerStatus(containerName);
  if (status.exists) {
    await execCommand("docker", ["rm", "-f", containerName]);
  }

  const dockerArgs: string[] = [
    "run",
    "-d",
    "--name", containerName,
    "--restart", "unless-stopped",
  ];

  if (options.mountDockerSocket !== false) {
    dockerArgs.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
    dockerArgs.push("-e", "DOCKER_HOST=unix:///var/run/docker.sock");
  }

  // Work volume to preserve build workspace cache across container restarts
  dockerArgs.push("-v", "dgrunner-linux-work:/home/runner/_work");

  // Command executed inside the container:
  // 1. Ensure docker.sock permissions so workflows can run docker commands without root
  // 2. Configure runner if .runner doesn't exist
  // 3. Start run.sh (so restarts resume cleanly even after registration token expires)
  const runnerScript = `sudo chmod 666 /var/run/docker.sock 2>/dev/null || true; if [ ! -f .runner ]; then ./config.sh --url "${options.url}" --token "${options.token}" --name "${runnerName}" --labels "${labelsStr}" --unattended --replace; fi && ./run.sh`;

  dockerArgs.push(
    "--entrypoint", "/bin/bash",
    image,
    "-c",
    runnerScript
  );

  const res = await execCommand("docker", dockerArgs, {
    timeoutMs: 60000,
  });

  const success = res.exitCode === 0;

  if (success) {
    const scope = options.url.split("/").filter(Boolean).length === 4 ? "repo" : "org";
    await saveLocalMetadata({
      runnerDir: `docker:${containerName}`,
      url: options.url,
      name: runnerName,
      labels,
      scope,
      configuredAt: new Date().toISOString(),
      os: "linux",
      arch: "x64",
      mode: "docker",
      containerName,
      distro,
      image,
    });
  }

  return {
    success,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/**
 * Stops the Docker runner container.
 */
export async function stopDockerRunner(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const res = await execCommand("docker", ["stop", containerName]);
  return {
    success: res.exitCode === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/**
 * Restarts the Docker runner container.
 */
export async function restartDockerRunner(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const res = await execCommand("docker", ["restart", containerName]);
  return {
    success: res.exitCode === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/**
 * Force removes the Docker runner container.
 */
export async function removeDockerRunner(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const res = await execCommand("docker", ["rm", "-f", containerName]);
  return {
    success: res.exitCode === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/**
 * Streams or displays logs from the Docker runner container.
 */
export async function tailDockerRunnerLogs(
  containerName = DEFAULT_CONTAINER_NAME,
  follow = false
): Promise<void> {
  const args = ["logs"];
  if (follow) {
    args.push("-f");
  } else {
    args.push("--tail", "50");
  }
  args.push(containerName);

  await execInteractive("docker", args);
}
