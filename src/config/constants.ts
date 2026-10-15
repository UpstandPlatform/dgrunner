import path from "node:path";
import os from "node:os";

export const APP_NAME = "dgrunner";
export const APP_VERSION = "1.0.0";
export const APP_DESCRIPTION = "Secure self-hosted GitHub Actions runner CLI with Docker";
export const NPM_PACKAGE_NAME = "@upstand/dgrunner";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/@upstand/dgrunner";

export const DEFAULT_BASE_DIR = path.join(os.homedir(), ".dgrunner");
export const DEFAULT_RUNNER_DIR = path.join(DEFAULT_BASE_DIR, "actions-runner");
export const RUNNER_CONFIG_FILE = path.join(DEFAULT_BASE_DIR, "runner-config.json");

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_RUNNER_REPO = "actions/runner";

/**
 * Fallback pinned runner versions and known SHA-256 checksums if GitHub API is unreachable or rate limited.
 */
export const FALLBACK_RUNNER_VERSION = "2.322.0";
export const FALLBACK_CHECKSUMS: Record<string, string> = {
  "linux-x64": "b13b784808359f31bc79b0d841775f4865a72582db580b293d62323b1687b399",
  "linux-arm64": "e2c31e7c5ab8d2c366ff5032890aeae5eb25b6a37803a0a3900c3b01fc633288",
  "win-x64": "e44d567fead633464531818296a6f62ea6fc739ab887e5cc5b9b7754eb539f40",
};

export const SECURITY_DOCS_URL =
  "https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security";

export const MINIMUM_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
