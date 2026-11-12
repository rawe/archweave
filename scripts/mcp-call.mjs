#!/usr/bin/env node
// Calls the ArchWeave MCP server from a shell, for agents and scripts without a native MCP connection.
//
//   node scripts/mcp-call.mjs instructions
//   node scripts/mcp-call.mjs tools
//   node scripts/mcp-call.mjs get_context
//   node scripts/mcp-call.mjs apply_changes @changes.json
//   node scripts/mcp-call.mjs get_element '{"id":"api"}'
//
// ARCHWEAVE_URL selects the server (default http://127.0.0.1:4317).
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [command, rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: mcp-call.mjs instructions | tools | <tool> [json | @file.json]');
  process.exit(2);
}
const base = (process.env.ARCHWEAVE_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const client = new Client({ name: process.env.ARCHWEAVE_CLIENT ?? 'mcp-call', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

try {
  if (command === 'instructions') {
    console.log(client.getInstructions() ?? '');
  } else if (command === 'tools') {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      console.log(`## ${tool.name}\n${tool.description}\ninput: ${JSON.stringify(tool.inputSchema)}\n`);
    }
  } else {
    const text = rawArgs?.startsWith('@') ? readFileSync(rawArgs.slice(1), 'utf8') : rawArgs;
    const result = await client.callTool({ name: command, arguments: text ? JSON.parse(text) : {} });
    for (const part of result.content ?? []) console.log(part.type === 'text' ? part.text : JSON.stringify(part));
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
