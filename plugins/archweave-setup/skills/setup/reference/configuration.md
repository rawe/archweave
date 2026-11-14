# Configuring ArchWeave in Docker

Change one thing at a time, then run `docker compose … up -d` (Compose recreates the container when its configuration changed) and check `http://localhost:<port>/api/health`. Whenever the port or host in the MCP URL changes, update `.mcp.json` too and tell the user to start a new Claude Code session.

## Settings

| Setting | Where | Default | Meaning |
| --- | --- | --- | --- |
| Image and version | `image:` or `ARCHWEAVE_IMAGE` | pinned tag | `ARCHWEAVE_IMAGE` overrides the whole image reference, for a one-off try. |
| Host port | left side of `ports:` | `4317` | The port in the UI address and in `.mcp.json`. The container side stays 4317. |
| File owner | `ARCHWEAVE_UID`, `ARCHWEAVE_GID` in `.env` | `1000` | User and group that write `.archweave/`. Linux only. |
| `ARCHWEAVE_DATA_DIR` | `environment:` | `/repo/.archweave` | Model storage. Keep it under `/repo` so the model is versioned with the code. |
| `ARCHWEAVE_HOST_REPO_PATH` | `environment:` | `${PWD}` | Absolute repository path on the host, for "open in editor" links. |
| `ARCHWEAVE_ALLOWED_HOSTS` | `environment:` | unset | Comma-separated extra hostnames accepted in `Host` and `Origin` headers. Localhost names are always accepted. |

The image sets `HOST=0.0.0.0` and `PORT=4317` inside the container; leave those alone and change the port mapping instead.

## Upgrade or pin another version

1. Change the tag in `image:` (`ghcr.io/rawe/archweave:<version>`, without `v`). Pre-release versions such as `0.2.0-beta.1` never become `latest`.
2. `docker compose … pull && docker compose … up -d`
3. Check that `/api/health` reports the new `version`.

The model format is plain JSON in `.archweave/`; commit it before upgrading so a downgrade is a `git checkout` away.

## Change the port

Edit the left side of `ports:` and the URL in `.mcp.json`, run `up -d`, start a new Claude Code session. Every repository that runs ArchWeave on the same machine needs its own port.

## Run an image that is not published

From an ArchWeave checkout, `make release VERSION=<version>` builds `ghcr.io/rawe/archweave:<version>` into the local Docker daemon; Compose then uses it without pulling. Use `pull_policy: never` on the service if Compose should never try the registry for it.

## Reach ArchWeave from somewhere other than localhost

ArchWeave has no authentication: whoever reaches the port can read the repository's files through it and change the model. Only do this when the user asks, and say so.

- **Another container** (an agent in a dev container, a CI job): put both on one Docker network and use `http://archweave:4317/mcp`, with `ARCHWEAVE_ALLOWED_HOSTS: archweave`. No host port is needed for that path.
- **The host from inside a container**: use `http://host.docker.internal:<port>/mcp`, with `ARCHWEAVE_ALLOWED_HOSTS: host.docker.internal`. Docker Desktop reaches the default loopback binding. On Linux the client container needs `extra_hosts: ["host.docker.internal:host-gateway"]`, and ArchWeave must also be published on the bridge address (`"172.17.0.1:4317:4317"`), since loopback is not reachable from containers.
- **Another machine**: publish on that interface (`"0.0.0.0:4317:4317"` for all) and add the name the browser uses to `ARCHWEAVE_ALLOWED_HOSTS`. Prefer an SSH tunnel (`ssh -L 4317:localhost:4317 <host>`), which needs no change at all.

## Stop or remove

`docker compose … down` stops and removes the container. The model stays in `.archweave/`. To remove ArchWeave from the repository, also delete the Compose file (or its service), the `archweave` entry in `.mcp.json` and, if the user wants the model gone, `.archweave/`.
