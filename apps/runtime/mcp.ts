import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ComputerContext } from './context.js';
import { createAgentLinkServer } from './mcp-server.js';
import { resolvePaths, registryForRead } from '../../packages/config/index.js';

// stdio entry point: the path every MCP client (Codex, Claude Code, Cursor, ...) uses.
const paths = resolvePaths();
const configPath = registryForRead(paths);
const session = process.env.AGENTLINK_SESSION ?? 'default';
const server = createAgentLinkServer(new ComputerContext(configPath, session));
await server.connect(new StdioServerTransport());
console.error('[agentlink-mcp] server ready (config=' + configPath + ', session=' + session + ')');
