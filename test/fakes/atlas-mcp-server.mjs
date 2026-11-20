// Tiny MCP server used by atlas-tools.test.mjs: registers the core tools over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { register } from '../../src/tools/core-tools.mjs';

const server = new McpServer({ name: 'atlas-test', version: '0.0.0' });
register(server);
await server.connect(new StdioServerTransport());
