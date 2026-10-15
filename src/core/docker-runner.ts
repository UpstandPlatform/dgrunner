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
  const res = await execCommand(
    "docker",
    ["inspect", containerName, "--format", "{{json .State}}"],
    { timeoutMs: 5000 }
  );

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
    const removeExisting = await execCommand("docker", ["rm", "-f", containerName], {
      timeoutMs: 30000,
    });
    if (removeExisting.exitCode !== 0) {
      return {
        success: false,
        output: `${removeExisting.stdout}\n${removeExisting.stderr}`.trim(),
      };
    }
  }

  const dockerArgs: string[] = [
    "run",
    "-d",
    "--name", containerName,
    "--restart", "unless-stopped",
  ];

  if (options.mountDockerSocket === true) {
    dockerArgs.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
    dockerArgs.push("-e", "DOCKER_HOST=unix:///var/run/docker.sock");
  }

  // Work volume to preserve build workspace cache across container restarts
  dockerArgs.push("-v", "dgrunner-linux-work:/home/runner/_work");

  // Named volumes are mounted root-owned by Docker. Repair ownership once so the
  // runner UID can create its tool cache and workspace without broad permissions.
  const runnerScript = [
    "set -eu",
    'expected_owner="$(id -u):$(id -g)"',
    'owner_file=/home/runner/_work/.dgrunner-owner',
    'if [ ! -d /home/runner/_work ]; then if [ "$(id -u)" = "0" ]; then mkdir -p /home/runner/_work; else sudo install -d -o "$(id -u)" -g "$(id -g)" /home/runner/_work; fi; fi',
    'if [ "$(cat "$owner_file" 2>/dev/null || true)" != "$expected_owner" ] || [ ! -w /home/runner/_work ] || [ ! -w /home/runner/_work/_tool ]; then',
    '  if [ "$(id -u)" = "0" ]; then chown -R "$expected_owner" /home/runner/_work; else sudo chown -R "$expected_owner" /home/runner/_work; fi',
    '  printf "%s\\n" "$expected_owner" > "$owner_file"',
    "fi",
    'mkdir -p /home/runner/_work/_tool',
    'if [ ! -w /home/runner/_work ] || [ ! -w /home/runner/_work/_tool ]; then echo "Runner work volume is not writable by $(id -u):$(id -g)." >&2; exit 1; fi',
    'while [ ! -f .runner ]; do sleep 1; done',
    "exec ./run.sh",
  ].join("\n");

  dockerArgs.push(
    "--entrypoint", "/bin/bash",
    image,
    "-c",
    runnerScript
  );

  const launch = await execCommand("docker", dockerArgs, {
    timeoutMs: 60000,
  });

  if (launch.exitCode !== 0) {
    return {
      success: false,
      output: `${launch.stdout}\n${launch.stderr}`.trim(),
    };
  }

  // Send the short-lived token over stdin. It is not stored in container config,
  // environment variables, or the docker command line.
  const configureScript = [
    'IFS= read -r runner_token || exit 1',
    './config.sh --url "$1" --token "$runner_token" --name "$2" --labels "$3" --unattended --replace',
  ].join("\n");
  const configure = await execCommand(
    "docker",
    ["exec", "-i", containerName, "/bin/bash", "-c", configureScript, "dgrunner", options.url, runnerName, labelsStr],
    {
      input: `${options.token}\n`,
      timeoutMs: 60000,
    }
  );

  if (configure.exitCode !== 0) {
    await execCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30000 });
    return {
      success: false,
      output: `${configure.stdout}\n${configure.stderr}`.trim(),
    };
  }

  const scope = options.url.split("/").filter(Boolean).length === 4 ? "repo" : "org";
  await saveLocalMetadata({
    runnerDir: `docker:${containerName}`,
    url: options.url,
    name: runnerName,
    labels,
    scope,
    configuredAt: new Date().toISOString(),
    os: "linux",
    arch: process.arch,
    mode: "docker",
    containerName,
    distro,
    image,
  });

  return {
    success: true,
    output: `${launch.stdout}\n${configure.stdout}\n${configure.stderr}`.trim(),
  };
}

/**
 * Stops the Docker runner container.
 */
export async function stopDockerRunner(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  if (!status.running) return { success: true, output: "Docker runner container is already stopped." };
  const res = await execCommand("docker", ["stop", containerName]);
  return {
    success: res.exitCode === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/** Starts a stopped Docker runner without interrupting one that is already active. */
export async function startDockerContainer(
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  if (status.running) return { success: true, output: "Docker runner container is already running." };
  const res = await execCommand("docker", ["start", containerName], { timeoutMs: 30000 });
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
  token: string,
  containerName = DEFAULT_CONTAINER_NAME
): Promise<{ success: boolean; output: string }> {
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) {
    return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  }

  if (!status.running) {
    const start = await execCommand("docker", ["start", containerName], { timeoutMs: 30000 });
    if (start.exitCode !== 0) {
      return { success: false, output: `${start.stdout}\n${start.stderr}`.trim() };
    }
  }

  const unregister = await execCommand(
    "docker",
    ["exec", "-i", containerName, "/bin/bash", "-c", 'IFS= read -r runner_token || exit 1; ./config.sh remove --token "$runner_token"'],
    { input: `${token}\n`, timeoutMs: 30000 }
  );
  if (unregister.exitCode !== 0) {
    return {
      success: false,
      output: `${unregister.stdout}\n${unregister.stderr}`.trim(),
    };
  }

  const res = await execCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30000 });
  return {
    success: res.exitCode === 0,
    output: `${unregister.stdout}\n${res.stdout}\n${res.stderr}`.trim(),
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
