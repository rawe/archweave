---
name: setup
description: Set up ArchWeave in the current repository, or change, upgrade or repair an existing setup. Writes a Docker Compose file that runs the ArchWeave image from the GitHub Container Registry, starts it, checks its health and registers its MCP server for Claude Code in .mcp.json. Use when the user wants to install, run, start, configure, upgrade or troubleshoot ArchWeave, or asks for ArchWeave's Docker Compose file or MCP connection.
argument-hint: "[version]"
---

# Set up ArchWeave

ArchWeave runs as one container next to the code it models. It mounts the repository at `/repo`, keeps its model in `.archweave/` in the repository, and serves the UI and the MCP endpoint on one port. The end state of this skill:

- a Compose file in the repository root that runs a pinned `ghcr.io/rawe/archweave` image,
- the container running and healthy,
- `.mcp.json` registering the `archweave` MCP server for Claude Code.

Work through the steps in order. Run commands from the repository root (`git rev-parse --show-toplevel`). Do not commit anything unless the user asks.

If ArchWeave is already set up here and the user wants a change (port, version, remote access, user ids), read [reference/configuration.md](reference/configuration.md) and make only that change. If something fails, read [reference/troubleshooting.md](reference/troubleshooting.md).

## 1. Check the prerequisites

```sh
docker compose version && docker info --format '{{.ServerVersion}}'
```

Both must succeed: Docker with Compose v2, and a running daemon. If not, stop and tell the user to install or start Docker (Docker Desktop on macOS and Windows, Docker Engine with the Compose plugin on Linux). There is no other supported way to run the published image.

## 2. Look at what is already there

- A Compose file in the root: `docker-compose.yml`, `docker-compose.yaml`, `compose.yml` or `compose.yaml`. If one already has a service running `ghcr.io/rawe/archweave`, ArchWeave is set up: start it if it is not running (step 6), verify it (steps 6 and 7), or make the change the user asked for.
- `.archweave/model.json`: an existing model. Keep it; ArchWeave picks it up.
- `.mcp.json`: other MCP servers you must keep.

## 3. Pick the version

Pin a concrete version so every developer runs the same server. Use the version the user named (`$ARGUMENTS`, without a leading `v`). Otherwise resolve the current release:

```sh
docker pull ghcr.io/rawe/archweave:latest
docker image inspect ghcr.io/rawe/archweave:latest --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
```

When the pull fails but the image exists locally (a local build, see the configuration reference), read the label from the local image and go on. Otherwise see "The image does not pull" in the troubleshooting reference.

## 4. Pick the port

Use 4317 unless something already listens there, typically ArchWeave for another repository:

```sh
nc -z 127.0.0.1 4317 && echo "4317 is taken"
```

If it is taken, try 4318, 4319 and so on. Use the chosen port wherever this skill says 4317, except on the container side of the port mapping. The same port goes into the Compose file and `.mcp.json`, and every developer on the project uses it, so choose it once.

## 5. Write the Compose file

Start from [docker-compose.yml](docker-compose.yml) next to this skill. Replace `VERSION` with the version from step 3 and, if you chose another port, the `4317` in the header comments and the left `4317` in `ports` (the container side stays 4317). Keep the comments; they are the documentation for the next reader.

Where to put it:

- No Compose file in the root: write `docker-compose.yml`. Start command: `docker compose up -d`.
- A Compose file exists (the project's own services): ask the user which they prefer.
  - Recommended: a separate `archweave.compose.yml` in the root. Add `name: <repository directory name>-archweave` as its first key, below the header comment, so it does not share a Compose project with the application and `--remove-orphans` on either never removes the other's containers. Start command: `docker compose -f archweave.compose.yml up -d`.
  - Or add the `archweave` service to the existing file. Start command: `docker compose up -d archweave`.

The volume `./:/repo` assumes the file sits in the repository root. Keep the port bound to `127.0.0.1`: ArchWeave has no authentication.

## 6. Match the file owner and start

On Linux the container writes `.archweave/` as `ARCHWEAVE_UID:ARCHWEAVE_GID` (default 1000:1000). If `id -u` or `id -g` differs, add the user's ids to `.env` next to the Compose file (Compose reads it automatically; create it if missing, append otherwise):

```sh
printf 'ARCHWEAVE_UID=%s\nARCHWEAVE_GID=%s\n' "$(id -u)" "$(id -g)" >> .env
```

Tell the user if `.env` is tracked by Git, since the ids are personal. On macOS and Windows, Docker Desktop maps ownership and nothing is needed.

Create the data directory as the user, then start:

```sh
mkdir -p .archweave
docker compose up -d        # or the start command from step 5
```

Wait until the server is healthy (up to about 30 seconds on the first start):

```sh
for i in $(seq 1 30); do curl -fs http://localhost:4317/api/health && break; sleep 1; done
```

The answer is `{"status":"ok","version":"…","revision":…}`. If it never comes, run `docker compose logs --tail 50 archweave` and use the troubleshooting reference.

## 7. Connect Claude Code

Add the server to `.mcp.json` in the repository root, keeping every other entry:

```json
{
  "mcpServers": {
    "archweave": { "type": "http", "url": "http://localhost:4317/mcp" }
  }
}
```

Check that the endpoint answers MCP (expect a result whose `serverInfo.name` is `archweave`):

```sh
curl -fsS http://localhost:4317/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"setup-check","version":"1"}}}'
```

Claude Code loads `.mcp.json` when a session starts. The ArchWeave tools are not available in this session yet: tell the user to start a new session in this repository and approve the `archweave` server when asked; `/mcp` then lists it as connected. Other agents use the same URL with their own MCP configuration.

## 8. Report

Tell the user, briefly:

- the UI address (`http://localhost:<port>`) and the start and stop commands (`docker compose … up -d` / `… down`),
- the image version pinned and how to upgrade (change the tag, then `docker compose … pull` and `… up -d`),
- what to commit: the Compose file and `.mcp.json` now, `.archweave/` once it holds a model (`.archweave/state/` ignores itself), not `.env`,
- the next step, in a new session: "Analyze this repository and model its architecture in ArchWeave", or `/archweave:model-codebase` with the `archweave` plugin installed.
