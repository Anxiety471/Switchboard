import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import { createMcpServer } from './server.js';

test('starts with no tools', async () => {
  const server = createMcpServer();
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  expect(client.getServerCapabilities()?.tools).toBeUndefined();

  await client.close();
  await server.close();
});
