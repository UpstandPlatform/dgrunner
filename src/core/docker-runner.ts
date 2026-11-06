import os from "node:os";
import crypto from "node:crypto";
import { execCommand, execInteractive } from "../utils/exec.js";
import { redactSecret } from "../utils/logger.js";
import {
  normalizeRunnerLabels,
  validateGitHubUrl,
  validateRegistrationToken,
  validateRunnerLabels,
  validateRunnerName,
} from "./security.js";
import { saveLocalMetadata } from "./runner-manager.js";

export const DEFAULT_CONTAINER_NAME = "upstand-dgrunner-linux";
export const DEFAULT_DOCKER_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:latest";
export const DGRUNNER_MANAGED_LABEL = "com.upstand.dgrunner.managed";
const DGRUNNER_RUNNER_NAME_LABEL = "com.upstand.dgrunner.runner-name";
const DGRUNNER_RUNNER_URL_LABEL = "com.upstand.dgrunner.runner-url";
export const DGRUNNER_VOLUME_MANAGED_LABEL = "com.upstand.dgrunner.volume-managed";
export const DGRUNNER_VOLUME_CONTAINER_LABEL = "com.upstand.dgrunner.container-name";

export function getDockerArchitectureLabel(arch = process.arch): "x64" | "arm64" | null {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return null;
}

const DOCKER_ARCH_LABEL = getDockerArchitectureLabel() || "x64";

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

export function validateDockerImageReference(image: string): string | null {
  const referencePattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$/;
  return image.length <= 255 && referencePattern.test(image)
    ? null
    : "Docker image must be a valid image reference without whitespace or command-line options.";
}

export function getDockerRunnerWorkVolumeName(containerName: string): string {
  const suffix = crypto.createHash("sha256").update(containerName).digest("hex").slice(0, 16);
  return `dgrunner-work-${suffix}`;
}

function isMissingDockerObject(output: string): boolean {
  return /no such (?:volume|object)|volume .* not found/i.test(output);
}

async function inspectDockerVolumeLabels(volumeName: string): Promise<{
  exists: boolean;
  labels?: Record<string, string>;
  output: string;
}> {
  const inspect = await execCommand("docker", [
    "volume", "inspect", "--format", "{{json .Labels}}", volumeName,
  ], { timeoutMs: 10000 });
  if (inspect.exitCode !== 0) {
    const output = `${inspect.stdout}\n${inspect.stderr}`.trim();
    return isMissingDockerObject(output)
      ? { exists: false, output: "" }
      : { exists: false, output };
  }

  try {
    const labels = JSON.parse(inspect.stdout) as Record<string, string> | null;
    return { exists: true, labels: labels || {}, output: "" };
  } catch {
    return { exists: true, output: "Docker returned invalid volume labels." };
  }
}

export interface DockerRunnerIdentity {
  name: string;
  url: string;
}

async function verifyDockerRunnerOwnership(
  containerName: string,
  expectedRunner?: DockerRunnerIdentity,
  allowLegacyDefault = false
): Promise<{ valid: boolean; output: string }> {
  const inspect = await execCommand("docker", [
    "inspect", containerName, "--format", "{{json .Config.Labels}}",
  ], { timeoutMs: 5000 });
  let labels: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(inspect.stdout) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      labels = parsed as Record<string, string>;
    }
  } catch {}

  const managed = labels?.[DGRUNNER_MANAGED_LABEL] === "true";
  const matchesExpected = !expectedRunner || (
    labels?.[DGRUNNER_RUNNER_NAME_LABEL] === expectedRunner.name &&
    labels?.[DGRUNNER_RUNNER_URL_LABEL] === expectedRunner.url
  );
  const legacyDefault = allowLegacyDefault && containerName === DEFAULT_CONTAINER_NAME &&
    Boolean(expectedRunner) && matchesExpected;
  if (inspect.exitCode !== 0 || !labels || (!managed && !legacyDefault) || !matchesExpected) {
    return {
      valid: false,
      output: `Docker container '${containerName}' is not verified as a dgrunner-managed container for the expected runner.`,
    };
  }
  return { valid: true, output: "" };
}

function isOwnedDockerWorkVolume(
  labels: Record<string, string> | undefined,
  containerName: string
): boolean {
  return labels?.[DGRUNNER_VOLUME_MANAGED_LABEL] === "true" &&
    labels[DGRUNNER_VOLUME_CONTAINER_LABEL] === containerName;
}

async function removeDockerVolumeIfPresent(
  volumeName: string,
  containerName: string
): Promise<{ success: boolean; output: string }> {
  const inspected = await inspectDockerVolumeLabels(volumeName);
  if (!inspected.exists) {
    return inspected.output
      ? { success: false, output: inspected.output }
      : { success: true, output: "" };
  }
  if (inspected.output) return { success: false, output: inspected.output };
  if (!isOwnedDockerWorkVolume(inspected.labels, containerName)) {
    return { success: false, output: `Workspace volume '${volumeName}' is not verified as owned by runner '${containerName}'.` };
  }

  const remove = await execCommand("docker", ["volume", "rm", volumeName], { timeoutMs: 30000 });
  return {
    success: remove.exitCode === 0,
    output: `${remove.stdout}\n${remove.stderr}`.trim(),
  };
}

async function prepareDockerWorkVolume(
  volumeName: string,
  containerName: string,
  initialInspection: Awaited<ReturnType<typeof inspectDockerVolumeLabels>>,
  refreshInspection: boolean
): Promise<{ success: boolean; created: boolean; output: string }> {
  const inspected = refreshInspection
    ? await inspectDockerVolumeLabels(volumeName)
    : initialInspection;
  if (!inspected.exists && inspected.output) {
    return { success: false, created: false, output: inspected.output };
  }

  if (inspected.exists) {
    if (inspected.output) return { success: false, created: false, output: inspected.output };
    if (!isOwnedDockerWorkVolume(inspected.labels, containerName)) {
      return {
        success: false,
        created: false,
        output: `Workspace volume '${volumeName}' already exists and is not verified as owned by dgrunner. Choose another container name.`,
      };
    }
    const removed = await removeDockerVolumeIfPresent(volumeName, containerName);
    if (!removed.success) {
      return { success: false, created: false, output: `Could not clear the previous workspace volume '${volumeName}': ${removed.output}` };
    }
  }

  const created = await execCommand("docker", [
    "volume", "create",
    "--label", `${DGRUNNER_VOLUME_MANAGED_LABEL}=true`,
    "--label", `${DGRUNNER_VOLUME_CONTAINER_LABEL}=${containerName}`,
    volumeName,
  ], { timeoutMs: 30000 });
  return {
    success: created.exitCode === 0,
    created: created.exitCode === 0,
    output: created.exitCode === 0
      ? ""
      : created.stderr || created.stdout || `Could not create workspace volume '${volumeName}'.`,
  };
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
    defaultLabels: ["self-hosted", "linux", DOCKER_ARCH_LABEL, "docker", "ubuntu", "ubuntu-24.04", "dgrunner"],
  },
  "ubuntu-22.04": {
    id: "ubuntu-22.04",
    name: "Ubuntu 22.04 LTS (Jammy)",
    image: "ghcr.io/actions/actions-runner:2.316.0",
    defaultLabels: ["self-hosted", "linux", DOCKER_ARCH_LABEL, "docker", "ubuntu", "ubuntu-22.04", "dgrunner"],
  },
  "debian": {
    id: "debian",
    name: "Debian (Bookworm compatible)",
    image: "ghcr.io/actions/actions-runner:latest",
    defaultLabels: ["self-hosted", "linux", DOCKER_ARCH_LABEL, "docker", "debian", "dgrunner"],
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
  const architectureLabel = getDockerArchitectureLabel();
  if (!architectureLabel) {
    return { success: false, output: `Docker runners are supported only on x64 or arm64 hosts (received ${process.arch}).` };
  }
  const containerName = options.containerName || DEFAULT_CONTAINER_NAME;
  const containerNameError = validateDockerContainerName(containerName);
  if (containerNameError) return { success: false, output: containerNameError };
  const url = options.url.trim();
  const urlValidation = validateGitHubUrl(url);
  if (!urlValidation.valid) return { success: false, output: urlValidation.error || "Invalid GitHub URL." };
  const tokenValidation = validateRegistrationToken(options.token);
  if (!tokenValidation.valid) return { success: false, output: tokenValidation.error || "Invalid runner token." };
  const presetKey = options.distro ? options.distro.toLowerCase() : undefined;
  const preset = presetKey ? DOCKER_DISTRO_PRESETS[presetKey] : undefined;
  const image = options.image?.trim() || preset?.image || DEFAULT_DOCKER_RUNNER_IMAGE;
  const imageError = validateDockerImageReference(image);
  if (imageError) return { success: false, output: imageError };
  const distro = preset?.name || options.distro || (options.image ? "Custom Docker Image" : DOCKER_DISTRO_PRESETS["ubuntu-24.04"].name);
  const runnerName = (options.runnerName || getDefaultDockerRunnerName(containerName)).trim();
  const nameValidation = validateRunnerName(runnerName);
  if (!nameValidation.valid) return { success: false, output: nameValidation.error || "Invalid runner name." };
  const labels = options.labels && options.labels.length > 0
    ? normalizeRunnerLabels(options.labels)
    : (preset?.defaultLabels || ["self-hosted", "linux", architectureLabel, "docker", "dgrunner"]);
  const labelsValidation = validateRunnerLabels(labels);
  if (!labelsValidation.valid) return { success: false, output: labelsValidation.error || "Invalid runner labels." };
  const labelsStr = labels.join(",");
  const workVolume = getDockerRunnerWorkVolumeName(containerName);

  // Check if container already exists and remove it to prevent conflicts
  const status = await getDockerRunnerStatus(containerName);
  // Verify a persistent volume before removing a prior container with this name.
  const initialVolume = await inspectDockerVolumeLabels(workVolume);
  if (!initialVolume.exists && initialVolume.output) {
    return { success: false, output: initialVolume.output };
  }
  if (initialVolume.exists &&
    (initialVolume.output || !isOwnedDockerWorkVolume(initialVolume.labels, containerName))) {
    return {
      success: false,
      output: initialVolume.output || `Workspace volume '${workVolume}' already exists and is not verified as owned by dgrunner. Choose another container name.`,
    };
  }

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
    if (!managedByDgrunner) {
      return {
        success: false,
        output: `Docker container '${containerName}' already exists and is not managed by dgrunner. Choose another container name.`,
      };
    }
    if (managedByDgrunner &&
      (existingLabels?.[DGRUNNER_RUNNER_NAME_LABEL] !== runnerName || existingLabels?.[DGRUNNER_RUNNER_URL_LABEL] !== url)) {
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

  const preparedVolume = await prepareDockerWorkVolume(workVolume, containerName, initialVolume, status.exists);
  if (!preparedVolume.success) {
    return { success: false, output: preparedVolume.output };
  }

  const dockerArgs: string[] = [
    "run",
    "-d",
    "--name", containerName,
    "--label", `${DGRUNNER_MANAGED_LABEL}=true`,
    "--label", `${DGRUNNER_RUNNER_NAME_LABEL}=${runnerName}`,
    "--label", `${DGRUNNER_RUNNER_URL_LABEL}=${url}`,
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
    const volumeCleanup = preparedVolume.created
      ? await removeDockerVolumeIfPresent(workVolume, containerName)
      : { success: true, output: "" };
    return {
      success: false,
      output: [
        `${launch.stdout}\n${launch.stderr}`.trim(),
        !volumeCleanup.success && `Warning: could not remove the runner workspace volume: ${volumeCleanup.output}`,
      ].filter(Boolean).join("\n"),
    };
  }

  // Send the short-lived token over stdin. It is not stored in container config,
  // environment variables, or the docker command line.
  const configureScript = [
    'IFS= read -r runner_token || exit 1',
    'export ACTIONS_RUNNER_INPUT_TOKEN="$runner_token"',
    'unset runner_token',
    './config.sh --url "$1" --name "$2" --labels "$3" --unattended --replace',
  ].join("\n");
  const configure = await execCommand(
    "docker",
    ["exec", "-i", containerName, "/bin/bash", "-c", configureScript, "dgrunner", url, runnerName, labelsStr],
    {
      input: `${options.token}\n`,
      timeoutMs: 60000,
    }
  );

  if (configure.exitCode !== 0) {
    const cleanup = await execCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30000 });
    const volumeCleanup = cleanup.exitCode === 0 && preparedVolume.created
      ? await removeDockerVolumeIfPresent(workVolume, containerName)
      : { success: false, output: cleanup.stderr || cleanup.stdout || "container cleanup failed" };
    return {
      success: false,
      output: redactSecret([
        `${configure.stdout}\n${configure.stderr}`.trim(),
        cleanup.exitCode !== 0 && `Warning: could not remove the failed runner container: ${cleanup.stderr || cleanup.stdout}`,
        cleanup.exitCode === 0 && preparedVolume.created && !volumeCleanup.success &&
          `Warning: could not remove the runner workspace volume: ${volumeCleanup.output}`,
      ].filter(Boolean).join("\n"), options.token),
    };
  }

  const scope = url.split("/").filter(Boolean).length === 4 ? "repo" : "org";
  try {
    await saveLocalMetadata({
      runnerDir: `docker:${containerName}`,
      url,
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
  } catch (error) {
    const removed = await execCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30000 });
    const volumeCleanup = removed.exitCode === 0 && preparedVolume.created
      ? await removeDockerVolumeIfPresent(workVolume, containerName)
      : { success: false, output: removed.stderr || removed.stdout || "container cleanup failed" };
    return {
      success: false,
      output: redactSecret([
        `Runner registered with GitHub, but local metadata could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        removed.exitCode !== 0 && `Warning: could not remove the runner container: ${removed.stderr || removed.stdout}`,
        removed.exitCode === 0 && preparedVolume.created && !volumeCleanup.success &&
          `Warning: could not remove the runner workspace volume: ${volumeCleanup.output}`,
        "The GitHub runner registration may remain offline; remove it from GitHub if local state cannot be recovered.",
      ].filter(Boolean).join("\n"), options.token),
    };
  }

  return {
    success: true,
    output: redactSecret(`${launch.stdout}\n${configure.stdout}\n${configure.stderr}`.trim(), options.token),
  };
}

/**
 * Stops the Docker runner container.
 */
export async function stopDockerRunner(
  containerName = DEFAULT_CONTAINER_NAME,
  expectedRunner?: DockerRunnerIdentity
): Promise<{ success: boolean; output: string }> {
  const nameError = validateDockerContainerName(containerName);
  if (nameError) return { success: false, output: nameError };
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  const ownership = await verifyDockerRunnerOwnership(containerName, expectedRunner, Boolean(expectedRunner));
  if (!ownership.valid) return { success: false, output: ownership.output };
  if (!status.running) return { success: true, output: "Docker runner container is already stopped." };
  const res = await execCommand("docker", ["stop", containerName]);
  return {
    success: res.exitCode === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/** Starts a stopped Docker runner without interrupting one that is already active. */
export async function startDockerContainer(
  containerName = DEFAULT_CONTAINER_NAME,
  expectedRunner?: DockerRunnerIdentity
): Promise<{ success: boolean; output: string }> {
  const nameError = validateDockerContainerName(containerName);
  if (nameError) return { success: false, output: nameError };
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  const ownership = await verifyDockerRunnerOwnership(containerName, expectedRunner, Boolean(expectedRunner));
  if (!ownership.valid) return { success: false, output: ownership.output };
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
  containerName = DEFAULT_CONTAINER_NAME,
  expectedRunner?: DockerRunnerIdentity
): Promise<{ success: boolean; output: string }> {
  const nameError = validateDockerContainerName(containerName);
  if (nameError) return { success: false, output: nameError };
  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  const ownership = await verifyDockerRunnerOwnership(containerName, expectedRunner, Boolean(expectedRunner));
  if (!ownership.valid) return { success: false, output: ownership.output };
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
  containerName = DEFAULT_CONTAINER_NAME,
  allowLegacyDefault = false,
  expectedRunner?: { name: string; url: string }
): Promise<{ success: boolean; output: string }> {
  const tokenValidation = validateRegistrationToken(token);
  if (!tokenValidation.valid) return { success: false, output: tokenValidation.error || "Invalid runner removal token." };
  const containerNameError = validateDockerContainerName(containerName);
  if (containerNameError) return { success: false, output: containerNameError };

  const status = await getDockerRunnerStatus(containerName);
  if (!status.exists) {
    return { success: false, output: `Docker runner container '${containerName}' was not found.` };
  }

  const ownership = await verifyDockerRunnerOwnership(containerName, expectedRunner, allowLegacyDefault);
  if (!ownership.valid) return { success: false, output: ownership.output };

  const startedForRemoval = !status.running;
  if (startedForRemoval) {
    const start = await execCommand("docker", ["start", containerName], { timeoutMs: 30000 });
    if (start.exitCode !== 0) {
      return { success: false, output: `${start.stdout}\n${start.stderr}`.trim() };
    }
  }

  const unregister = await execCommand(
    "docker",
    ["exec", "-i", containerName, "/bin/bash", "-c", [
      'IFS= read -r runner_token || exit 1',
      'export ACTIONS_RUNNER_INPUT_TOKEN="$runner_token"',
      'unset runner_token',
      "./config.sh remove",
    ].join("; ")],
    { input: `${token}\n`, timeoutMs: 30000 }
  );
  if (unregister.exitCode !== 0) {
    const restore = startedForRemoval
      ? await execCommand("docker", ["stop", containerName], { timeoutMs: 30000 })
      : undefined;
    const restoreWarning = restore && restore.exitCode !== 0
      ? `\nWarning: could not restore the container to its stopped state: ${restore.stderr || restore.stdout}`
      : "";
    return {
      success: false,
      output: redactSecret(`${unregister.stdout}\n${unregister.stderr}${restoreWarning}`.trim(), token),
    };
  }

  const res = await execCommand("docker", ["rm", "-f", containerName], { timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    const restore = startedForRemoval
      ? await execCommand("docker", ["stop", containerName], { timeoutMs: 30000 })
      : undefined;
    const restoreWarning = restore && restore.exitCode !== 0
      ? `\nWarning: could not restore the container to its stopped state: ${restore.stderr || restore.stdout}`
      : "";
    return {
      success: false,
      output: redactSecret(`${unregister.stdout}\n${res.stdout}\n${res.stderr}${restoreWarning}`.trim(), token),
    };
  }

  const workVolume = getDockerRunnerWorkVolumeName(containerName);
  const volumeCleanup = await removeDockerVolumeIfPresent(workVolume, containerName);
  const cleanupWarnings = [
    !volumeCleanup.success && `Could not remove workspace volume '${workVolume}': ${volumeCleanup.output}`,
  ].filter(Boolean);

  return {
    success: true,
    output: [
      redactSecret(`${unregister.stdout}\n${res.stdout}\n${res.stderr}`.trim(), token),
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
): Promise<number> {
  const linesCount = Math.max(1, Math.min(10000, Math.floor(lines || 50)));
  const args = ["logs", "--tail", String(linesCount)];
  if (follow) args.push("-f");
  args.push(containerName);

  return execInteractive("docker", args);
}
