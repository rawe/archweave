## Project Overview

**ArchWeave** is a lightweight, self-hosted, AI-native web application for collaboratively modeling, visualizing, and documenting software architectures.

It runs alongside an existing codebase via Docker Compose, with persistent data stored in a mounted, Git-trackable directory.

## Core Concepts

- **Human-Agent Collaboration:** Developers and coding agents work together on the same architecture.
- **Visual Modeling:** Interactive, editable diagrams for infrastructure, software components, services, APIs, data flows, AI agents, and data structures (JSON/XML).
- **Bidirectional MCP Integration:** Coding agents can read and modify architecture models. The MCP server also exposes the user's current UI selection and context.
- **Codebase Awareness:** Coding agents analyze repository code and reflect its architecture in ArchWeave. Architecture models can also provide context back to agents.
- **Native Data Model:** Architecture is persisted in ArchWeave's own structured format, independent of diagram rendering.
- **Export:** Configurable exports for diagrams and architecture documentation.

## Technical Context

- Web application with integrated MCP server.
- Lightweight, Docker-based, repository-local deployment.
- File-based persistence without mandatory external infrastructure.
- Shared architecture model accessible through both UI and MCP.

## Development Conventions

- Prefer simple, maintainable, modular solutions.
- No AI attribution, AI signatures, or `Co-Authored-By` trailers in commits, code, documentation, or pull requests