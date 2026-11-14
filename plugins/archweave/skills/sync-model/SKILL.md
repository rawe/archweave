---
name: sync-model
description: Bring the ArchWeave architecture model up to date with code changes, by re-anchoring moved code links, fixing changed ones and modeling new or removed parts. Use after implementing or refactoring code in a repository with ArchWeave, before finishing such a task, after pulling others' changes, or when the user says the model is out of date. Optionally pass a Git revision or paths to compare against.
argument-hint: "[git revision or paths]"
---

# Sync the ArchWeave model with the code

The model stays truthful when every code change is followed by a short sync. The ArchWeave MCP server's instructions explain code refs, seals and the `apply_changes` helpers; this skill is the procedure.

If the ArchWeave MCP tools are not available, ArchWeave is not running or not connected: use the `archweave-setup:setup` skill.

## 1. Find the changed paths

Use `$ARGUMENTS` when given: paths as they are, a revision as the base for `git diff`. Otherwise:

- Files you changed in this session, if you know them all.
- Otherwise everything that changed since the model was last committed:

```sh
base=$(git log -1 --format=%H -- .archweave/model.json)
{ git diff --name-only --no-renames "${base:-HEAD}"; git ls-files --others --exclude-standard; } | sort -u | grep -v '^\.archweave/'
```

`--no-renames` lists both the old and the new path of a moved file, so links to the old path are found. `git diff --name-status "$base"` shows which files were renamed or deleted; their refs come back as `missing-file`.

## 2. See what the model links there

Call `find_by_code` with the changed paths, in one call. It returns the linked elements, relations and flow steps with the check of each ref, and the paths nothing links to in `unmatchedPaths`.

## 3. Repair and fix the links

1. `check_code_links` with `repair: true` re-anchors every moved ref in one change. Never recompute line numbers by hand.
2. For each `changed` ref, read the code. If the ref still points at the right thing, re-send it without its digest in `addCodeRefs` to re-seal it; if not, replace it (`removeCodeRefs` plus `addCodeRefs`).
3. For `missing-file` and `symbol-not-found`, find where the code went (a rename, a move, a split) and point the ref there. If the code is gone, remove the ref.

## 4. Update the model where the architecture changed

Look at what the change did, not at every line. Model it when it:

- adds, removes or renames a deployable, a component, a store, a queue or an external dependency,
- adds or changes a call, an event or a data structure that crosses a boundary,
- implements a planned element (set `status: built` and add its code refs) or changes what an element is responsible for.

Paths in `unmatchedPaths` that hold no such change (tests, helpers, internals of a linked unit) need nothing. When an element's code is gone entirely, ask the human before removing it, and never remove planned elements or open notes on your own. Send one `apply_changes` per coherent step, with a summary the human will read in the activity feed.

## 5. Close open notes and report

Call `get_context`; resolve the open notes your change handled, with a reply note when useful. Finish with `check_code_links` (no repair) to confirm nothing is stale, then tell the human in a few lines what changed in the model, with `focus_ui` on the main element.
