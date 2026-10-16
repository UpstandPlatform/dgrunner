import path from "node:path";
import os from "node:os";

export const APP_NAME = "dgrunner";
export const APP_VERSION = "2.1.2";
export const APP_DESCRIPTION = "Secure self-hosted GitHub Actions runner CLI with Docker";
export const NPM_PACKAGE_NAME = "@upstand/dgrunner";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/@upstand/dgrunner";

export const DEFAULT_BASE_DIR = path.join(os.homedir(), ".dgrunner");
export const DEFAULT_RUNNER_DIR = path.join(DEFAULT_BASE_DIR, "actions-runner");
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_RUNNER_REPO = "actions/runner";

/**
 * Fallback pinned runner versions and known SHA-256 checksums if GitHub API is unreachable or rate limited.
 */
export const FALLBACK_RUNNER_VERSION = "2.338.0";
export const FALLBACK_CHECKSUMS: Record<string, string> = {
  "linux-arm": "1d6a7688d2aca1a1fecd4df5d473e4aa4226c1f1785ff915cf84049665a3483f",
  "linux-arm64": "628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b",
  "linux-x64": "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32",
  "win-arm64": "a57a4d29c0dcf02210a16b01906ed76cb8091b26d728c41232736c0f627a557e",
  "win-x64": "f48e0750a21812bca5f82de5f7f5aeae71abee647fab5a582f1742d07eba455f",
};

export const SECURITY_DOCS_URL =
  "https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security";

export const MINIMUM_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
