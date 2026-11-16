# ArchWeave

A shared architecture workspace for a developer and a coding agent. The developer works in the browser, the agent works through MCP, and both edit the same model of the repository they are in: elements, relations, data structures and flows, each linked to the code that implements it.

The model lives in your repository as plain JSON (`.archweave/model.json` and `.archweave/layout.json`), so it is versioned and reviewed like code.

## Use it in your project

ArchWeave ships as a multi-arch image (`linux/amd64`, `linux/arm64`): `ghcr.io/rawe/archweave`. Nothing to build.

1. Add this `docker-compose.yml` to the root of the repository you want to model:

   ```yaml
   services:
     archweave:
       image: ghcr.io/rawe/archweave:0.1.0
       user: "${ARCHWEAVE_UID:-1000}:${ARCHWEAVE_GID:-1000}"
       ports:
         - "127.0.0.1:4317:4317"
       volumes:
         - ./:/repo
       environment:
         ARCHWEAVE_DATA_DIR: /repo/.archweave
         ARCHWEAVE_HOST_REPO_PATH: ${PWD}
       restart: unless-stopped
   ```

2. Start it: `docker compose up -d`
3. Open <http://localhost:4317> and connect your coding agent (see below).

The repository is mounted at `/repo` and the model is written to `.archweave/` in it; commit that folder. Files are written as `1000:1000`; if your ids differ (`id -u`, `id -g`), set `ARCHWEAVE_UID` and `ARCHWEAVE_GID`, for example in a `.env` file next to the compose file. Use `:latest` instead of a version to always get the newest release (`docker compose pull` to update).

## Run it with Node

Node 22 or newer.

```sh
npm install
npm run build
ARCHWEAVE_REPO_DIR=/path/to/your/repo npm start
```

During development, `npm run dev` runs the server with reload and the Vite dev server for the UI (open <http://localhost:5173>). The server alone runs with `ARCHWEAVE_REPO_DIR=<dir> PORT=<n> npx tsx src/server/main.ts`.

## Connect your coding agent

ArchWeave serves MCP over Streamable HTTP at `/mcp`:

```json
{ "mcpServers": { "archweave": { "type": "http", "url": "http://localhost:4317/mcp" } } }
```

For Claude Code: `claude mcp add --transport http archweave http://localhost:4317/mcp`.

A good first prompt: "Analyze this repository and model its architecture in ArchWeave." The server ships a modeling guide with its MCP instructions (and as the `get_guide` tool), so the agent knows how to structure the model.

Tools: `get_guide`, `get_context` (what you are looking at and have selected), `get_model`, `get_element`, `search`, `find_by_code`, `apply_changes`, `check_code_links`, `get_changes`, `focus_ui`, `export`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHWEAVE_REPO_DIR` | current directory | The repository being modeled. Read only. |
| `ARCHWEAVE_DATA_DIR` | `<repo>/.archweave` | Model storage. Relative paths are resolved against the repository. |
| `ARCHWEAVE_HOST_REPO_PATH` | unset | Absolute path of the repository on the host, for "open in editor" links when running in Docker. |
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Listen address. The Docker image sets `HOST=0.0.0.0`. |
| `ARCHWEAVE_ALLOWED_HOSTS` | unset | Comma-separated extra hostnames accepted in the `Host` and `Origin` headers. Localhost names and `HOST` are always accepted. |
| `ARCHWEAVE_WEB_DIR` | `dist/web` | Directory of the built web UI. |

Requests whose `Host` or `Origin` header names another host (or an opaque `null` origin) are refused, which protects the API and MCP endpoint against DNS rebinding and cross-site requests. Requests that change data and carry a body must send `Content-Type: application/json`. If you reach ArchWeave under another name (a LAN address, a container name), add it to `ARCHWEAVE_ALLOWED_HOSTS`.

## Data directory

```
.archweave/
  model.json      elements, relations, flows; sorted by id, defaults omitted
  layout.json     diagram positions
  .gitignore      ignores state/
  state/
    journal.jsonl activity journal (last 500 entries)
```

Commit `model.json` and `layout.json`. ArchWeave watches both files and reloads the one that changed on disk, for example after `git checkout` or `git pull`. A model with broken references (unknown ids, containment cycles, data references to non-data elements) is refused: at startup the server exits with a list of the problems, and a reload that would bring one in is ignored and logged.

## Development

```sh
npm test           # vitest: store, persistence, repository access, export, REST and MCP end to end
npm run typecheck
```

The design and the behavior contract are in [`docs/DESIGN.md`](docs/DESIGN.md); the data contract is [`src/shared/model.ts`](src/shared/model.ts).

### Releasing

Push a semantic version tag; GitHub Actions builds the image for amd64 and arm64 and pushes it to GHCR:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Final versions also get `latest`; pre-releases (`v0.2.0-beta.1`) do not. `make release VERSION=0.1.0` builds the same image locally.
