import { createServer, type IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import { createMcpServer } from './server.js';

type Recorded = {
  method: string;
  pathname: string;
  search: string;
  authorization?: string;
  body?: unknown;
};

type Reply = { status: number; json: unknown };

const TOKEN = 'agent-token-value';
const CURSOR = '2024-01-01T00:00:00.000Z|00000000-0000-4000-8000-000000000001';

function message(id: string) {
  return {
    id,
    from: 'beta',
    to: 'alpha',
    body: 'hello',
    createdAt: '2024-01-01T00:00:00.000Z',
    readAt: null,
  };
}

async function startMock(
  respond: (request: Recorded) => Reply,
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const recorded = await record(req);
    requests.push(recorded);
    const reply = respond(recorded);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function record(req: IncomingMessage): Promise<Recorded> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      if (raw !== '') {
        body = JSON.parse(raw) as unknown;
      }
      const authorization = req.headers.authorization;
      resolve({
        method: req.method ?? '',
        pathname: url.pathname,
        search: url.search,
        ...(typeof authorization === 'string' ? { authorization } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    });
  });
}

async function connect(url: string, token = TOKEN) {
  const server = createMcpServer({ url, token });
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

type ToolResult = {
  isError: boolean;
  text: string;
  value: unknown;
};

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
    !('type' in block) ||
    block.type !== 'text' ||
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

function apiError(text: string): { error: string; status: number } {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('error' in parsed) ||
    typeof parsed.error !== 'string' ||
    !('status' in parsed) ||
    typeof parsed.status !== 'number'
  ) {
    throw new Error(`unexpected tool error ${text}`);
  }
  return { error: parsed.error, status: parsed.status };
}

test('exposes list_agents, send_message, and check_inbox', async () => {
  const session = await connect('http://127.0.0.1:9');
  try {
    const listed = await session.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'check_inbox',
      'list_agents',
      'send_message',
    ]);
    expect(session.client.getInstructions()).toContain('check_inbox');
  } finally {
    await session.close();
  }
});

test('rejects invalid tool input before calling the API', async () => {
  const mock = await startMock(() => {
    throw new Error('API should not be called');
  });
  const session = await connect(mock.url);
  try {
    const rejected = [
      ['send_message', {}],
      ['send_message', { to: 'beta' }],
      ['send_message', { body: 'hello' }],
      ['send_message', { to: '', body: 'hello' }],
      ['send_message', { to: 'has space', body: 'hello' }],
      ['send_message', { to: '**', body: 'hello' }],
      ['send_message', { to: '-beta', body: 'hello' }],
      ['send_message', { to: 'b'.repeat(65), body: 'hello' }],
      ['send_message', { to: 'beta', body: '' }],
      ['send_message', { to: 'beta', body: 'x'.repeat(8193) }],
      ['send_message', { to: 'beta', body: 'é'.repeat(4097) }],
      ['send_message', { to: 'beta', body: 'bad\0byte' }],
      ['check_inbox', { unread: 'true' }],
      ['check_inbox', { limit: 0 }],
      ['check_inbox', { limit: 201 }],
      ['check_inbox', { limit: 1.5 }],
      ['check_inbox', { limit: '2' }],
      ['check_inbox', { after: 'nope' }],
      [
        'check_inbox',
        {
          after:
            '2026-02-30T00:00:00.000Z|00000000-0000-4000-8000-000000000001',
        },
      ],
    ] as const;
    for (const [name, args] of rejected) {
      const result = await callTool(session.client, name, { ...args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(result.text).toContain('Input validation error');
      expect(result.text).toContain(name);
    }
    expect(mock.requests).toEqual([]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('send_message accepts a broadcast and the 8192-byte boundary', async () => {
  const mock = await startMock((request) => {
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.pathname).toBe('/base/messages');
    return {
      status: 201,
      json: { id: '00000000-0000-4000-8000-000000000010' },
    };
  });
  const session = await connect(`${mock.url}/base`);
  try {
    const broadcast = await callTool(session.client, 'send_message', {
      to: '*',
      body: 'hello all',
      extra: true,
    });
    expect(broadcast.isError).toBe(false);
    expect(broadcast.value).toEqual({
      id: '00000000-0000-4000-8000-000000000010',
    });
    const wide = 'é'.repeat(4096);
    expect(Buffer.byteLength(wide, 'utf8')).toBe(8192);
    const exact = await callTool(session.client, 'send_message', {
      to: `a${'b'.repeat(63)}`,
      body: wide,
    });
    expect(exact.isError).toBe(false);
    expect(mock.requests.map((request) => request.body)).toEqual([
      { to: '*', body: 'hello all' },
      { to: `a${'b'.repeat(63)}`, body: wide },
    ]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('maps 401, 400, and 503 responses from the API', async () => {
  const secret = 'leaked-secret';
  const cases: { status: number; json: unknown; error: string }[] = [
    {
      status: 401,
      json: { error: 'unauthorized', token: secret },
      error: 'unauthorized',
    },
    {
      status: 400,
      json: { error: 'invalid request' },
      error: 'invalid request',
    },
    {
      status: 503,
      json: { error: 'database_unavailable' },
      error: 'database_unavailable',
    },
  ];
  for (const apiCase of cases) {
    const mock = await startMock(() => ({
      status: apiCase.status,
      json: apiCase.json,
    }));
    const session = await connect(mock.url);
    try {
      for (const name of ['list_agents', 'send_message', 'check_inbox']) {
        const args =
          name === 'send_message' ? { to: 'beta', body: 'hello' } : {};
        const result = await callTool(
          session.client,
          name,
          name === 'list_agents' ? undefined : args,
        );
        expect(result.isError, name).toBe(true);
        expect(apiError(result.text), name).toEqual({
          error: apiCase.error,
          status: apiCase.status,
        });
        expect(result.text).not.toContain(secret);
        expect(result.text).not.toContain(TOKEN);
      }
      expect(
        mock.requests.every(
          (request) => request.authorization === `Bearer ${TOKEN}`,
        ),
      ).toBe(true);
      expect(JSON.stringify(mock.requests)).not.toContain(secret);
    } finally {
      await session.close();
      await mock.close();
    }
  }
});

test('maps an unreachable API and a non-JSON 503 without the token', async () => {
  const down = await connect('http://127.0.0.1:1');
  try {
    const result = await callTool(down.client, 'list_agents');
    expect(result.isError).toBe(true);
    expect(apiError(result.text)).toEqual({
      error: 'request_failed',
      status: 0,
    });
    expect(result.text).not.toContain(TOKEN);
  } finally {
    await down.close();
  }

  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('database is down');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP port');
  }
  const session = await connect(`http://127.0.0.1:${address.port}`);
  try {
    const result = await callTool(session.client, 'list_agents');
    expect(apiError(result.text)).toEqual({
      error: 'database_unavailable',
      status: 503,
    });
    expect(result.text).not.toContain('database is down');
    expect(result.text).not.toContain(TOKEN);
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test('check_inbox pages, marks the page read, and batches ids', async () => {
  const ids = Array.from({ length: 101 }, (_value, index) => {
    return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  });
  const first = ids[0];
  const second = ids[1];
  if (first === undefined || second === undefined) {
    throw new Error('expected ids');
  }
  let inboxCalls = 0;
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox') {
      inboxCalls += 1;
      if (inboxCalls === 1) {
        return {
          status: 200,
          json: { messages: [message(first)], next: CURSOR },
        };
      }
      return {
        status: 200,
        json: { messages: ids.map(message), next: null },
      };
    }
    const body = request.body;
    const batch = isIdBatch(body) ? body.ids : [];
    return { status: 200, json: { read: batch } };
  });
  const session = await connect(mock.url);
  try {
    const page = await callTool(session.client, 'check_inbox', { limit: 1 });
    expect(page.isError).toBe(false);
    expect(page.value).toEqual({
      messages: [message(first)],
      next: CURSOR,
      read: [first],
    });
    const rest = await callTool(session.client, 'check_inbox', {
      unread: false,
      limit: 200,
      after: CURSOR,
    });
    expect(rest.isError).toBe(false);
    const parsed = rest.value as { read?: string[] };
    expect(parsed.read).toEqual(ids);
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/inbox',
      '/inbox/read',
      '/inbox',
      '/inbox/read',
      '/inbox/read',
    ]);
    const firstQuery = new URLSearchParams(mock.requests[0]?.search);
    expect(firstQuery.get('unread')).toBe('true');
    expect(firstQuery.get('limit')).toBe('1');
    const secondQuery = new URLSearchParams(mock.requests[2]?.search);
    expect(secondQuery.get('unread')).toBe('false');
    expect(secondQuery.get('limit')).toBe('200');
    expect(secondQuery.get('after')).toBe(CURSOR);
    const batches = mock.requests
      .filter((request) => request.pathname === '/inbox/read')
      .map((request) =>
        isIdBatch(request.body) ? request.body.ids.length : 0,
      );
    expect(batches).toEqual([1, 100, 1]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('an empty inbox is not marked read', async () => {
  const mock = await startMock(() => ({
    status: 200,
    json: { messages: [], next: null },
  }));
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.value).toEqual({ messages: [], next: null, read: [] });
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/inbox',
    ]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('list_agents returns agent fields and drops anything else', async () => {
  const mock = await startMock(() => ({
    status: 200,
    json: {
      agents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'beta',
          online: false,
          lastSeenAt: null,
          token: TOKEN,
        },
      ],
    },
  }));
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'list_agents');
    expect(result.isError).toBe(false);
    expect(result.value).toEqual({
      agents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'beta',
          online: false,
          lastSeenAt: null,
        },
      ],
    });
    expect(result.text).not.toContain(TOKEN);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('a mark-read failure is returned after the inbox was fetched', async () => {
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox') {
      return {
        status: 200,
        json: {
          messages: [message('00000000-0000-4000-8000-000000000001')],
          next: null,
        },
      };
    }
    return { status: 503, json: { error: 'database_unavailable' } };
  });
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(apiError(result.text)).toEqual({
      error: 'database_unavailable',
      status: 503,
    });
  } finally {
    await session.close();
    await mock.close();
  }
});

function isIdBatch(value: unknown): value is { ids: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ids' in value &&
    Array.isArray(value.ids)
  );
}
