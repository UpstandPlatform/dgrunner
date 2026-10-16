---
name: dgrunner-setup
description: Use when installing or configuring @upstand/dgrunner, choosing a Windows, Docker, WSL, or native Linux runner, registering it with GitHub, or preparing a repository to use the runner.
---

# Set up dgrunner

Use this skill to configure the `@upstand/dgrunner` CLI as a self-hosted GitHub Actions runner. `dgrunner` manages the runner host; it does not deploy an application to a VPS by itself.

## Establish the intended runner environment

1. Inspect the repository's workflow `runs-on` values and required tools. Match the runner OS and labels to the jobs. A Docker runner executes Linux jobs; Windows native mode is for Windows-specific jobs; WSL runs within the selected Linux distribution.
2. Confirm Node.js `>=22.14.0`, Git, network access to GitHub, and Docker when Docker mode is selected. Run the setup from an unprivileged user account. On Linux, prefer rootless Docker where available.
3. Explain that Windows native mode runs as a background process and does not auto-start after sign-out or reboot. Docker mode uses a persistent named work volume and restarts its container unless stopped.

## Install and preflight

Use one of the documented package commands:

~~~bash
npm install -g @upstand/dgrunner
dgrunner doctor
~~~

Or avoid a global installation:

~~~bash
npx @upstand/dgrunner doctor
~~~

Resolve `doctor` failures before setup. `--force` bypasses critical safety checks and should only be used when the operator understands and accepts the specific reported risk.

## Register the runner

1. Ask the operator to create a short-lived runner registration token in the target private GitHub repository or organization settings. Do not request a personal access token.
2. Prefer the interactive `dgrunner setup` wizard. It prompts for the registration token using hidden input. Do not put tokens in shell commands, scripts, logs, or workflow files because shell history and process listings can expose them. Native runner configuration briefly passes the token to GitHub's configuration process as an argument; Docker configuration sends it over stdin.
3. Choose the mode explicitly when it prevents ambiguity:

~~~bash
dgrunner setup --env docker --distro ubuntu-24.04
dgrunner setup --env windows
dgrunner setup --env native
dgrunner setup --env wsl --distro Ubuntu-24.04
~~~

The `native` and `wsl` modes are Linux targets. On Windows, `--env docker` provisions a Linux runner container. Docker supports `--image` for custom images and `--docker-socket` only when a workflow truly needs to control the host Docker daemon. Access to the Docker socket grants powerful host-level control; it is not enabled by default.

4. Use default labels unless the workflows require custom labels. If custom labels are needed, ensure every corresponding workflow `runs-on` label matches exactly. Do not omit `self-hosted` when explicitly specifying labels.
5. Keep self-hosted runners limited to trusted private repositories or trusted organizations. Do not execute pull-request code from public forks on a machine with secrets, internal network access, or valuable local data.

## Verify setup

Run:

~~~bash
dgrunner status
dgrunner ps
~~~

Confirm GitHub Settings → Actions → Runners shows the expected runner as online with the labels used by the workflow. To generate an example integration workflow, use `dgrunner guide --generate-workflow`, then review its triggers, permissions, and `runs-on` labels before committing it.

If the runner job fails before checkout, use the dgrunner-troubleshooting skill to identify whether the failing machine is the runner host, its Docker container, or a later deployment target.
