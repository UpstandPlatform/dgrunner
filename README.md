# dgrunner 🚀

> **Turn your PC + Docker into a secure, persistent self-hosted GitHub Actions runner with pre-flight security checks, service management, and step-by-step verification.**

Built with TypeScript and [Commander](https://www.npmjs.com/package/commander).

---

## 🔒 Security Principles

GitHub strongly advises against using self-hosted runners with public repositories because pull requests from forks can execute arbitrary code on the runner machine. `dgrunner` is built around rigorous security best practices:

- **Private Repositories & Internal Orgs Only**: Designed exclusively for trusted private repositories and organizations.
- **Unprivileged Execution**: Enforces non-root user execution on Linux and standard user permissions on Windows.
- **Rootless Docker Enforcement**: On Linux, pre-flight checks enforce rootless Docker so workflow containers cannot access or compromise host root.
- **Package Integrity Verification**: Downloads official GitHub Actions runner packages and verifies their SHA-256 checksum before extracting.
- **Ephemeral Credentials**: Short-lived runner registration tokens are accepted securely via masked input, used immediately for registration, and never written to logs or persistent config files.
- **Restricted Filesystem Permissions**: Local directories and metadata are created with restricted permissions (`0700` / `0600`).

---

## 📦 Prerequisites

1. **Operating System**: Linux (`x64`, `arm64`) or Windows (`x64`).
2. **Node.js**: `v18.0.0` or higher.
3. **Git**: Installed and available in system PATH.
4. **Docker**: Docker Desktop (Windows) or Rootless Docker (Linux).

---

## ⚡ Quick Start

### 1. Run Pre-flight Checks

Ensure your machine and Docker daemon meet all security and system prerequisites:

```bash
npx dgrunner doctor
```

### 2. Interactive Setup Wizard

Running `dgrunner` with no arguments launches the guided interactive setup wizard:

```bash
npx dgrunner
```

The wizard will:
1. Run pre-flight security checks.
2. Prompt for your repository or organization URL.
3. Securely prompt for your short-lived registration token.
4. Download and SHA-256 verify the official runner package.
5. Register the runner with GitHub Actions.
6. Install and start the background persistent service.
7. Offer to automatically generate `.github/workflows/verify-runner.yml`.

---

## 🛠️ CLI Commands

```text
Usage: dgrunner [options] [command]

Secure self-hosted GitHub Actions runner CLI with Docker

Options:
  -V, --version      output the version number
  -h, --help         Display help for command

Commands:
  doctor [options]   Run pre-flight security, dependency, and environment checks
  setup [options]    Set up, configure, and start the self-hosted GitHub Actions runner
  status [options]   Check status of the installed runner and background service
  start [options]    Start the persistent runner background service
  stop [options]     Stop the persistent runner background service
  restart [options]  Restart the persistent runner background service
  remove [options]   Unregister and remove the GitHub Actions runner from GitHub
  guide [options]    View step-by-step GitHub runner installation and integration guides
```

### Command Details

#### `dgrunner doctor`
Runs comprehensive checks for platform support, user privileges, Git, Docker daemon accessibility, Docker rootless/socket security, GitHub API reachability, and disk space.
```bash
dgrunner doctor [--strict] [--dir <path>]
```

#### `dgrunner setup`
Full automated setup or scripted unattended setup via CLI flags:
```bash
dgrunner setup \
  --url https://github.com/my-org/my-private-repo \
  --token <SHORT_LIVED_TOKEN> \
  --name my-workstation-runner \
  --labels self-hosted,dgrunner,gpu
```

#### `dgrunner status`
Inspects installed runner metadata, configuration, and background service state.
```bash
dgrunner status
```

#### `dgrunner start` / `stop` / `restart`
Controls the persistent background runner service on the host machine.
```bash
dgrunner start
dgrunner stop
dgrunner restart
```

#### `dgrunner remove`
Unregisters the runner from GitHub Actions and tears down local services using a short-lived removal token.
```bash
dgrunner remove
```

#### `dgrunner guide`
Displays colorized terminal instructions on how to navigate GitHub settings to retrieve tokens and configure repositories safely:
```bash
# View terminal integration guide
dgrunner guide

# Generate ready-to-test verification workflow
dgrunner guide --generate-workflow
```

---

## 🧪 Testing Your Runner on GitHub

Generate the verification workflow file:
```bash
dgrunner guide --generate-workflow
```

This creates `.github/workflows/verify-runner.yml` in your project with 3 automated test jobs:
1. **Host Verification**: Prints hostname, current user, OS information, and workspace directory.
2. **Docker Container Execution**: Executes a test container (`alpine:latest`) to verify host Docker engine access.
3. **Security Boundaries**: Verifies non-root execution and container namespace isolation.

Push this workflow to your private repository:
```bash
git add .github/workflows/verify-runner.yml
git commit -m "ci: verify self-hosted runner"
git push
```

---

## 📜 Development & Testing

```bash
# Install dependencies
npm install

# Run type check
npm run typecheck

# Run unit tests
npm test

# Build bundle
npm run build
```

---

## 📄 License

MIT
