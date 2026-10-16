import os from "node:os";
import crypto from "node:crypto";
import { execCommand, execInteractive } from "../utils/exec.js";
import { saveLocalMetadata } from "./runner-manager.js";

export const DEFAULT_CONTAINER_NAME = "upstand-dgrunner-linux";
export const DEFAULT_DOCKER_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:latest";
export const DGRUNNER_MANAGED_LABEL = "com.upstand.dgrunner.managed";
const DGRUNNER_RUNNER_NAME_LABEL = "com.upstand.dgrunner.runner-name";
const DGRUNNER_RUNNER_URL_LABEL = "com.upstand.dgrunner.runner-url";
const LEGACY_WORK_VOLUME_NAME = "dgrunner-linux-work";

export function getDefaultDockerRunnerName(
  containerName = DEFAULT_CONTAINER_NAME,
  hostName = os.hostname()
): string {
  const hostPrefix = hostName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "host";
  if (containerName === DEFAULT_CONTAINER_NAME) return `${hostPrefix}-linux-docker`;

  const containerSuffix = crypto.createHash("sha256").update(containerName).digest("hex").slice(0, 12);
  return `${hostPrefix}-linux-docker-${containerSuffix}`;
}

export function validateDockerContainerName(containerName: string): string | null {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)
    ? null
    : "Docker container names must start with a letter or number and contain only letters, numbers, '.', '_' or '-' (maximum 128 characters).";
}

export function getDockerRunnerWorkVolumeName(containerName: string): string {
  const suffix = crypto.createHash("sha256").update(containerName).digest("hex").slice(0, 16);
  return `dgrunner-work-${suffix}`;
}

async function removeDockerVolumeIfPresent(volumeName: string): Promise<{ success: boolean; output: string }> {
  const inspect = await execCommand("docker", ["volume", "inspect", volumeName], { timeoutMs: 10000 });
  if (inspect.exitCode !== 0) {
    const output = `${inspect.stdout}\n${inspect.stderr}`.trim();
    if (/no such volume|volume .* not found/i.test(output)) return { success: true, output: "" };
    return { success: false, output };
  }

  const remove = await execCommand("docker", ["volume", "rm", volumeName], { timeoutMs: 30000 });
  return {
    success: remove.exitCode === 0,
    output: `${remove.stdout}\n${remove.stderr}`.trim(),
  };
}

async function removeLegacyWorkVolumeIfUnused(): Promise<string | undefined> {
  const references = await execCommand("docker", [
    "ps", "--all", "--quiet", "--filter", `volume=${LEGACY_WORK_VOLUME_NAME}`,
  ], { timeoutMs: 10000 });
  if (references.exitCode !== 0) {
    return `Could not check whether legacy workspace volume '${LEGACY_WORK_VOLUME_NAME}' is still in use: ${references.stderr || references.stdout}`.trim();
  }
  if (references.stdout.trim()) return undefined;

  const removed = await removeDockerVolumeIfPresent(LEGACY_WORK_VOLUME_NAME);
  return removed.success
    ? undefined
    : `Could not remove legacy workspace volume '${LEGACY_WORK_VOLUME_NAME}': ${removed.output}`;
}

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
  const containerNameError = validateDockerContainerName(containerName);
  if (containerNameError) return { success: false, output: containerNameError };
  const presetKey = options.distro ? options.distro.toLowerCase() : undefined;
  const preset = presetKey ? DOCKER_DISTRO_PRESETS[presetKey] : undefined;
  const image = options.image || preset?.image || DEFAULT_DOCKER_RUNNER_IMAGE;
  const distro = preset?.name || options.distro || (options.image ? "Custom Docker Image" : DOCKER_DISTRO_PRESETS["ubuntu-24.04"].name);
  const runnerName = options.runnerName || getDefaultDockerRunnerName(containerName);
  const labels = options.labels && options.labels.length > 0
    ? options.labels
    : (preset?.defaultLabels || ["self-hosted", "linux", "x64", "docker", "dgrunner"]);
  const labelsStr = labels.join(",");

  // Check if container already exists and remove it to prevent conflicts
  const status = await getDockerRunnerStatus(containerName);
  if (status.exists) {
    const inspect = await execCommand("docker", [
      "inspect",
      containerName,
      "--format",
      "{{json .Config.Labels}}",
    ], { timeoutMs: 5000 });
    let existingLabels: Record<string, string> | null = null;
    try {
      existingLabels = JSON.parse(inspect.stdout) as Record<string, string> | null;
    } catch {}

    if (inspect.exitCode !== 0) {
      return {
        success: false,
        output: `Could not verify ownership of Docker container '${containerName}'.`,
      };
    }
    const managedByDgrunner = existingLabels?.[DGRUNNER_MANAGED_LABEL] === "true";
    if (containerName !== DEFAULT_CONTAINER_NAME && !managedByDgrunner) {
      return {
        success: false,
        output: `Docker container '${containerName}' already exists and is not managed by dgrunner. Choose another container name.`,
      };
    }
    if (managedByDgrunner &&
      (existingLabels?.[DGRUNNER_RUNNER_NAME_LABEL] !== runnerName || existingLabels?.[DGRUNNER_RUNNER_URL_LABEL] !== options.url)) {
      return {
        success: false,
        output: `Docker container '${containerName}' belongs to a different runner registration. Choose another container name or remove the existing runner first.`,
      };
    }

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

  const workVolume = getDockerRunnerWorkVolumeName(containerName);
  const oldVolume = await removeDockerVolumeIfPresent(workVolume);
  if (!oldVolume.success) {
    return { success: false, output: `Could not clear the previous workspace volume '${workVolume}': ${oldVolume.output}` };
  }

  const dockerArgs: string[] = [
    "run",
    "-d",
    "--name", containerName,
    "--label", `${DGRUNNER_MANAGED_LABEL}=true`,
    "--label", `${DGRUNNER_RUNNER_NAME_LABEL}=${runnerName}`,
    "--label", `${DGRUNNER_RUNNER_URL_LABEL}=${options.url}`,
    "--restart", "unless-stopped",
  ];

  if (options.mountDockerSocket === true) {
    dockerArgs.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
    dockerArgs.push("-e", "DOCKER_HOST=unix:///var/run/docker.sock");
  }

  // Keep workspaces across container restarts while isolating each runner registration.
  dockerArgs.push("-v", `${workVolume}:/home/runner/_work`);

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
    await removeDockerVolumeIfPresent(workVolume);
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
  if (res.exitCode !== 0) {
    return {
      success: false,
      output: `${unregister.stdout}\n${res.stdout}\n${res.stderr}`.trim(),
    };
  }

  const workVolume = getDockerRunnerWorkVolumeName(containerName);
  const volumeCleanup = await removeDockerVolumeIfPresent(workVolume);
  const legacyCleanupWarning = await removeLegacyWorkVolumeIfUnused();
  const cleanupWarnings = [
    !volumeCleanup.success && `Could not remove workspace volume '${workVolume}': ${volumeCleanup.output}`,
    legacyCleanupWarning,
  ].filter(Boolean);

  return {
    success: true,
    output: [
      `${unregister.stdout}\n${res.stdout}\n${res.stderr}`.trim(),
      ...cleanupWarnings.map((warning) => `Warning: ${warning}`),
    ].filter(Boolean).join("\n"),
  };
}

/**
 * Streams or displays logs from the Docker runner container.
 */
export async function tailDockerRunnerLogs(
  containerName = DEFAULT_CONTAINER_NAME,
  follow = false,
  lines = 50
): Promise<void> {
  const linesCount = Math.max(1, Math.min(10000, Math.floor(lines || 50)));
  const args = ["logs", "--tail", String(linesCount)];
  if (follow) args.push("-f");
  args.push(containerName);

  await execInteractive("docker", args);
}
