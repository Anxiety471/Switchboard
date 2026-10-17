import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, readConfig, type SwitchboardConfig } from './config.js';
import { createMcpServer } from './server.js';

const server = createMcpServer(loadConfig());
await server.connect(new StdioServerTransport());

function loadConfig(): SwitchboardConfig {
  try {
    return readConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
