# Troubleshooting ArchWeave in Docker

Start with what the container says:

```sh
docker compose … ps                       # state and health
docker compose … logs --tail 50 archweave
curl -sS http://localhost:<port>/api/health
```

## The image does not pull

- `denied` or `unauthorized`: the package is private or the registry wants a login. `docker login ghcr.io` with a GitHub user and a token that has `read:packages`.
- `manifest unknown` or `not found`: no such tag. Check the version (no `v` prefix). An unpublished version can be built locally, see "Run an image that is not published" in the configuration reference.
- `no matching manifest for linux/…`: images are built for `linux/amd64` and `linux/arm64` only.

## The container does not start or keeps restarting

- `port is already allocated`: another process holds the host port. Choose another port (configuration reference).
- `EACCES` or `permission denied` on `/repo/.archweave`: the container user may not write there. On Linux set `ARCHWEAVE_UID`/`ARCHWEAVE_GID` in `.env` to `id -u`/`id -g` and fix existing files with `sudo chown -R "$(id -u):$(id -g)" .archweave`. With rootless Docker or Podman the container's root is your own user: set both to `0`.
- `Cannot load the model in /repo/.archweave: …`: `model.json` or `layout.json` is invalid JSON or has broken references (unknown ids, containment cycles), usually after a Git merge. The message lists the problems. Fix the file, or take one side with `git checkout --ours/--theirs .archweave/model.json`, then start again.
- The repository is not mounted (`/repo` empty): the Compose file must sit in the repository root, since `./` in `volumes:` is relative to the file.

## The browser or the agent gets 403

`Host "…" is not allowed` or `Origin "…" is not allowed`: ArchWeave was reached under a name other than localhost. Add that hostname to `ARCHWEAVE_ALLOWED_HOSTS`.

## Claude Code has no ArchWeave tools

- MCP servers load when a session starts: start a new session in the repository.
- `.mcp.json` servers need approval once. If it was declined, `claude mcp reset-project-choices` asks again.
- `/mcp` shows the connection state. The URL there must use the same port as the Compose file, and `/api/health` must answer.

## Other symptoms

- "Open in editor" links point to the wrong place: Compose was started from another directory, so `${PWD}` was wrong. Set `ARCHWEAVE_HOST_REPO_PATH` to the repository's absolute path.
- A `git pull` changed the model but the UI did not update: the reloaded file was invalid and was ignored; the log says why.
