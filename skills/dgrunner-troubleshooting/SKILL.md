---
name: dgrunner-troubleshooting
description: Use when diagnosing dgrunner setup or GitHub Actions self-hosted runner failures, especially jobs failing before checkout, Docker runner tool-cache permission errors, offline runners, and confusing runner-host versus VPS failures.
---

# Troubleshoot dgrunner and runner jobs

First identify where the failing process runs: the Windows/Linux machine that hosts dgrunner, the Linux runner container, a GitHub-hosted runner, or a separate VPS deployment target. Do not run a permission repair on the VPS unless the failing path is actually on the VPS.

## Classify the failure stage

1. Read the first runner error, not only later retry or disconnect messages. If the job failed before checkout, no checkout, build, or deployment workflow command ran. Later broker reconnect messages can be a consequence of a failed job rather than its cause.
2. Check the run's assigned runner, runner state, `runs-on` labels, and the exact failing path. A path like `/home/runner/_work/_tool` belongs to a Linux runner environment; determine whether it is inside the local Docker runner or a native Linux runner before changing ownership.
3. Collect read-only diagnostics first:

~~~bash
dgrunner doctor
dgrunner status
dgrunner ps
dgrunner logs --follow
~~~

For the default Docker runner on the local host:

~~~bash
docker ps --filter name=upstand-dgrunner-linux
docker logs --tail 100 upstand-dgrunner-linux
docker inspect --format '{{json .Mounts}}' upstand-dgrunner-linux
docker exec --user runner upstand-dgrunner-linux sh -lc 'id; test -w /home/runner/_work && test -w /home/runner/_work/_tool && echo writable'
~~~

An isolated named volume for that runner is mounted at `/home/runner/_work` inside the container. It persists across container restarts and is cleared when the runner is re-registered or removed. Do not inspect or repair a host `/home/runner` path unless the runner is actually native Linux on that host. Redact registration tokens, credentials, and secrets before sharing logs.

## Repair confirmed Docker work-volume ownership problems

Only after the checks show the runner account cannot write to the mounted volume, ensure the runner is idle, then repair the volume from the machine running Docker:

~~~bash
docker exec --user root upstand-dgrunner-linux chown -R runner:runner /home/runner/_work
docker exec --user root upstand-dgrunner-linux install -d -o runner -g runner -m 0755 /home/runner/_work /home/runner/_work/_tool
docker exec --user runner upstand-dgrunner-linux sh -lc 'test -w /home/runner/_work && test -w /home/runner/_work/_tool && echo writable'
~~~

The current dgrunner Docker startup also repairs ownership of this named work volume when it starts. If permissions remain incorrect after verifying the account and volume, inspect container/image overrides and actual mount source before applying broader changes. Never use chmod 777, and do not recursively change ownership outside /home/runner/_work.

## Repair a native Linux runner's work directory

The service account must come from the actual runner process; do not assume it is named runner. On the native Linux runner host, inspect:

~~~bash
sudo systemctl list-units --type=service --all | grep 'actions.runner'
ps -eo user,group,pid,args | grep '[R]unner.Listener'
namei -l /home/runner/_work/_tool
~~~

After confirming the account and group, create/fix only the required directories with that identity:

~~~bash
RUNNER_USER='<confirmed-service-account>'
RUNNER_GROUP='<confirmed-service-group>'
sudo install -d -o "$RUNNER_USER" -g "$RUNNER_GROUP" -m 0755 /home/runner/_work /home/runner/_work/_tool
~~~

If existing work files have another owner, first assess what is in the work directory and then correct ownership only within that runner's work tree. Do not apply this Linux-host repair to a Windows-hosted Docker container or to the VPS just because the deployment target is Linux.

## Verify and retry safely

After the permission repair, verify both paths are writable as the runner account, then confirm the runner is online and idle in GitHub. Retry the failed job (or a dry-run job) once. If the failure moves past checkout, diagnose the new first failure separately: missing tools such as pwsh, Docker Compose, or Buildx are runner image/host dependencies, not work-directory permissions. Keep deployment commands out of the diagnosis until the deployment step actually runs.
