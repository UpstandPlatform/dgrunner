---
name: dgrunner-operations
description: Use when an agent needs to inspect, start, stop, restart, monitor, update, or safely remove an existing dgrunner-managed GitHub Actions runner or match it to workflow labels.
---

# Operate dgrunner

dgrunner controls a registered self-hosted GitHub Actions runner. It is separate from the workflow's build or deployment commands. Identify the configured runner mode and installation directory before taking action.

## Inspect before changing state

~~~bash
dgrunner status
dgrunner ps
dgrunner doctor
~~~

Check the runner's online/busy state in GitHub Settings → Actions → Runners. Do not restart a busy runner or interrupt a production deployment. Confirm workflow `runs-on` labels match the runner labels; custom labels must match exactly.

## Lifecycle commands

~~~bash
dgrunner start
dgrunner stop
dgrunner restart
dgrunner run
dgrunner logs --follow
~~~

Use `dgrunner run` to attach in the foreground and stream runner output. Use `dgrunner logs --follow` to follow logs; in Docker mode this streams the container logs. The `start`, `stop`, `restart`, `run`, `ps`, and `status` commands accept `--dir <path>`; `doctor` accepts `--dir <base-path>`. On Docker mode, the CLI manages the container recorded in local dgrunner metadata. The default container name is `upstand-dgrunner-linux`; each runner uses an isolated workspace volume that persists across container restarts and is cleared when the runner is re-registered or removed.

For Docker diagnostics, read the container logs and inspect its mounts:

~~~bash
docker logs --tail 100 upstand-dgrunner-linux
docker inspect --format '{{json .Mounts}}' upstand-dgrunner-linux
~~~

The Docker socket is not mounted unless setup used `--docker-socket`. It gives workflow code control of the host Docker daemon, so do not add it just to fix ordinary runner permission or tool-cache errors.

## Update and unregister

For a global npm installation, update with:

~~~bash
npm update -g @upstand/dgrunner
~~~

Or use the package's upgrade command:

~~~bash
dgrunner upgrade --check
dgrunner upgrade
~~~

Unregistering is destructive to the GitHub registration. Explain the impact and verify the target runner before using `dgrunner remove`. The command can prompt for a short-lived removal token; never write that token to source, logs, or shell history. Use `--yes` only when the operator explicitly requested a non-interactive removal.

## Keep workflows trusted

Before adding jobs to a self-hosted runner, verify the repository and event sources are trusted. Do not schedule untrusted fork pull requests on the runner. A successful runner status only confirms runner connectivity; it does not prove the runner has deployment tools, correct permissions, or a safe trust boundary. Diagnose missing tools on the runner image/host and keep deployment actions in their own workflow steps.
