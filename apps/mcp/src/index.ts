import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig, type SwitchboardConfig } from './config.js';
import { createMcpServer } from './server.js';

const CONFIG_ERRORS = new Set([
  'SWITCHBOARD_URL is required',
  'SWITCHBOARD_TOKEN is required',
  'SWITCHBOARD_URL is invalid',
  'SWITCHBOARD_URL must use https',
  'SWITCHBOARD_TOKEN is invalid',
]);

const server = createMcpServer(loadConfig());
await server.connect(new StdioServerTransport());

function loadConfig(): SwitchboardConfig {
  try {
    return readConfig(process.env);
  } catch (error) {
    console.error(configErrorLine(error));
    process.exit(1);
  }
}

function configErrorLine(error: unknown): string {
  if (error instanceof Error && CONFIG_ERRORS.has(error.message)) {
    return error.message;
  }
  return 'invalid configuration';
}
