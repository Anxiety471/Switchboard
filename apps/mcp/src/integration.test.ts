import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client as PgClient } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'vitest';
import { createMcpServer } from './server.js';

const DATABASE_NAME = 'switchboard_mcp_test';
const apiEntry = fileURLToPath(
  new URL('../../api/dist/index.js', import.meta.url),
);

type ToolResult = {
  isError: boolean;
  text: string;
  value: unknown;
};

let apiUrl = '';
let databaseUrl = '';
let child: ChildProcess | undefined;
let admin: PgClient | undefined;
let logs = '';
const tokens = new Set<string>();

beforeAll(async () => {
  const adminUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  await access(apiEntry);
  databaseUrl = await ensureDatabase(adminUrl, DATABASE_NAME);
  admin = new PgClient({ connectionString: databaseUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.REGISTRATION_SECRET;
  child = spawn(process.execPath, [apiEntry], {
    env: {
      ...env,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  try {
    await waitForOk(`${apiUrl}/health`);
  } catch (error) {
    await stopApi();
    throw error;
  }
});

beforeEach(async () => {
  await admin?.query('TRUNCATE agents CASCADE');
});

afterAll(async () => {
  await stopApi();
  await admin?.end();
});

afterEach(() => {
  for (const token of tokens) {
    expect(logs).not.toContain(token);
  }
  expect(logs).not.toContain('not-a-real-token');
});

test('two agents exchange direct and broadcast messages through the tools', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const gamma = await register('gamma');
  const alphaSession = await connect(alpha.token);
  const betaSession = await connect(beta.token);
  const gammaSession = await connect(gamma.token);
  try {
    const listed = await callTool(alphaSession.client, 'list_agents');
    expect(listed.isError).toBe(false);
    expect(listed.value).toMatchObject({
      agents: [
        { name: 'alpha', online: true },
        { name: 'beta', online: false, lastSeenAt: null },
        { name: 'gamma', online: false, lastSeenAt: null },
      ],
    });
    expect(listed.text).not.toContain(alpha.token);

    const sent = await callTool(alphaSession.client, 'send_message', {
      to: 'Beta',
      body: 'hello beta',
    });
    expect(sent.isError).toBe(false);
    const sentId = idOf(sent.value);
    const inbox = await callTool(betaSession.client, 'check_inbox');
    expect(inbox.value).toMatchObject({
      messages: [
        {
          id: sentId,
          from: 'alpha',
          to: 'beta',
          body: 'hello beta',
          readAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          ),
        },
      ],
      next: null,
      read: [sentId],
    });
    expect(await callTool(betaSession.client, 'check_inbox')).toMatchObject({
      isError: false,
      value: { messages: [], next: null, read: [] },
    });
    expect(await unreadIds(beta.token)).toEqual([]);

    const broadcast = await callTool(alphaSession.client, 'send_message', {
      to: '*',
      body: 'hello all',
    });
    const broadcastId = idOf(broadcast.value);
    expect(
      (await callTool(betaSession.client, 'check_inbox')).value,
    ).toMatchObject({
      messages: [
        { id: broadcastId, from: 'alpha', to: '*', body: 'hello all' },
      ],
      read: [broadcastId],
    });
    expect(
      (await callTool(gammaSession.client, 'check_inbox')).value,
    ).toMatchObject({
      messages: [{ id: broadcastId, to: '*' }],
      read: [broadcastId],
    });
    expect(await callTool(alphaSession.client, 'check_inbox')).toMatchObject({
      value: { messages: [], read: [] },
    });

    const missing = await callTool(alphaSession.client, 'send_message', {
      to: 'nobody',
      body: 'hi',
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.text)).toEqual({
      error: 'recipient not found',
      status: 404,
    });
    const self = await callTool(alphaSession.client, 'send_message', {
      to: 'ALPHA',
      body: 'nope',
    });
    expect(self.isError).toBe(true);
    expect(JSON.parse(self.text)).toEqual({
      error: 'invalid request',
      status: 400,
    });

    const stranger = await connect('not-a-real-token');
    try {
      const denied = await callTool(stranger.client, 'list_agents');
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.text)).toEqual({
        error: 'unauthorized',
        status: 401,
      });
      expect(denied.text).not.toContain('not-a-real-token');
      expect(denied.text).not.toContain(alpha.token);
    } finally {
      await stranger.close();
    }
  } finally {
    await alphaSession.close();
    await betaSession.close();
    await gammaSession.close();
  }
});

test('check_inbox follows the API cursor and marks each page read', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const sender = await connect(beta.token);
  const reader = await connect(alpha.token);
  try {
    await callTool(sender.client, 'send_message', { to: 'alpha', body: 'one' });
    await callTool(sender.client, 'send_message', { to: 'alpha', body: 'two' });
    const first = await callTool(reader.client, 'check_inbox', { limit: 1 });
    const page = first.value as {
      messages: { body: string; id: string }[];
      next: string;
      read: string[];
    };
    expect(page.messages.map((item) => item.body)).toEqual(['one']);
    expect(page.read).toEqual([page.messages[0]?.id]);
    expect(page.next).toContain('|');
    const second = await callTool(reader.client, 'check_inbox', {
      limit: 1,
      after: page.next,
    });
    expect(second.value).toMatchObject({
      messages: [{ body: 'two' }],
      next: null,
    });
    expect(await callTool(reader.client, 'check_inbox')).toMatchObject({
      value: { messages: [], read: [] },
    });
  } finally {
    await sender.close();
    await reader.close();
  }
});

async function connect(token: string) {
  const server = createMcpServer({ url: apiUrl, token });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const result: unknown = await client.callTool({
    name,
    ...(args !== undefined ? { arguments: args } : {}),
  });
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('expected tool content');
  }
  const content: unknown = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('expected tool content');
  }
  const block: unknown = content[0];
  if (
    typeof block !== 'object' ||
    block === null ||
    !('text' in block) ||
    typeof block.text !== 'string'
  ) {
    throw new Error('expected text content');
  }
  const isError = 'isError' in result && result.isError === true;
  return {
    isError,
    text: block.text,
    value: isError ? undefined : (JSON.parse(block.text) as unknown),
  };
}

async function register(name: string): Promise<{
  id: string;
  name: string;
  token: string;
}> {
  const response = await fetch(`${apiUrl}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('id' in body) ||
    typeof body.id !== 'string' ||
    !('name' in body) ||
    typeof body.name !== 'string' ||
    !('token' in body) ||
    typeof body.token !== 'string'
  ) {
    throw new Error('unexpected registration response');
  }
  tokens.add(body.token);
  return { id: body.id, name: body.name, token: body.token };
}

async function unreadIds(token: string): Promise<string[]> {
  const response = await fetch(`${apiUrl}/inbox?unread=true`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('messages' in body) ||
    !Array.isArray(body.messages)
  ) {
    throw new Error('unexpected inbox response');
  }
  return body.messages.flatMap((message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      typeof message.id === 'string'
    ) {
      return [message.id];
    }
    return [];
  });
}

function idOf(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  ) {
    throw new Error('expected a message id');
  }
  return value.id;
}

function capture(chunk: Buffer): void {
  logs = `${logs}${chunk.toString('utf8')}`.slice(-8000);
}

async function waitForOk(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      break;
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return;
      }
      last = `${response.status} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`API did not become ready: ${last}\n${logs}`);
}

async function stopApi(): Promise<void> {
  const running = child;
  child = undefined;
  if (running === undefined) {
    return;
  }
  if (running.exitCode !== null || running.signalCode !== null) {
    return;
  }
  running.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      running.kill('SIGKILL');
    }, 5_000);
    running.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a TCP port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function ensureDatabase(adminUrl: string, name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !name.endsWith('_test')) {
    throw new Error(`Refusing to create database ${JSON.stringify(name)}`);
  }
  const connection = new PgClient({ connectionString: adminUrl });
  connection.on('error', () => undefined);
  await connection.connect();
  try {
    const existing = await connection.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if ((existing.rowCount ?? 0) === 0) {
      await connection.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await connection.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function assertTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('TEST_DATABASE_URL is required');
  }
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    throw new Error('TEST_DATABASE_URL is invalid');
  }
  const name = decodeURIComponent(pathname.replace(/^\//, ''));
  if (name === '' || name.includes('/')) {
    throw new Error('TEST_DATABASE_URL is invalid');
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database ${JSON.stringify(name)}; the name must end in _test`,
    );
  }
  return value;
}
