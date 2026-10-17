import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

const SECRET = 'desk-secret-desk-secret-desk-secret';
const SESSION_ID = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const repoRoot = path.resolve(webRoot, '../..');
const nextBin = path.join(
  webRoot,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
);

const children: ChildProcess[] = [];
const apiClosers: Array<() => Promise<void>> = [];
const tally = { sessions: 0 };

type Exchange = {
  status: number;
  location: string | null;
  setCookie: string[];
  body: string;
};

function headerList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function headerOne(value: string | string[] | undefined): string | null {
  const list = headerList(value);
  return list[0] ?? null;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(' ')} failed\n${stderr}\n${stdout}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a port'));
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

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}

function collect(child: ChildProcess): () => string {
  let output = '';
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function httpExchange(options: {
  port: number;
  path: string;
  method: 'GET' | 'POST';
  localAddress: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method,
        localAddress: options.localAddress,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            location: headerOne(response.headers.location),
            setCookie: headerList(response.headers['set-cookie']),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body === undefined) {
      req.end();
      return;
    }
    req.end(options.body);
  });
}

async function waitForReady(
  port: number,
  child: ChildProcess,
  log: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let detail = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited ${child.exitCode}\n${log()}`);
    }
    try {
      const page = await httpExchange({
        port,
        path: '/',
        method: 'GET',
        localAddress: '127.0.0.1',
      });
      if (page.status === 200) {
        return;
      }
      detail = `status ${page.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : 'unreachable';
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error(`next start did not become ready: ${detail}\n${log()}`);
}

async function startDesk(options: {
  apiUrl: string;
  trustProxy: boolean;
  hops?: string;
}): Promise<{ port: number; child: ChildProcess }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DASHBOARD_SECRET: SECRET,
    SWITCHBOARD_URL: options.apiUrl,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
  };
  delete env.COOKIE_SECURE;
  delete env.TRUST_PROXY_HOPS;
  if (options.hops !== undefined) {
    env.TRUST_PROXY_HOPS = options.hops;
  }
  if (options.trustProxy) {
    env.TRUST_PROXY = '1';
  } else {
    delete env.TRUST_PROXY;
  }
  const child = spawn(
    process.execPath,
    [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  const log = collect(child);
  await waitForReady(port, child, log);
  return { port, child };
}

async function loginCsrf(port: number): Promise<string> {
  const page = await httpExchange({
    port,
    path: '/',
    method: 'GET',
    localAddress: '127.0.0.1',
  });
  const match = /name="csrf" value="([^"]+)"/.exec(page.body);
  const token = match?.[1];
  if (token === undefined) {
    throw new Error(
      `csrf missing (${page.status}): ${page.body.slice(0, 400)}`,
    );
  }
  return token;
}

function postLogin(options: {
  port: number;
  localAddress: string;
  password: string;
  csrf: string;
  forwardedFor: string;
}): Promise<Exchange> {
  const body = new URLSearchParams({
    intent: 'login',
    password: options.password,
    csrf: options.csrf,
  }).toString();
  return httpExchange({
    port: options.port,
    path: '/desk',
    method: 'POST',
    localAddress: options.localAddress,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      origin: `http://127.0.0.1:${options.port}`,
      host: `127.0.0.1:${options.port}`,
      'x-forwarded-for': options.forwardedFor,
    },
  });
}

function ipv4Block(prefix: string): string[] {
  const addresses: string[] = [];
  for (let host = 0; host < 256; host += 1) {
    addresses.push(`${prefix}.${host}`);
  }
  return addresses;
}

async function eachAddress(
  addresses: readonly string[],
  concurrency: number,
  visit: (address: string) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, addresses.length) },
    async () => {
      while (cursor < addresses.length) {
        const index = cursor;
        cursor += 1;
        const address = addresses[index];
        if (address === undefined) {
          return;
        }
        await visit(address);
      }
    },
  );
  await Promise.all(workers);
}

async function startApi(): Promise<string> {
  const api = await listen((incoming, response) => {
    if (incoming.headers['x-dashboard-secret'] !== SECRET) {
      response.writeHead(401).end('{}');
      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/dashboard/sessions') {
      tally.sessions += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: SESSION_ID, csrfToken: CSRF }));
      return;
    }
    response.writeHead(404).end('{}');
  });
  apiClosers.push(api.close);
  return api.url;
}

beforeAll(async () => {
  await access(nextBin);
  await run('pnpm', ['--filter', '@switchboard/shared', 'build'], repoRoot);
  await run('pnpm', ['exec', 'next', 'build'], webRoot);
}, 180_000);

afterAll(async () => {
  await Promise.all(children.map((child) => stop(child)));
  await Promise.all(apiClosers.map((close) => close()));
});

test('a real desk rates logins by the proxy hop and delays only a wrong key', async () => {
  tally.sessions = 0;
  const apiUrl = await startApi();

  const open = await startDesk({ apiUrl, trustProxy: false });
  const csrf = await loginCsrf(open.port);
  const started = Date.now();
  const wrongs = Array.from({ length: 8 }, () =>
    postLogin({
      port: open.port,
      localAddress: '127.0.0.1',
      password: 'nope',
      csrf,
      forwardedFor: '198.51.100.9',
    }),
  );
  const signedIn = await postLogin({
    port: open.port,
    localAddress: '127.0.0.2',
    password: SECRET,
    csrf,
    forwardedFor: '198.51.100.8',
  });
  expect(Date.now() - started).toBeLessThan(450);
  expect(signedIn.status).toBe(303);
  expect(signedIn.location).toBe('/');
  expect(signedIn.setCookie.join('\n')).toContain(
    `switchboard_desk=${SESSION_ID}`,
  );
  expect(tally.sessions).toBe(1);
  const denied = await Promise.all(wrongs);
  expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  for (const attempt of denied) {
    expect(attempt.status).toBe(303);
    expect(attempt.location).toBe('/?error=unauthorized');
  }

  const again = await postLogin({
    port: open.port,
    localAddress: '127.0.0.1',
    password: 'nope',
    csrf,
    forwardedFor: '198.51.100.9',
  });
  expect(again.status).toBe(303);
  expect(again.location).toBe('/?error=unauthorized');
  expect(tally.sessions).toBe(1);

  const page = await httpExchange({
    port: open.port,
    path: '/?error=limited',
    method: 'GET',
    localAddress: '127.0.0.1',
  });
  expect(page.status).toBe(200);
  expect(page.body).toContain('Too many attempts, try again later.');
  expect(page.body).toContain('Desk key');

  await stop(open.child);
  tally.sessions = 0;
  const proxied = await startDesk({ apiUrl, trustProxy: true });
  const proxyCsrf = await loginCsrf(proxied.port);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const denied = await postLogin({
      port: proxied.port,
      localAddress: '127.0.0.1',
      password: 'nope',
      csrf: proxyCsrf,
      forwardedFor: '203.0.113.20, 203.0.113.10',
    });
    expect(denied.status).toBe(303);
    expect(denied.location).toBe('/?error=unauthorized');
  }

  const spoofed = await postLogin({
    port: proxied.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf: proxyCsrf,
    forwardedFor: '198.51.100.9, 203.0.113.10',
  });
  expect(spoofed.status).toBe(303);
  expect(spoofed.location).toBe('/?error=limited');
  expect(spoofed.setCookie.join('\n')).not.toContain('switchboard_desk=');
  expect(tally.sessions).toBe(0);

  const other = await postLogin({
    port: proxied.port,
    localAddress: '127.0.0.2',
    password: SECRET,
    csrf: proxyCsrf,
    forwardedFor: '203.0.113.10, 203.0.113.20',
  });
  expect(other.status).toBe(303);
  expect(other.location).toBe('/');
  expect(other.setCookie.join('\n')).toContain(
    `switchboard_desk=${SESSION_ID}`,
  );
  expect(tally.sessions).toBe(1);

  const otherWrong = await postLogin({
    port: proxied.port,
    localAddress: '127.0.0.2',
    password: 'nope',
    csrf: proxyCsrf,
    forwardedFor: '203.0.113.10, 203.0.113.20',
  });
  expect(otherWrong.status).toBe(303);
  expect(otherWrong.location).toBe('/?error=unauthorized');

  const stillLocked = await postLogin({
    port: proxied.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf: proxyCsrf,
    forwardedFor: '203.0.113.99, 203.0.113.10',
  });
  expect(stillLocked.status).toBe(303);
  expect(stillLocked.location).toBe('/?error=limited');
}, 120_000);

test('a locked address takes the same time for a wrong key and the right key', async () => {
  tally.sessions = 0;
  const apiUrl = await startApi();
  const desk = await startDesk({ apiUrl, trustProxy: true });
  const csrf = await loginCsrf(desk.port);
  const forwardedFor = '203.0.113.50';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const denied = await postLogin({
      port: desk.port,
      localAddress: '127.0.0.1',
      password: 'nope',
      csrf,
      forwardedFor,
    });
    expect(denied.status).toBe(303);
    expect(denied.location).toBe('/?error=unauthorized');
  }

  const measure = async (password: string) => {
    const started = Date.now();
    const result = await postLogin({
      port: desk.port,
      localAddress: '127.0.0.1',
      password,
      csrf,
      forwardedFor,
    });
    return { result, elapsed: Date.now() - started };
  };
  const wrong = await measure('nope');
  const right = await measure(SECRET);
  expect(wrong.result.status).toBe(303);
  expect(right.result.status).toBe(303);
  expect(wrong.result.location).toBe('/?error=limited');
  expect(right.result.location).toBe('/?error=limited');
  expect(right.result.setCookie.join('\n')).not.toContain('switchboard_desk=');
  expect(tally.sessions).toBe(0);
  expect(wrong.elapsed).toBeGreaterThanOrEqual(450);
  expect(right.elapsed).toBeGreaterThanOrEqual(450);
  expect(Math.abs(wrong.elapsed - right.elapsed)).toBeLessThan(200);
  await stop(desk.child);
}, 60_000);

test('a full map still signs in a correct key from a new address', async () => {
  tally.sessions = 0;
  const apiUrl = await startApi();
  const desk = await startDesk({ apiUrl, trustProxy: true });
  const csrf = await loginCsrf(desk.port);
  const addresses = [
    ...ipv4Block('203.0.113'),
    ...ipv4Block('198.51.100'),
    ...ipv4Block('192.0.2'),
    ...ipv4Block('198.51.101'),
  ];
  expect(addresses).toHaveLength(1024);
  for (let wave = 0; wave < 8; wave += 1) {
    await eachAddress(addresses, 128, async (address) => {
      const denied = await postLogin({
        port: desk.port,
        localAddress: '127.0.0.1',
        password: 'nope',
        csrf,
        forwardedFor: address,
      });
      expect(denied.status).toBe(303);
      expect(denied.location).toBe('/?error=unauthorized');
    });
  }
  for (let host = 1; host <= 8; host += 1) {
    const denied = await postLogin({
      port: desk.port,
      localAddress: '127.0.0.1',
      password: 'nope',
      csrf,
      forwardedFor: `203.0.114.${host}`,
    });
    expect(denied.status).toBe(303);
    expect(denied.location).toBe('/?error=unauthorized');
  }

  const measure = async (password: string, forwardedFor: string) => {
    const started = Date.now();
    const result = await postLogin({
      port: desk.port,
      localAddress: '127.0.0.1',
      password,
      csrf,
      forwardedFor,
    });
    return { result, elapsed: Date.now() - started };
  };
  const wrong = await measure('nope', '203.0.114.20');
  const right = await measure(SECRET, '203.0.114.21');
  expect(wrong.result.status).toBe(303);
  expect(wrong.result.location).toBe('/?error=limited');
  expect(wrong.result.setCookie.join('\n')).not.toContain('switchboard_desk=');
  expect(right.result.status).toBe(303);
  expect(right.result.location).toBe('/');
  expect(right.result.setCookie.join('\n')).toContain(
    `switchboard_desk=${SESSION_ID}`,
  );
  expect(tally.sessions).toBe(1);
  expect(wrong.elapsed).toBeGreaterThanOrEqual(450);
  expect(right.elapsed).toBeGreaterThanOrEqual(450);
  expect(Math.abs(wrong.elapsed - right.elapsed)).toBeLessThan(250);

  const stillLocked = await postLogin({
    port: desk.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf,
    forwardedFor: '203.0.113.10',
  });
  expect(stillLocked.status).toBe(303);
  expect(stillLocked.location).toBe('/?error=limited');
  expect(stillLocked.setCookie.join('\n')).not.toContain('switchboard_desk=');
  expect(tally.sessions).toBe(1);
  await stop(desk.child);
}, 180_000);

test('addresses in one IPv6 /64 share one bucket', async () => {
  tally.sessions = 0;
  const apiUrl = await startApi();
  const desk = await startDesk({ apiUrl, trustProxy: true });
  const csrf = await loginCsrf(desk.port);
  const addresses = Array.from({ length: 1024 }, (_value, index) => {
    return `2001:db8:1:2::${(index + 1).toString(16)}`;
  });
  await eachAddress(addresses, 128, async (address) => {
    const denied = await postLogin({
      port: desk.port,
      localAddress: '127.0.0.1',
      password: 'nope',
      csrf,
      forwardedFor: `198.51.100.9, ${address}`,
    });
    expect(denied.status).toBe(303);
    expect(['/?error=unauthorized', '/?error=limited']).toContain(
      denied.location,
    );
  });

  const samePrefix = await postLogin({
    port: desk.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf,
    forwardedFor: '2001:0db8:0001:0002:ffff::2',
  });
  expect(samePrefix.status).toBe(303);
  expect(samePrefix.location).toBe('/?error=limited');
  expect(samePrefix.setCookie.join('\n')).not.toContain('switchboard_desk=');
  expect(tally.sessions).toBe(0);

  const otherPrefix = await postLogin({
    port: desk.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf,
    forwardedFor: '2001:db8:1:3::1',
  });
  expect(otherPrefix.status).toBe(303);
  expect(otherPrefix.location).toBe('/');
  expect(otherPrefix.setCookie.join('\n')).toContain(
    `switchboard_desk=${SESSION_ID}`,
  );
  expect(tally.sessions).toBe(1);
  await stop(desk.child);
}, 60_000);

test('normalized and unparseable forwarded addresses are limited after eight wrong guesses', async () => {
  tally.sessions = 0;
  const apiUrl = await startApi();
  const desk = await startDesk({ apiUrl, trustProxy: true });
  const csrf = await loginCsrf(desk.port);
  const forms = [
    '::ffff:203.0.113.77',
    '203.0.113.78:4711',
    '[2001:db8:9::1]:443',
    'fe80::1%eth0',
    'garbage',
  ];
  for (let wave = 0; wave < 8; wave += 1) {
    const denied = await Promise.all(
      forms.map((forwardedFor) =>
        postLogin({
          port: desk.port,
          localAddress: '127.0.0.1',
          password: 'nope',
          csrf,
          forwardedFor,
        }),
      ),
    );
    for (const attempt of denied) {
      expect(attempt.status).toBe(303);
      expect(attempt.location).toBe('/?error=unauthorized');
    }
  }
  const limited = await Promise.all(
    forms.map((forwardedFor) =>
      postLogin({
        port: desk.port,
        localAddress: '127.0.0.1',
        password: 'nope',
        csrf,
        forwardedFor,
      }),
    ),
  );
  for (const attempt of limited) {
    expect(attempt.status).toBe(303);
    expect(attempt.location).toBe('/?error=limited');
    expect(attempt.setCookie.join('\n')).not.toContain('switchboard_desk=');
  }
  expect(tally.sessions).toBe(0);

  const other = await postLogin({
    port: desk.port,
    localAddress: '127.0.0.1',
    password: SECRET,
    csrf,
    forwardedFor: '198.51.100.40',
  });
  expect(other.status).toBe(303);
  expect(other.location).toBe('/');
  expect(other.setCookie.join('\n')).toContain(
    `switchboard_desk=${SESSION_ID}`,
  );
  expect(tally.sessions).toBe(1);
  await stop(desk.child);
}, 60_000);

test('an invalid TRUST_PROXY_HOPS stops next start with one line', async () => {
  for (const hops of ['0', '-1', '1.5']) {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DASHBOARD_SECRET: SECRET,
      SWITCHBOARD_URL: 'http://127.0.0.1:9',
      TRUST_PROXY_HOPS: hops,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_NO_WARNINGS: '1',
    };
    delete env.COOKIE_SECURE;
    const child = spawn(
      process.execPath,
      [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`;
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`;
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 20_000);
      child.once('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr.trim()).toBe('TRUST_PROXY_HOPS must be a positive integer');
    expect(stderr).not.toContain('\n    at ');
  }
}, 60_000);
