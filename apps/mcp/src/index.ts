import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig, type SwitchboardConfig } from './config.js';
import { createMcpServer } from './server.js';

const server = createMcpServer(loadConfig());
await server.connect(new StdioServerTransport());

function loadConfig(): SwitchboardConfig {
  try {
    return readConfig(process.env);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'SWITCHBOARD_TOKEN is required'
    ) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
