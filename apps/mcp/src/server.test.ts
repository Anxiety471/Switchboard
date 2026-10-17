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
const READ_AT = '2024-06-15T12:34:56.789Z';
const OTHER_READ_AT = '2024-06-15T12:34:57.001Z';
const MARK_READ_WARNING =
  'Mark-read could not be confirmed. These messages may show again.';

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
    res.writeHead(reply.status, {
      'content-type': 'application/json',
      date: 'Wed, 01 Jan 2020 00:00:00 GMT',
    });
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

function readReceipt(ids: string[], readAt = READ_AT) {
  return {
    read: ids,
    marked: ids.map((id) => ({ id, readAt })),
  };
}

async function connect(url: string, token = TOKEN, fetchImpl?: typeof fetch) {
  const server = createMcpServer({
    url,
    token,
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
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
      ['check_inbox', { limit: 101 }],
      ['check_inbox', { limit: 200 }],
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
    expect(JSON.parse(result.text)).toEqual({
      error: 'api_unreachable',
      message:
        'The Switchboard API at http://127.0.0.1:1 is not reachable. Do not retry in a loop.',
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

test('check_inbox pages with one mark-read call and a fresh readAt', async () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
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
        json: { messages: [message(second)], next: null },
      };
    }
    const batch = isIdBatch(request.body) ? request.body.ids : [];
    return { status: 200, json: readReceipt(batch) };
  });
  const session = await connect(mock.url);
  try {
    const page = await callTool(session.client, 'check_inbox', { limit: 1 });
    expect(page.isError).toBe(false);
    expect(page.value).toEqual({
      messages: [{ ...message(first), readAt: READ_AT }],
      next: CURSOR,
      read: [first],
    });
    const rest = await callTool(session.client, 'check_inbox', {
      unread: false,
      limit: 100,
      after: CURSOR,
    });
    expect(rest.isError).toBe(false);
    expect(rest.value).toEqual({
      messages: [{ ...message(second), readAt: READ_AT }],
      next: null,
      read: [second],
    });
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/inbox',
      '/inbox/read',
      '/inbox',
      '/inbox/read',
    ]);
    const firstQuery = new URLSearchParams(mock.requests[0]?.search);
    expect(firstQuery.get('unread')).toBe('true');
    expect(firstQuery.get('limit')).toBe('1');
    const secondQuery = new URLSearchParams(mock.requests[2]?.search);
    expect(secondQuery.get('unread')).toBe('false');
    expect(secondQuery.get('limit')).toBe('100');
    expect(secondQuery.get('after')).toBe(CURSOR);
    const batches = mock.requests
      .filter((request) => request.pathname === '/inbox/read')
      .map((request) =>
        isIdBatch(request.body) ? request.body.ids.length : 0,
      );
    expect(batches).toEqual([1, 1]);
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

test('a failed mark-read marks nothing and the message is still there', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  let markFailed = false;
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox/read') {
      if (!markFailed) {
        markFailed = true;
        return { status: 503, json: { error: 'database_unavailable' } };
      }
      const ids = isIdBatch(request.body) ? request.body.ids : [];
      return { status: 200, json: readReceipt(ids) };
    }
    return {
      status: 200,
      json: { messages: [message(id)], next: null },
    };
  });
  const session = await connect(mock.url);
  try {
    const failed = await callTool(session.client, 'check_inbox');
    expect(failed.isError).toBe(true);
    expect(apiError(failed.text)).toEqual({
      error: 'database_unavailable',
      status: 503,
    });
    expect(failed.text).not.toContain(id);
    expect(
      mock.requests.filter((request) => request.pathname === '/inbox/read'),
    ).toHaveLength(1);

    const recovered = await callTool(session.client, 'check_inbox');
    expect(recovered.isError).toBe(false);
    expect(recovered.value).toEqual({
      messages: [{ ...message(id), readAt: READ_AT }],
      next: null,
      read: [id],
    });
    const reads = mock.requests.filter(
      (request) => request.pathname === '/inbox/read',
    );
    expect(reads).toHaveLength(2);
    expect(reads.map((request) => request.body)).toEqual([
      { ids: [id] },
      { ids: [id] },
    ]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('an inbox page over 100 messages is not partially marked', async () => {
  const ids = Array.from({ length: 101 }, (_value, index) => {
    return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  });
  const mock = await startMock(() => ({
    status: 200,
    json: { messages: ids.map(message), next: null },
  }));
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox', {
      limit: 100,
    });
    expect(apiError(result.text)).toEqual({
      error: 'invalid request',
      status: 400,
    });
    expect(mock.requests.map((request) => request.pathname)).toEqual([
      '/inbox',
    ]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('check_inbox uses each returned readAt and ignores the Date header', async () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox/read') {
      return {
        status: 200,
        json: {
          read: [first, second],
          marked: [
            { id: first, readAt: READ_AT },
            { id: second, readAt: OTHER_READ_AT },
          ],
        },
      };
    }
    return {
      status: 200,
      json: { messages: [message(first), message(second)], next: null },
    };
  });
  const session = await connect(mock.url);
  try {
    const page = await callTool(session.client, 'check_inbox');
    expect(page.isError).toBe(false);
    expect(page.text).toContain('hello');
    expect(page.value).toEqual({
      messages: [
        { ...message(first), readAt: READ_AT },
        { ...message(second), readAt: OTHER_READ_AT },
      ],
      next: null,
      read: [first, second],
    });
    expect(page.text).not.toContain('2020-01-01T00:00:00.000Z');
  } finally {
    await session.close();
    await mock.close();
  }
});

test('check_inbox accepts an older mark-read response without marked', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = `older api ${'o'.repeat(120)} end`;
  let reads = 0;
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox/read') {
      reads += 1;
      return { status: 200, json: { read: [id] } };
    }
    return {
      status: 200,
      json: { messages: [{ ...message(id), body }], next: null },
    };
  });
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.text).not.toContain(MARK_READ_WARNING);
    expect(result.value).toEqual({
      messages: [{ ...message(id), body, readAt: null }],
      next: null,
      read: [id],
    });
    expect(reads).toBe(1);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('check_inbox returns the page when mark-read stays unconfirmed', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = `visible-after-failure ${'n'.repeat(180)} end`;
  const failures = [502, 504, 502];
  for (const status of failures) {
    let reads = 0;
    const mock = await startMock((request) => {
      if (request.pathname === '/inbox/read') {
        reads += 1;
        return { status, json: { error: 'bad gateway' } };
      }
      return {
        status: 200,
        json: { messages: [{ ...message(id), body }], next: CURSOR },
      };
    });
    const session = await connect(mock.url);
    try {
      const result = await callTool(session.client, 'check_inbox');
      expect(result.isError, String(status)).toBe(false);
      expect(result.text, String(status)).toContain(body);
      expect(result.text, String(status)).toContain(MARK_READ_WARNING);
      expect(result.text, String(status)).not.toContain(TOKEN);
      expect(result.value, String(status)).toEqual({
        messages: [{ ...message(id), body, readAt: null }],
        next: CURSOR,
        read: [],
        warning: MARK_READ_WARNING,
      });
      expect(reads, String(status)).toBe(2);
    } finally {
      await session.close();
      await mock.close();
    }
  }
});

test('check_inbox keeps the page when a later mark-read error follows a lost response', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = `kept-after-502 ${'q'.repeat(80)} end`;
  let reads = 0;
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox/read') {
      reads += 1;
      if (reads === 1) {
        return { status: 502, json: { error: 'bad gateway' } };
      }
      return { status: 503, json: { error: 'database_unavailable' } };
    }
    return {
      status: 200,
      json: { messages: [{ ...message(id), body }], next: null },
    };
  });
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.value).toMatchObject({
      messages: [{ id, body }],
      read: [],
      warning: MARK_READ_WARNING,
    });
    expect(reads).toBe(2);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('check_inbox uses the retried mark-read receipt', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = 'retried mark-read still returns the full body';
  let reads = 0;
  const mock = await startMock((request) => {
    if (request.pathname === '/inbox/read') {
      reads += 1;
      if (reads === 1) {
        return { status: 502, json: { error: 'bad gateway' } };
      }
      return { status: 200, json: readReceipt([id], OTHER_READ_AT) };
    }
    return {
      status: 200,
      json: { messages: [{ ...message(id), body }], next: null },
    };
  });
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.text).not.toContain(MARK_READ_WARNING);
    expect(result.value).toEqual({
      messages: [{ ...message(id), body, readAt: OTHER_READ_AT }],
      next: null,
      read: [id],
    });
    expect(reads).toBe(2);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('a dropped or timed-out mark-read still returns the full message', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = `reset-or-timeout ${'z'.repeat(160)} end`;
  const dropped = await startResetProxy(body, id);
  const session = await connect(dropped.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.text).toContain(MARK_READ_WARNING);
    expect(result.value).toEqual({
      messages: [{ ...message(id), body, readAt: null }],
      next: null,
      read: [],
      warning: MARK_READ_WARNING,
    });
    expect(dropped.markReads).toBe(2);
  } finally {
    await session.close();
    await dropped.close();
  }

  let reads = 0;
  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    if (url.pathname === '/inbox/read') {
      reads += 1;
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messages: [{ ...message(id), body }],
          next: null,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            date: 'Wed, 01 Jan 2020 00:00:00 GMT',
          },
        },
      ),
    );
  };
  const timedOut = await connect('http://127.0.0.1:9', TOKEN, fetchImpl);
  try {
    const result = await callTool(timedOut.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.text).not.toContain('2020-01-01T00:00:00.000Z');
    expect(result.text).not.toContain(TOKEN);
    expect(result.value).toEqual({
      messages: [{ ...message(id), body, readAt: null }],
      next: null,
      read: [],
      warning: MARK_READ_WARNING,
    });
    expect(reads).toBe(2);
  } finally {
    await timedOut.close();
  }
});

test('a mark-read body that cannot be read still returns the full message', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = `unreadable receipt ${'b'.repeat(140)} end`;
  let reads = 0;
  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    if (url.pathname === '/inbox/read') {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('socket hang up'));
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('not-json', { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messages: [{ ...message(id), body }],
          next: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const session = await connect('http://127.0.0.1:9', TOKEN, fetchImpl);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(false);
    expect(result.text).toContain(body);
    expect(result.text).toContain(MARK_READ_WARNING);
    expect(result.text).not.toContain(TOKEN);
    expect(result.value).toEqual({
      messages: [{ ...message(id), body, readAt: null }],
      next: null,
      read: [],
      warning: MARK_READ_WARNING,
    });
    expect(reads).toBe(2);
  } finally {
    await session.close();
  }
});

test('an inbox fetch failure is still an error without a page', async () => {
  const mock = await startMock(() => ({
    status: 502,
    json: { error: 'bad gateway' },
  }));
  const session = await connect(mock.url);
  try {
    const result = await callTool(session.client, 'check_inbox');
    expect(result.isError).toBe(true);
    expect(apiError(result.text)).toEqual({
      error: 'request_failed',
      status: 502,
    });
    expect(result.text).not.toContain('hello');
    expect(mock.requests).toHaveLength(1);
  } finally {
    await session.close();
    await mock.close();
  }
});

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  return new URL(input.url);
}

function startResetProxy(
  body: string,
  id: string,
): Promise<{ url: string; markReads: number; close: () => Promise<void> }> {
  let markReads = 0;
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/inbox/read') {
      markReads += 1;
      req.socket.destroy();
      return;
    }
    req.resume();
    res.writeHead(200, {
      'content-type': 'application/json',
      date: 'Wed, 01 Jan 2020 00:00:00 GMT',
    });
    res.end(
      JSON.stringify({
        messages: [{ ...message(id), body }],
        next: null,
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a TCP port'));
        return;
      }
      const handle = {
        url: `http://127.0.0.1:${address.port}`,
        get markReads() {
          return markReads;
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          }),
      };
      resolve(handle);
    });
  });
}

function isIdBatch(value: unknown): value is { ids: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ids' in value &&
    Array.isArray(value.ids)
  );
}
