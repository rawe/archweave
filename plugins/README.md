# Claude Code plugins

The repository root is a Claude Code plugin marketplace named `archweave` ([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)). Its plugins live here:

```text
plugins/
  archweave-setup/                 run ArchWeave in a repository
    skills/setup/
      SKILL.md                     the procedure
      docker-compose.yml           template the skill fills in
      reference/                   configuration and troubleshooting, read on demand
  archweave/                       work with the model through MCP (depends on archweave-setup)
    skills/model-codebase/SKILL.md
    skills/sync-model/SKILL.md
```

The skills describe procedures only. How to structure a model is the server's modeling guide (`src/server/guide.ts`), which every MCP client receives; keep it there, not in the skills.

## Develop

```sh
claude plugin validate --strict .            # marketplace and every plugin
claude --plugin-dir plugins/archweave-setup --plugin-dir plugins/archweave
```

`--plugin-dir` loads the working copy for one session; `/reload-plugins` picks up edits.

## Release

Users stay on the `version` in a plugin's `.claude-plugin/plugin.json` until it changes. To release a plugin:

1. Bump its `version` (semver: patch for wording, minor for new skills or steps, major when a skill is renamed or removed).
2. Merge to the default branch.
3. Tag it: `claude plugin tag plugins/<name> --push` creates and pushes `<name>--v<version>`.

Users receive it with `/plugin marketplace update archweave`, or automatically if they enabled auto-update for the marketplace. Plugin versions are independent of the ArchWeave image version; the setup skill pins whatever image version it finds.
