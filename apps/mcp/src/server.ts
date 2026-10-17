import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createMcpServer(): McpServer {
  return new McpServer({
    name: 'switchboard',
    version: '0.0.0',
  });
}
