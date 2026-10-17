import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'vitest';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TOKEN = 'a'.repeat(43);

test('the built server lists agents over stdio', async () => {
  await access(entry);
  const mock = await startMock();
  const stderr: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...getDefaultEnvironment(),
      SWITCHBOARD_URL: mock.url,
      SWITCHBOARD_TOKEN: TOKEN,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result: unknown = await client.callTool({ name: 'list_agents' });
    const text = textOf(result);
    expect(JSON.parse(text)).toEqual({
      agents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'beta',
          online: false,
          lastSeenAt: null,
        },
      ],
    });
    expect(mock.seen.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Buffer.concat(stderr).toString('utf8')).not.toContain(TOKEN);
  } finally {
    await client.close();
    await mock.close();
  }
});

test('config errors print one stderr line and exit 1', async () => {
  await access(entry);
  const secret = 'super-secret-token';
  const cases: { name: string; env: NodeJS.ProcessEnv; stderr: string }[] = [
    {
      name: 'missing token',
      env: { SWITCHBOARD_URL: 'http://127.0.0.1:9' },
      stderr: 'SWITCHBOARD_TOKEN is required\n',
    },
    {
      name: 'empty token',
      env: { SWITCHBOARD_URL: 'http://127.0.0.1:9', SWITCHBOARD_TOKEN: '' },
      stderr: 'SWITCHBOARD_TOKEN is required\n',
    },
    {
      name: 'missing url',
      env: { SWITCHBOARD_TOKEN: TOKEN },
      stderr: 'SWITCHBOARD_URL is required\n',
    },
    {
      name: 'empty url',
      env: { SWITCHBOARD_URL: '', SWITCHBOARD_TOKEN: TOKEN },
      stderr: 'SWITCHBOARD_URL is required\n',
    },
    {
      name: 'bad url',
      env: { SWITCHBOARD_URL: 'not a url', SWITCHBOARD_TOKEN: TOKEN },
      stderr: 'SWITCHBOARD_URL is invalid\n',
    },
    {
      name: 'url with userinfo',
      env: {
        SWITCHBOARD_URL: `http://user:${secret}@127.0.0.1:9`,
        SWITCHBOARD_TOKEN: TOKEN,
      },
      stderr: 'SWITCHBOARD_URL is invalid\n',
    },
    {
      name: 'non-https public url',
      env: { SWITCHBOARD_URL: 'http://example.com', SWITCHBOARD_TOKEN: TOKEN },
      stderr: 'SWITCHBOARD_URL must use https\n',
    },
    {
      name: 'non-loopback http url',
      env: {
        SWITCHBOARD_URL: 'http://10.1.2.3:3001',
        SWITCHBOARD_TOKEN: TOKEN,
      },
      stderr: 'SWITCHBOARD_URL must use https\n',
    },
    {
      name: 'invalid token',
      env: {
        SWITCHBOARD_URL: 'http://127.0.0.1:9',
        SWITCHBOARD_TOKEN: `${secret}!`,
      },
      stderr: 'SWITCHBOARD_TOKEN is invalid\n',
    },
  ];
  for (const configCase of cases) {
    const result = await runServer(withPath(configCase.env));
    expect(result.code, configCase.name).toBe(1);
    expect(result.stdout, configCase.name).toBe('');
    expect(result.stderr, configCase.name).toBe(configCase.stderr);
    expect(result.stderr, configCase.name).not.toContain(secret);
    expect(result.stderr, configCase.name).not.toContain('    at ');
  }
});

function withPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.env.PATH === undefined) {
    return env;
  }
  return { ...env, PATH: process.env.PATH };
}

function textOf(result: unknown): string {
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
  return block.text;
}

async function startMock(): Promise<{
  url: string;
  seen: { authorization?: string };
  close: () => Promise<void>;
}> {
  const seen: { authorization?: string } = {};
  const server = createServer((request, response) => {
    if (typeof request.headers.authorization === 'string') {
      seen.authorization = request.headers.authorization;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        agents: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'beta',
            online: false,
            lastSeenAt: null,
          },
        ],
      }),
    );
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
    seen,
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

function runServer(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collect(child);
}

function collect(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
