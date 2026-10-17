import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createMcpServer } from './server.js';

const server = createMcpServer(readConfig(process.env));
await server.connect(new StdioServerTransport());
