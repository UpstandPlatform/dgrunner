# dgrunner Implementation and Security Audit

**Audit date:** 2026-11-07  
**Scope:** CLI setup and lifecycle flows, Windows startup readiness, Docker runners and volumes, runner process detection, metadata storage, Linux service installation, archive download/extraction, workflow generation, update handling, Windows/WSL isolation warnings, and package checks.

## Summary

The audit found and fixed issues in Docker ownership checks, persistent-volume cleanup, process identification, token handling, workflow-file replacement, directory permissions, setup validation, and native runner startup readiness. The implementation now bounds downloaded archives and captured subprocess output, validates runner inputs before execution, writes metadata atomically with restricted permissions, and reports service/lifecycle failures instead of claiming success.

## Findings fixed

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | Docker lifecycle operations trusted container names, and cleanup could remove a workspace volume without proving dgrunner ownership. | Lifecycle commands now verify management labels and, when local metadata exists, the runner name and URL. Workspace volumes require matching dgrunner ownership labels before replacement or removal. Unlabeled volumes are retained. See [docker-runner.ts](src/core/docker-runner.ts#L91) and [docker-runner.ts](src/core/docker-runner.ts#L153). |
| P1 | Process discovery could treat an unrelated process mentioning `Runner.Listener` in its arguments as the runner and signal it. | Windows and Linux process checks use executable identity; macOS checks the executable path through `lsof`. Unsupported POSIX platforms no longer guess from command-line text. See [runner-manager.ts](src/core/runner-manager.ts#L915). |
| P2 | Native runner configuration and removal exposed the short-lived GitHub token in child command-line arguments. | Tokens are supplied through the runner's `ACTIONS_RUNNER_INPUT_TOKEN` input environment variable. Docker obtains the token over stdin before setting that variable. The runner consumes and clears its input variables during command setup, as implemented in the [official runner source](https://github.com/actions/runner/blob/main/src/Runner.Listener/CommandSettings.cs). |
| P2 | Forced workflow generation could write through a symlink or hard link, and directory symlinks could place generated files outside the project. | The generator checks resolved directory boundaries, rejects non-regular targets, and replaces files atomically. See [guide.ts](src/core/guide.ts#L151). |
| P2 | POSIX data directories and runner metadata could retain unsafe permissions, and subprocess/download output could grow without bound. | POSIX directory permissions are enforced or setup fails; metadata uses atomic mode-0600 writes; captured stdout/stderr are capped at 1 MiB each; runner archives are capped at 512 MiB. See [fs.ts](src/utils/fs.ts#L10), [exec.ts](src/utils/exec.ts#L15), and [runner-installer.ts](src/core/runner-installer.ts#L25). |
| P2 | Linux service installation depended on runner-provided service scripts with elevated operations and could leave partial units. | dgrunner writes a fixed systemd unit, validates marker and working-directory identity before lifecycle operations, and cleans up failed installs. See [linux-service.ts](src/core/linux-service.ts#L123). |
| P2 | Setup accepted invalid or inconsistent target, URL, token, runner-name, label, image, and container inputs too late in the flow. | Validation is centralized and runs before downloads or external commands. Default setup labels and runner names are now computed once. |
| P2 | Starting a missing or incomplete native runner could proceed into environment preparation and fail with an unhelpful missing-file error. | `start` and `run` now check that the runner is installed and configured before writing `.path` or launching it, and print setup guidance for missing files. `dgrunner doctor` also warns that native Windows and WSL jobs are not per-job sandboxes. |

## Remaining operational risks

- A self-hosted runner executes workflow code with the runner account's access to the host and its persistent data. Use repositories and workflows you trust; GitHub warns against using self-hosted runners for public repositories because untrusted pull requests can compromise the machine ([GitHub security guidance](https://docs.github.com/en/actions/reference/security/secure-use)).
- Windows native and WSL runners are not per-job sandboxes. Native jobs inherit the Windows runner account's access; WSL jobs can also reach Windows resources through [default drive mounts](https://learn.microsoft.com/en-us/windows/wsl/filesystems) and [interoperability](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop). Use a disposable VM for untrusted workflow code. dgrunner currently reports this risk but does not provision Windows Sandbox or ephemeral WSL workers.
- Supplying `--token` can expose the value in the dgrunner process arguments and shell history. The hidden prompt avoids that exposure. Token values are not persisted by dgrunner.
- Docker ownership labels prevent accidental operations against unrelated containers and volumes; anyone with Docker daemon control can alter labels and already has powerful host access. Mounting `/var/run/docker.sock` gives workflows Docker-host-level control.
- `--force` intentionally permits setup after critical doctor failures, including running on Linux as root. The doctor output should be treated as a real security warning.
- Existing unlabeled Docker volumes are left untouched. Old or orphaned data may require manual inspection and cleanup.

## Verification and limits

- `npm test`: **137 tests passed** across 13 files.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm audit`: **0 vulnerabilities**.
- `npm run check:skills`, package-version verification, package dry-run, CLI help/version smoke checks, and `git diff --check`: passed.
- Tests exercise mocked setup, Docker, service, filesystem, update, and process-management flows. This audit did not register a live runner with GitHub or run systemd, WSL, or a Docker daemon end to end; those require host services and credentials. Linux/macOS-specific process and permission cases are covered with unit tests or platform simulation, but were not executed on those operating systems in this Windows workspace.
