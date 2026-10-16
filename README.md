# dgrunner 🚀

> **Set up and manage self-hosted GitHub Actions runners on Linux and Windows, in WSL or Docker—with security checks, lifecycle controls, and a verification workflow generator.**

[![skills.sh](https://skills.sh/b/UpstandPlatform/dgrunner)](https://skills.sh/UpstandPlatform/dgrunner)

Built with TypeScript and [Commander](https://www.npmjs.com/package/commander).

---

## 📑 Table of Contents

- [Why dgrunner?](#-why-dgrunner)
- [Security Model & Guardrails](#-security-model--guardrails)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
  - [Global Install (Recommended)](#1-global-installation-recommended)
  - [Zero-Install via npx](#2-zero-install-via-npx)
  - [Install from Source](#3-install-from-source)
- [Agent Skills](#-agent-skills)
- [Quick Start Guide](#-quick-start-guide)
- [CLI Command Reference](#-cli-command-reference)
  - [`dgrunner doctor`](#dgrunner-doctor)
  - [`dgrunner setup`](#dgrunner-setup)
  - [`dgrunner status`](#dgrunner-status)
  - [`dgrunner start` / `stop` / `restart`](#dgrunner-start--stop--restart)
  - [`dgrunner run` (Foreground Attached Mode)](#dgrunner-run-foreground-attached-mode)
  - [`dgrunner ps` / `list`](#dgrunner-ps--list-active-process-inspector)
  - [`dgrunner logs` / `attach`](#dgrunner-logs--attach-live-log-streaming)
  - [`dgrunner upgrade` / `update`](#dgrunner-upgrade--update-self-upgrade)
  - [`dgrunner remove`](#dgrunner-remove)
  - [`dgrunner guide`](#dgrunner-guide)
- [Verifying Your Runner on GitHub](#-verifying-your-runner-on-github)
- [Platform-Specific Notes & Troubleshooting](#-platform-specific-notes--troubleshooting)
  - [Windows: Git Bash vs. WSL bash](#windows-git-bash-vs-wsl-bash)
  - [Docker: Runner Tool Cache Permissions](#docker-runner-tool-cache-permissions)
  - [Linux: Rootless Docker Setup](#linux-rootless-docker-setup)
  - [Handling Session Conflicts](#handling-session-conflicts)
- [CI/CD & npm Trusted Publishing](#-cicd--npm-trusted-publishing)
- [Development & Testing](#-development--testing)
- [License](#-license)

---

## 🤖 Agent Skills

The repository includes installable skills that teach agentic coding tools how to set up, operate, and troubleshoot `dgrunner`. Skills are compatible with Claude Code, Codex, and other agents supported by the skills CLI.

List the available skills:

```bash
npx skills add UpstandPlatform/dgrunner --list
```

Install all dgrunner skills for all supported agents:

```bash
npx skills add UpstandPlatform/dgrunner --all
```

Or install the skills for Claude Code and Codex:

```bash
npx skills add UpstandPlatform/dgrunner --skill dgrunner-setup dgrunner-operations dgrunner-troubleshooting --agent claude-code codex
```

The skill definitions are also included in the npm package under `skills/`. Skills.sh installs them from this public GitHub repository with its CLI; npm installation of `@upstand/dgrunner` remains a separate step for the runner command itself.

---

## 💡 Why dgrunner?

Self-hosting GitHub Actions runners gives you bare-metal speed, custom hardware/GPU access, and zero compute minute limits. However, running arbitrary CI/CD code on personal workstations or company machines poses severe security risks if misconfigured.

`dgrunner` solves this by automating:
- **Pre-flight security audits** before any binary is installed.
- **Automated package integrity verification** (SHA-256 validation against official GitHub releases).
- **Linux system service and Windows background process management.**
- **Docker integration** with rootless isolation checks.
- **Automated verification workflows** to validate host, container, and security boundaries.

---

## 🔒 Security Model & Guardrails

GitHub advises against using self-hosted runners on public repositories because pull requests from public forks can execute arbitrary code on the runner machine. `dgrunner` provides pre-flight checks and safe defaults; operators remain responsible for repository visibility and runner isolation:

1. **GitHub URL Validation**
   - The CLI accepts GitHub.com and GitHub Enterprise Cloud URLs. It cannot determine whether a repository is private; only register runners for trusted repositories and organizations.
2. **Unprivileged Execution Checks**
   - Blocks setup when running as root on Linux unless the operator explicitly overrides pre-flight checks with `--force`; checks elevation on Windows.
3. **Docker Security Checks**
   - `dgrunner doctor` reports rootful Docker and unauthenticated remote TCP exposure. Checks may be overridden with `--force`; rootless Docker is recommended for Linux hosts.
4. **Binary Tamper Protection (SHA-256)**
   - All runner binaries are downloaded directly from official GitHub releases and cryptographically verified against official SHA-256 checksums before extraction.
5. **Ephemeral Secrets**
   - Short-lived runner tokens are entered via masked prompts and are not logged or persisted by dgrunner. Native runner configuration passes the registration token to GitHub's configuration process as a command-line argument, so local process inspection may expose it briefly; avoid supplying tokens with `--token`. Docker configuration sends the token over stdin.
6. **Filesystem Permission Hardening**
   - Directories and local metadata files are created with restricted POSIX permissions (`0700` / `0600`).

---

## 📦 Prerequisites

Before setting up a runner, ensure your system has:

| Dependency | Minimum Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>= 22.14.0` | Node 22 LTS or Node 24 LTS recommended |
| **Git** | `>= 2.25.0` | Required for checkout steps (Git for Windows on Windows) |
| **Docker** | Engine / Desktop | Docker Desktop (Windows) or Rootless Docker (Linux) |
| **Operating System** | Linux / Windows | Linux (`x64`, `arm64`) or Windows (`x64`) |

---

## 📥 Installation

You can install and use `dgrunner` in three ways:

### 1. Global Installation (Recommended)

Install `@upstand/dgrunner` globally on your machine using npm:

```bash
npm install -g @upstand/dgrunner
```

Once installed globally, the `dgrunner` binary is available across your entire system:

```bash
dgrunner --help
dgrunner doctor
```

To update to the latest release:
```bash
npm update -g @upstand/dgrunner
```

To uninstall:
```bash
npm uninstall -g @upstand/dgrunner
```

---

### 2. Zero-Install via npx

Run the latest release directly without a persistent global install:

```bash
# Launch interactive setup wizard
npx @upstand/dgrunner

# Run diagnostics
npx @upstand/dgrunner doctor

# View integration guide
npx @upstand/dgrunner guide
```

---

### 3. Install from Source

If you want to contribute, modify, or run the development build locally:

```bash
# 1. Clone repository
git clone https://github.com/UpstandPlatform/dgrunner.git
cd dgrunner

# 2. Install dependencies
npm install

# 3. Build bundle
npm run build

# 4. Link globally (makes 'dgrunner' available in your terminal)
npm link
```

---

## ⚡ Quick Start Guide

### Step 1: Pre-flight Audit
Run the built-in diagnostic doctor to ensure your PC, Git, Docker, and network meet all requirements:

```bash
dgrunner doctor
```

### Step 2: Retrieve your Short-Lived Token from GitHub
1. Navigate to your **private** repository on GitHub.
2. Click **Settings** ➔ **Actions** ➔ **Runners**.
3. Click the green **New self-hosted runner** button.
4. Copy the registration token shown under *Configure* (`--token <TOKEN>`).

### Step 3: Run the Setup Wizard
Launch the guided setup wizard:

```bash
dgrunner
```

Follow the prompts:
- Select **Private Repository** (or Organization).
- Enter your repository URL (e.g. `https://github.com/owner/repo`).
- Paste your short-lived registration token (hidden input).
- Confirm the runner name and labels.
- `dgrunner` will download the official runner, verify its SHA-256 hash, register it with GitHub, and start it. Linux installs a system service; Windows native mode starts a detached process that does not auto-start after sign-out or reboot.

### Step 4: Verify with an Automated Workflow
Generate the ready-to-use verification workflow:

```bash
dgrunner guide --generate-workflow
```

Push `.github/workflows/verify-runner.yml` to your repository:
```bash
git add .github/workflows/verify-runner.yml
git commit -m "ci: verify self-hosted runner"
git push
```

---

## 🛠️ CLI Command Reference

### `dgrunner doctor`
Runs a battery of system diagnostics and security audits:
- Host OS and CPU architecture compatibility.
- User privilege isolation (warns on elevated Windows admin; errors on Linux root).
- Git version and PATH availability.
- Git Bash detection on Windows (to avoid WSL collisions).
- WSL command availability and installed WSL2 distributions when targeting WSL.
- Docker engine availability and daemon responsiveness.
- Docker rootless mode audit on Linux.
- Unauthenticated remote Docker TCP socket check.
- GitHub HTTPS API reachability and latency.
- Free disk space availability.

```bash
dgrunner doctor
dgrunner doctor --strict        # Exits with code 1 if warnings or errors exist
dgrunner doctor --dir ~/runner  # Check specific installation path
dgrunner doctor --env docker    # Evaluate checks for a planned Docker runner
dgrunner doctor --env wsl       # Check WSL2 prerequisites from Windows
```

---

### `dgrunner setup`
Full automated setup or scripted unattended setup via flags.

#### 🌐 Target Runner Environments & Distro Selection

When running `dgrunner setup` on Windows, you can choose between:

1. **Windows Native** (Default)
   - Runs natively on Windows host as a detached background process or foreground runner. It is not installed as a Windows service and does not auto-start after sign-out or reboot.
   - Ideal for PowerShell scripts, .NET builds, and Windows-specific pipelines.
2. **Linux Container (via Docker)**
   - Spins up an authentic Linux runner inside Docker with your choice of distribution:
     - **Ubuntu 24.04 LTS (Noble)** (Default / Recommended - `ghcr.io/actions/actions-runner:latest`)
     - **Ubuntu 22.04 LTS (Jammy)** (`ghcr.io/actions/actions-runner:2.316.0`)
     - **Debian (Bookworm compatible)** (`ghcr.io/actions/actions-runner:latest`)
     - **Custom Docker Image** (Any custom organization runner image via `--image`)
   - Distro labels (`ubuntu`, `ubuntu-24.04`, `ubuntu-22.04`, `debian`) are automatically injected into runner labels.
   - Runs genuine Linux/Bash jobs on your Windows machine with automatic restart (`--restart unless-stopped`).
   - Does not mount the host Docker socket by default. Use `--docker-socket` only when workflows need it; access to that socket can grant control of the Docker host.
   - Preserves build caches across container restarts in a dedicated, runner-isolated volume. Re-registering or removing the runner clears its workspace volume.
3. **WSL2 Linux Environment**
   - Automatically detects all installed WSL distributions (`Ubuntu`, `Debian`, etc.) and allows selecting or installing a new distribution directly from Microsoft Store (`Ubuntu-24.04`, `Debian`, `kali-linux`, `archlinux`).
   - Dynamically identifies distribution details from `/etc/os-release` and tags labels accordingly.
   - `dgrunner` can automatically transfer setup to your selected WSL2 distro or guide you step-by-step.

#### 💻 Usage Examples

```bash
# Interactive wizard (prompts for target environment, Linux distro, repository, and token)
dgrunner setup

# Set up a Linux runner container via Docker with Ubuntu 24.04 LTS:
dgrunner setup --os linux --distro ubuntu-24.04

# Set up a Linux runner container with Ubuntu 22.04 LTS (Jammy):
dgrunner setup --env docker --distro ubuntu-22.04

# Set up a Docker runner with a custom runner image:
dgrunner setup --env docker --image my-org/custom-actions-runner:latest

# Set up inside a specific WSL2 distro on Windows:
dgrunner setup --env wsl --distro Ubuntu-24.04

# Unattended Linux Container setup via Docker (token may be prompted for interactively):
dgrunner setup \
  --os linux \
  --distro ubuntu-24.04 \
  --url https://github.com/owner/repo \
  --name my-pc-linux-docker
# dgrunner prompts for the token using hidden input

# Scripted Windows Native setup:
dgrunner setup \
  --os windows \
  --url https://github.com/owner/repo \
  --name my-workstation \
  --labels self-hosted,dgrunner,gpu
# dgrunner prompts for the token using hidden input
```

**Options:**
- `-u, --url <url>`: Target GitHub repository or organization URL.
- `-t, --token <token>`: Optional GitHub Actions registration token. Prefer the hidden prompt to avoid shell history and process-list exposure. Native setup briefly passes the token to GitHub's configuration process in argv.
- `-n, --name <name>`: Custom runner name (defaults to `<hostname>-linux-docker` or `<hostname>-dgrunner`).
- `-l, --labels <labels>`: Comma-separated custom labels (e.g. `self-hosted,dgrunner,linux,x64,docker,ubuntu-24.04`).
- `-d, --dir <path>`: Runner installation directory (defaults to `~/.dgrunner/actions-runner`).
- `--os <os>`: Target runner OS: `windows` or `linux` (on Windows, `linux` launches Docker container mode).
- `--env <env>`: Target environment: `windows`, `docker`, `wsl`, or `native`.
- `--distro <distro>`: Linux distribution preset (`ubuntu-24.04`, `ubuntu-22.04`, `debian`) or WSL distro name.
- `--image <image>`: Custom Docker runner container image (e.g. `ghcr.io/actions/actions-runner:latest`).
- `--docker-socket`: Explicitly mount `/var/run/docker.sock` into the container. Workflows can gain control over the Docker host through this socket.
- `--force`: Bypass critical pre-flight failures at your own risk.
- `--no-service`: Configure without immediately starting the runner. Windows mode is a background process, not an installed OS service.

---

### `dgrunner status`
Inspects installed runner metadata, configuration, and background service state:

```bash
dgrunner status
```

**Sample Output (Docker Runner with Ubuntu 24.04 LTS):**
```text
=== dgrunner Status Dashboard ===

┌─ RUNNER STATUS ────────────────────────────────────────────┐
│ Installed:   Yes                                           │
│ Configured:  Yes                                           │
│ Environment: Linux Container (Docker) [Ubuntu 24.04 LTS]   │
│ Container:   upstand-dgrunner-linux                        │
│ Image:       ghcr.io/actions/actions-runner:latest         │
│ Runner Name: my-workstation-linux-docker                   │
│ Target URL:  https://github.com/my-org/private-repo        │
│ Labels:      self-hosted, linux, x64, docker, ubuntu-24.04 │
│ Service:     Active & Running (Docker Container)           │
└─────────────────────────────────────────────────────────────┘
```

---

### `dgrunner start` / `stop` / `restart`
Manages the lifecycle of the persistent runner daemon:

```bash
# Start the runner service in the background
dgrunner start

# Start and stay attached in foreground
dgrunner start --attach

# Stop the runner service or attached foreground process
dgrunner stop

# Restart the runner service
dgrunner restart
```

---

### `dgrunner run` (Foreground Attached Mode)
Direct shortcut to start the runner in the foreground and stream live GitHub Actions job outputs directly to your terminal:

```bash
dgrunner run
```

Press `Ctrl+C` to cleanly detach and stop.

---

### `dgrunner ps` / `list` (Active Process Inspector)
Lists all active GitHub Actions runner processes managed by `dgrunner` with PID, memory consumption, status, and target repository:

```bash
dgrunner ps
```

**Sample Output:**
```text
=== Active dgrunner Processes ===

PID      PROCESS            RUNNER NAME          MEMORY     STATUS       TARGET
─────────────────────────────────────────────────────────────────────────────────────
29892    Runner.Listener    dordoone-runner      84 MB      Listening    https://github.com/mhbdev/dordoone
```

---

### `dgrunner logs` / `attach` (Live Log Streaming)
Views and streams real-time console logs from the running background runner service:

```bash
# View last 50 lines of logs
dgrunner logs

# Follow logs in real-time (live stream)
dgrunner logs --follow

# View last 100 lines and follow
dgrunner logs -n 100 -f
```

Docker logs honor `--lines` for both static output and follow mode. Native Linux logs are read from the systemd journal and may prompt for sudo access. Windows background logs include both stdout and stderr.

---

### `dgrunner upgrade` / `update` (Self-Upgrade)
Automatically checks the npm registry for the latest stable release and upgrades `@upstand/dgrunner`:

```bash
# Upgrade to the latest stable release
dgrunner upgrade

# Using alias 'update'
dgrunner update

# Check for available updates without installing
dgrunner upgrade --check

# Force re-installation of the latest version
dgrunner upgrade --force

# Upgrade to a specific distribution tag (e.g. beta / next)
dgrunner upgrade --tag beta

# Specify package manager (auto-detected by default)
dgrunner upgrade --package-manager pnpm
```

**Options:**
- `-c, --check`: Check for available updates without installing.
- `-f, --force`: Force re-installation even if already on the latest version.
- `-t, --tag <tag>`: Specify distribution tag (default: `latest`).
- `--package-manager <pm>`: Override package manager (`npm`, `pnpm`, `yarn`, `bun`).

---

### `dgrunner remove`
Safely deregisters the runner from GitHub Actions and removes local service configuration:

```bash
dgrunner remove
```

Prompts for a short-lived **removal token** (obtainable from GitHub repo *Settings ➔ Actions ➔ Runners ➔ Click Runner ➔ Remove*).

---

### `dgrunner guide`
Displays colorized step-by-step instructions on navigating GitHub and safely generating registration tokens:

```bash
# Display general guide
dgrunner guide

# Display organization-specific guide
dgrunner guide --scope org

# Generate test workflow file
dgrunner guide --generate-workflow
```

---

## 🧪 Verifying Your Runner on GitHub

When you run `dgrunner guide --generate-workflow`, it writes `.github/workflows/verify-runner.yml` to your repository:

```yaml
name: Verify dgrunner Self-Hosted Runner

on:
  workflow_dispatch:
  push:
    branches: [ main, master ]

jobs:
  verify-host:
    name: 1. Verify Host & Environment
    runs-on: ["self-hosted", "dgrunner"]
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Print Runner & OS Details
        shell: bash
        run: |
          echo "======================================"
          echo "Runner Hostname: $(hostname)"
          echo "Current User:    $(whoami)"
          echo "OS Details:      $(uname -a 2>/dev/null || cmd.exe /c ver)"
          echo "Workspace Dir:   $GITHUB_WORKSPACE"
          echo "Bash Executable: $(which bash 2>/dev/null || echo 'unknown')"
          echo "======================================"

  verify-docker:
    name: 2. Verify Docker Container Execution
    runs-on: ["self-hosted", "dgrunner"]
    steps:
      - name: Test Docker CLI & Daemon
        shell: bash
        run: |
          echo "Checking Docker version..."
          docker --version
          echo "Running lightweight test container..."
          docker run --rm alpine:latest echo "Hello from containerized workflow on $(hostname)!"

  verify-security:
    name: 3. Verify Security Boundaries
    runs-on: ["self-hosted", "dgrunner"]
    steps:
      - name: Check Non-Root User Execution
        shell: bash
        run: |
          if [ "$(id -u 2>/dev/null)" = "0" ]; then
            echo "WARNING: Workflow is running as root on host!"
            exit 1
          else
            echo "SUCCESS: Workflow running under unprivileged user."
          fi

      - name: Test Docker User Namespace / Isolation
        shell: bash
        run: |
          docker run --rm alpine:latest id
          echo "Docker container isolation verified."
```

---

## 🔧 Platform-Specific Notes & Troubleshooting

### Windows: Git Bash vs. WSL bash

On Windows, GitHub Actions steps configured with `shell: bash` require **Git Bash** (`C:\Program Files\Git\bin\bash.exe`). 

> [!WARNING]
> If Windows Subsystem for Linux (WSL) is enabled, Windows places `C:\WINDOWS\system32\bash.exe` in PATH. When GitHub runner steps invoke `system32\bash.exe`, it fails with `No such file or directory` because WSL bash receives Windows-style drive paths (`C:\Users\...`).
> 
> **How dgrunner fixes this automatically:**
> `dgrunner` automatically discovers your Git Bash directory and writes it to `~/.dgrunner/actions-runner/.path` and the runner process environment. This guarantees that Git Bash is prioritized over WSL bash for all workflow steps.

### WSL2 Setup & Docker Desktop Integration

If you want to run Linux runners on Windows, you have two great options:

1. **Option A: Linux Container via Docker (Zero WSL Config)**:
   Run directly from your Windows PowerShell or Command Prompt:
   ```bash
   dgrunner setup --os linux
   ```
   This spins up the official Linux runner container directly on Docker Desktop.

2. **Option B: Native WSL2 Runner**:
   If you prefer running natively inside your WSL2 distro (e.g. Ubuntu):
   ```bash
   # Open WSL
   wsl

   # Run setup inside WSL
   npx @upstand/dgrunner setup
   ```
   > [!TIP]
   > If your workflows use Docker steps inside WSL, ensure Docker Desktop WSL integration is toggled on:
   > **Docker Desktop Settings** ➔ **Resources** ➔ **WSL Integration** ➔ Enable integration for your distro (e.g. `Ubuntu`).
   > Run `dgrunner doctor` inside WSL to verify your connection.

### Docker: Runner Tool Cache Permissions

If a job fails with `UnauthorizedAccessException` or `Permission denied` for `/home/runner/_work/_tool`, the runner worker could not create its tool cache before normal workflow steps started. In Docker mode, this path is inside the runner container and backed by a runner-isolated named volume; it is not a VPS path. The volume persists across container restarts and is cleared when the runner is re-registered or removed.

The official runner image runs as the unprivileged `runner` account. If Docker created the named volume as root, repair only the mounted work directory from the host:

```bash
docker exec --user root upstand-dgrunner-linux chown -R runner:runner /home/runner/_work
docker exec --user root upstand-dgrunner-linux install -d -o runner -g runner -m 0755 /home/runner/_work/_tool
```

Then verify the runner account can write there:

```bash
docker exec --user runner upstand-dgrunner-linux sh -lc 'test -w /home/runner/_work && test -w /home/runner/_work/_tool && echo writable'
```

Current dgrunner startup repairs ownership of a newly initialized work volume with that same account-scoped ownership change. Later `TaskCanceledException` broker messages can follow a failed job as the runner disconnects and retries; they do not explain the earlier `_tool` permission denial.

### Linux: Rootless Docker Setup

To prevent workflow containers from accessing the host root filesystem, install Rootless Docker:

```bash
# 1. Install rootless prerequisites
sudo apt-get install -y uidmap dbus-user-session

# 2. Run the official rootless setup tool
dockerd-rootless-setuptool.sh install

# 3. Export Docker host environment variable in your profile
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
```

Then run `dgrunner doctor` to verify rootless isolation.

### Handling Session Conflicts

If you manually kill or restart the runner, GitHub's broker server may hold the previous session open for 30–60 seconds, resulting in:
```text
A session for this runner already exists.
Runner connect error: Error: Conflict. Retrying until reconnected.
```
This is expected behavior from GitHub Actions. The runner will automatically retry and reconnect as soon as GitHub drops the stale session. Alternatively, run `dgrunner restart`.

---

## 🚀 CI/CD & npm Trusted Publishing

`@upstand/dgrunner` comes with pre-configured GitHub Actions workflows implementing **npm Trusted Publishing (OIDC)** and cryptographic package provenance:

- **Continuous Integration ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))**:
  - Runs on every push and PR across **Ubuntu** and **Windows** on Node.js **22.x and 24.x**.
  - Enforces strict typechecks, unit tests, bundle builds, and npm package integrity validation (`npm pack --dry-run`).

- **Automated Release & Publishing ([`.github/workflows/release.yml`](.github/workflows/release.yml))**:
  - Triggers when a matching semver git tag is pushed (for example, `v2.0.0`).
  - Tests and builds the package before a separate least-privilege npm OIDC publish job publishes the verified tarball with provenance. No static npm token is used.
  - Creates the GitHub Release only after npm publishing succeeds and attaches the package tarball.

### Setting up npm Trusted Publisher (OIDC)

To configure npm to publish without static tokens:
1. Log into your account on [npmjs.com](https://www.npmjs.com).
2. Go to package `@upstand/dgrunner` (or create it under `@upstand`).
3. Click **Settings** ➔ **Publishing Access** ➔ **Add Publishing Access** ➔ **GitHub Actions**.
4. Set the repository name (`UpstandPlatform/dgrunner`) and specify the workflow file name (`release.yml`).
5. The release workflow checks that the pushed tag matches `package.json`, then publishes the verified package with provenance.

---

## 💻 Development & Testing

```bash
# Run TypeScript type check
npm run typecheck

# Run Vitest test suite
npm test

# Build bundled distribution
npm run build
```

---

## 📄 License

[MIT](LICENSE)
