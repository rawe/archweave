# ArchWeave

A shared architecture workspace for a developer and a coding agent. The developer works in the browser, the agent works through MCP, and both edit the same model of the repository they are in: elements, relations, data structures and flows, each linked to the code that implements it.

The model lives in your repository as plain JSON (`.archweave/model.json` and `.archweave/layout.json`), so it is versioned and reviewed like code.

## Run it with Docker

Until the image is published, build it once from an ArchWeave checkout. This tags it as `ghcr.io/rawe/archweave:0.1.0` and `:latest` in your local Docker daemon, the same name the compose file pulls:

```bash
make release VERSION=0.1.0
```

Copy [`docker-compose.yml`](docker-compose.yml) into the repository you want to model and start it there:

```sh
docker compose up -d
```

Open <http://localhost:4317>. The compose file mounts the repository at `/repo`, stores the model in `/repo/.archweave` and publishes the port on `127.0.0.1` only. Set `ARCHWEAVE_IMAGE` to use a different image or tag. Files are written as user `1000:1000`; set `ARCHWEAVE_UID` and `ARCHWEAVE_GID` to your own ids if they differ.

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

Requests whose `Host` or `Origin` header names another host are refused, which protects the API and MCP endpoint against DNS rebinding. If you reach ArchWeave under another name (a LAN address, a container name), add it to `ARCHWEAVE_ALLOWED_HOSTS`.

## Data directory

```
.archweave/
  model.json      elements, relations, flows; sorted by id, defaults omitted
  layout.json     diagram positions
  .gitignore      ignores state/
  state/
    journal.jsonl activity journal (last 500 entries)
```

Commit `model.json` and `layout.json`. ArchWeave watches both files and reloads them when they change on disk, for example after `git checkout` or `git pull`.

## Development

```sh
npm test           # vitest: store, persistence, repository access, export, REST and MCP end to end
npm run typecheck
```

The design and the behavior contract are in [`docs/DESIGN.md`](docs/DESIGN.md); the data contract is [`src/shared/model.ts`](src/shared/model.ts).
