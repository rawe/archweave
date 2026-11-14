---
name: model-codebase
description: Build the ArchWeave architecture model of the current repository from its code, level by level, with code links, data structures and key flows. Use when the user asks to model, map, analyze or document the repository's architecture in ArchWeave, to fill an empty ArchWeave model, or to model one part of the system (pass that part as the argument).
argument-hint: "[part of the system to model]"
---

# Model a codebase in ArchWeave

The goal is a model a developer can read in the ArchWeave UI and trust: every element named the way the team talks, linked to the code that implements it, nothing invented. The ArchWeave MCP server's instructions (the modeling guide) define how to structure elements, relations, code refs, data and flows. Follow them; this skill sets the order of work.

Scope: `$ARGUMENTS`. When it names a part of the system, model only that part and what it talks to, and leave the rest of the model as it is.

## Before you start

- The ArchWeave MCP tools (`get_model`, `apply_changes`, …) must be available. If they are not, ArchWeave is not running or not connected: use the `archweave-setup:setup` skill, then continue in a new session.
- If the modeling guide is not in your context, call `get_guide`.
- Call `get_model`. If it already holds elements, extend and correct it rather than starting over. Planned elements and open notes are the human's design intent: keep them, and handle notes as requests.
- Call `get_context` to see what the human is looking at; it may narrow what they want.

## 1. Survey the repository

Read structure before code: the directory tree, build manifests (`package.json`, `go.mod`, `pyproject.toml`, `pom.xml`, …), deployment files (Compose, Kubernetes, Terraform, Dockerfiles), entry points, route tables, schemas and migrations, message definitions, and existing architecture docs. From that, list what runs (apps, services, workers), what stores data, what is called outside the repository, and who uses it. For a large repository, delegate the survey of separate areas to subagents and keep only their conclusions.

## 2. Top level first

Create the top level in one `apply_changes`: actors, apps, services, stores, queues, external systems and agents, with the relations between them and code refs to each entry point. Aim for a dozen nodes or fewer. Then `focus_ui` on them with a one-line message so the human sees the outline early and can redirect before you go deeper.

## 3. One container at a time

For each app or service, in one `apply_changes` each: its components (5 to 9, grouped when there are more), their relations to each other and to the top level, and code refs that point to declarations. Go one level further only where it helps a reader.

## 4. Data that crosses boundaries

Model the structures that travel between elements or that people discuss: API payloads, events, persisted records, configuration. Fields come from the actual schema or type; link fields with `ref`, and connect producers and consumers.

## 5. A few flows

Add two to four flows for the scenarios that explain the system best, such as the main request end to end or a background job. Each step names the data it carries.

## 6. Check the links

Run `check_code_links` with `repair: true`. Fix every stale ref it returns and add code refs to every element in `builtWithoutCode`. Do not finish with stale links.

## 7. Hand over

`focus_ui` on the top level and summarize for the human: what you modeled, what you left out on purpose, and anything in the code that surprised you or that you could not place. Suggest committing `.archweave/model.json` and `.archweave/layout.json` with the code.
