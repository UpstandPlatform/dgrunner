# dgrunner 🚀

> **Transform any PC + Docker into a hardened, persistent self-hosted GitHub Actions runner with pre-flight security validation, service management, and automated test workflows.**

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
- [Quick Start Guide](#-quick-start-guide)
- [CLI Command Reference](#-cli-command-reference)
  - [`dgrunner doctor`](#dgrunner-doctor)
  - [`dgrunner setup`](#dgrunner-setup)
  - [`dgrunner status`](#dgrunner-status)
  - [`dgrunner start` / `stop` / `restart`](#dgrunner-start--stop--restart)
  - [`dgrunner remove`](#dgrunner-remove)
  - [`dgrunner guide`](#dgrunner-guide)
- [Verifying Your Runner on GitHub](#-verifying-your-runner-on-github)
- [Platform-Specific Notes & Troubleshooting](#-platform-specific-notes--troubleshooting)
  - [Windows: Git Bash vs. WSL bash](#windows-git-bash-vs-wsl-bash)
  - [Linux: Rootless Docker Setup](#linux-rootless-docker-setup)
  - [Handling Session Conflicts](#handling-session-conflicts)
- [Development & Testing](#-development--testing)
- [License](#-license)

---

## 💡 Why dgrunner?

Self-hosting GitHub Actions runners gives you bare-metal speed, custom hardware/GPU access, and zero compute minute limits. However, running arbitrary CI/CD code on personal workstations or company machines poses severe security risks if misconfigured.

`dgrunner` solves this by automating:
- **Pre-flight security audits** before any binary is installed.
- **Automated package integrity verification** (SHA-256 validation against official GitHub releases).
- **Persistent OS background service integration** across Linux and Windows.
- **Docker integration** with rootless isolation checks.
- **Automated verification workflows** to validate host, container, and security boundaries.

---

## 🔒 Security Model & Guardrails

GitHub explicitly advises against using self-hosted runners on public repositories because pull requests from public forks can execute arbitrary code on the runner machine. `dgrunner` enforces strict security boundaries:

1. **Private Repositories & Internal Organizations Only**
   - The CLI guides you exclusively through private repository and organization setup.
2. **Unprivileged Execution**
   - Refuses root execution on Linux (`UID 0`) and checks user isolation on Windows.
3. **Rootless Docker Enforcement on Linux**
   - Workflows with Docker access can easily compromise a host root filesystem if Docker runs in root mode. `dgrunner` audits and enforces rootless Docker (`dockerd-rootless-setuptool.sh`).
4. **Binary Tamper Protection (SHA-256)**
   - All runner binaries are downloaded directly from official GitHub releases and cryptographically verified against official SHA-256 checksums before extraction.
5. **Ephemeral Secrets**
   - Short-lived runner registration and removal tokens are entered via masked password prompts, used only in memory during configuration, and never logged or persisted to disk.
6. **Filesystem Permission Hardening**
   - Directories and local metadata files are created with restricted POSIX permissions (`0700` / `0600`).

---

## 📦 Prerequisites

Before setting up a runner, ensure your system has:

| Dependency | Minimum Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>= 18.0.0` | Tested on Node.js 18, 20, 22, and 25 |
| **Git** | `>= 2.25.0` | Required for checkout steps (Git for Windows on Windows) |
| **Docker** | Engine / Desktop | Docker Desktop (Windows) or Rootless Docker (Linux) |
| **Operating System** | Linux / Windows | Linux (`x64`, `arm64`) or Windows (`x64`) |

---

## 📥 Installation

You can install and use `dgrunner` in three ways:

### 1. Global Installation (Recommended)

Install `dgrunner` globally on your machine using npm:

```bash
npm install -g dgrunner
```

Once installed globally, you can invoke the CLI from any terminal directory:

```bash
dgrunner --help
dgrunner doctor
```

To update to the latest version:
```bash
npm update -g dgrunner
```

To uninstall:
```bash
npm uninstall -g dgrunner
```

---

### 2. Zero-Install via npx

Run the latest release directly without installing it globally:

```bash
# Launch interactive wizard
npx dgrunner

# Run diagnostics
npx dgrunner doctor

# View integration guide
npx dgrunner guide
```

---

### 3. Install from Source

If you want to contribute, modify, or inspect the codebase locally:

```bash
# 1. Clone the repository
git clone https://github.com/mhbdev/dgrunner.git
cd dgrunner

# 2. Install dependencies
npm install

# 3. Build the CLI bundle
npm run build

# 4. Link globally (makes 'dgrunner' available in terminal)
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
- `dgrunner` will download the official runner, verify its SHA-256 hash, register it with GitHub, and launch the background service.

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
- Docker engine availability and daemon responsiveness.
- Docker rootless mode audit on Linux.
- Unauthenticated remote Docker TCP socket check.
- GitHub HTTPS API reachability and latency.
- Free disk space availability.

```bash
dgrunner doctor
dgrunner doctor --strict        # Exits with code 1 if warnings or errors exist
dgrunner doctor --dir ~/runner  # Check specific installation path
```

---

### `dgrunner setup`
Full automated setup or scripted unattended setup via flags:

```bash
# Interactive wizard (default when flags are omitted)
dgrunner setup

# Scripted / Unattended setup
dgrunner setup \
  --url https://github.com/owner/repo \
  --token <REGISTRATION_TOKEN> \
  --name my-workstation \
  --labels self-hosted,dgrunner,gpu \
  --dir ~/.dgrunner/actions-runner
```

**Options:**
- `-u, --url <url>`: Target GitHub repository or organization URL.
- `-t, --token <token>`: GitHub Actions registration token.
- `-n, --name <name>`: Custom runner name (defaults to `<hostname>-dgrunner`).
- `-l, --labels <labels>`: Comma-separated custom labels (e.g. `self-hosted,dgrunner,gpu`).
- `-d, --dir <path>`: Runner installation directory (defaults to `~/.dgrunner/actions-runner`).
- `--force`: Bypass critical pre-flight failures at your own risk.
- `--no-service`: Configure without immediately starting the persistent background service.

---

### `dgrunner status`
Inspects installed runner metadata, configuration, and background service state:

```bash
dgrunner status
```

**Sample Output:**
```text
=== dgrunner Status Dashboard ===

┌─ RUNNER STATUS ────────────────────────────────────────────┐
│ Installed:   Yes                                           │
│ Configured:  Yes                                           │
│ Runner Name: dordoone-runner                               │
│ Target URL:  https://github.com/mhbdev/dordoone            │
│ Labels:      self-hosted, dgrunner, windows, x64           │
│ Service:     Active & Running (PID: 48080)                 │
│ Directory:   C:\Users\username\.dgrunner\actions-runner    │
└─────────────────────────────────────────────────────────────┘
```

---

### `dgrunner start` / `stop` / `restart`
Manages the lifecycle of the persistent runner daemon:

```bash
# Start the runner service in the background
dgrunner start

# Gracefully stop the runner service
dgrunner stop

# Restart the runner service
dgrunner restart
```

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
