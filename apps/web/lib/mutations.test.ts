import { beforeEach, expect, test } from 'vitest';
import { issueFormCsrf, openIssuedToken, type Flash } from './desk';
import { resetLoginLimits } from './login-limit';
import type { DeskResult } from './ledger';
import {
  handleDeskForm,
  type DeskDirectory,
  type DeskFormInput,
  type LedgerWrites,
} from './mutations';

const SECRET = 'desk-secret-desk-secret-desk-secret';

function env(): Record<string, string | undefined> {
  return {
    DASHBOARD_SECRET: SECRET,
    SWITCHBOARD_URL: 'http://127.0.0.1:3001',
  };
}

function fields(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    form.set(key, value);
  }
  return form;
}

type MemoryDirectory = DeskDirectory & {
  session: { id: string; csrfToken: string } | undefined;
  notices: Map<string, Flash>;
  saves: number;
  confirms: string[];
  discards: string[];
  confirmOk: boolean;
};

function memoryDirectory(): MemoryDirectory {
  const directory: MemoryDirectory = {
    session: undefined,
    notices: new Map(),
    saves: 0,
    confirms: [],
    discards: [],
    confirmOk: true,
    openSession() {
      this.session = {
        id: 'session-id-session-id-session-id-sess',
        csrfToken: 'csrf-token-csrf-token-csrf-token-csrf',
      };
      this.notices.clear();
      return Promise.resolve({ ok: true, value: this.session });
    },
    closeSession(_config, id) {
      if (this.session?.id === id) {
        this.session = undefined;
      }
      return Promise.resolve({ ok: true, value: true });
    },
    readSession(_config, id) {
      if (this.session?.id !== id) {
        return Promise.resolve({ ok: false, failure: 'not_found' });
      }
      return Promise.resolve({
        ok: true,
        value: { csrfToken: this.session.csrfToken },
      });
    },
    saveNotice(_config, id, flash) {
      this.saves += 1;
      if (this.session?.id !== id) {
        return Promise.resolve({ ok: false, failure: 'not_found' });
      }
      const noticeId = `notice-id-notice-id-notice-id-notice-${this.notices.size}`;
      this.notices.set(noticeId, flash);
      return Promise.resolve({ ok: true, value: { id: noticeId } });
    },
    confirmHandover(_config, id) {
      this.confirms.push(id);
      if (!this.confirmOk) {
        return Promise.resolve({ ok: false, failure: 'unreachable' });
      }
      return Promise.resolve({ ok: true, value: true });
    },
    discardPending(_config, id) {
      this.discards.push(id);
      return Promise.resolve({ ok: true, value: true });
    },
  };
  return directory;
}

function writes(): LedgerWrites & { calls: string[] } {
  return {
    calls: [],
    registerAgent() {
      this.calls.push('register');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', token: 'issued-token' },
      });
    },
    issueAgentToken() {
      this.calls.push('issue');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', token: 'rotated-token' },
      });
    },
    revokeAgentToken() {
      this.calls.push('revoke');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', tokenRevoked: true },
      });
    },
  };
}

function input(
  directory: DeskDirectory,
  extra: Partial<DeskFormInput> = {},
): DeskFormInput {
  return {
    env: env(),
    secure: false,
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1:3000',
    sessionId: undefined,
    tokenCookie: undefined,
    clientKey: 'client-a',
    wrongGuessDelayMs: 0,
    directory,
    ...extra,
  };
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const header = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (header === undefined) {
    return undefined;
  }
  return header.slice(name.length + 1).split(';')[0];
}

beforeEach(() => {
  resetLoginLimits();
});

test('login rejects a bad origin, a missing csrf token, and a wrong key without storing a notice', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  const wrong = fields({ intent: 'login', password: 'nope', csrf });

  expect(
    await handleDeskForm(wrong, input(directory, { origin: null })),
  ).toEqual({ kind: 'status', status: 403 });
  expect(
    await handleDeskForm(
      wrong,
      input(directory, { origin: 'https://evil.example' }),
    ),
  ).toEqual({ kind: 'status', status: 403 });
  expect(
    await handleDeskForm(
      fields({ intent: 'login', password: SECRET }),
      input(directory),
    ),
  ).toEqual({ kind: 'status', status: 403 });

  const denied = await handleDeskForm(wrong, input(directory));
  expect(denied).toEqual({
    kind: 'redirect',
    location: '/?error=unauthorized',
    cookies: [],
  });
  expect(directory.saves).toBe(0);
  expect(directory.session).toBeUndefined();

  const opened = await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory, { secure: false }),
  );
  expect(opened.kind).toBe('redirect');
  if (opened.kind !== 'redirect') {
    return;
  }
  expect(opened.location).toBe('/');
  const session = cookieValue(opened.cookies, 'switchboard_desk');
  expect(session).toBe(directory.session?.id);
  expect(opened.cookies.join('\n')).toContain('HttpOnly');
  expect(opened.cookies.join('\n')).toContain('SameSite=Lax');
  expect(opened.cookies.join('\n')).not.toContain('Secure');
  expect(opened.cookies.join('\n')).not.toContain(SECRET);
});

test('theme and logout use the session csrf token and a secure cookie only when configured', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory),
  );
  const sessionId = directory.session?.id ?? '';
  const sessionCsrf = directory.session?.csrfToken ?? '';

  expect(
    await handleDeskForm(
      fields({
        intent: 'theme',
        theme: 'dark',
        returnTo: '//evil.example',
        csrf,
      }),
      input(directory, { sessionId, secure: true }),
    ),
  ).toEqual({ kind: 'status', status: 403 });

  const theme = await handleDeskForm(
    fields({
      intent: 'theme',
      theme: 'dark',
      returnTo: '//evil.example',
      csrf: sessionCsrf,
    }),
    input(directory, { sessionId, secure: true }),
  );
  expect(theme).toMatchObject({ kind: 'redirect', location: '/' });
  if (theme.kind === 'redirect') {
    expect(theme.cookies[0]).toContain('switchboard_theme=dark');
    expect(theme.cookies[0]).toContain('Secure');
  }

  const logout = await handleDeskForm(
    fields({ intent: 'logout', csrf: sessionCsrf }),
    input(directory, { sessionId }),
  );
  expect(logout.kind).toBe('redirect');
  if (logout.kind === 'redirect') {
    expect(logout.location).toBe('/');
    expect(cookieValue(logout.cookies, 'switchboard_desk')).toBe('');
  }
  expect(directory.session).toBeUndefined();
});

test('a logged-out theme still needs a form csrf token and a safe return path', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  expect(
    await handleDeskForm(
      fields({ intent: 'theme', theme: 'light', returnTo: '/\t', csrf }),
      input(directory),
    ),
  ).toEqual({ kind: 'status', status: 400 });
  expect(
    await handleDeskForm(
      fields({ intent: 'theme', theme: 'light', returnTo: '/ok\r', csrf }),
      input(directory),
    ),
  ).toEqual({ kind: 'status', status: 400 });

  const theme = await handleDeskForm(
    fields({ intent: 'theme', theme: 'light', returnTo: '/?inbox=keep', csrf }),
    input(directory),
  );
  expect(theme).toMatchObject({
    kind: 'redirect',
    location: '/?inbox=keep',
  });
});

test('repeated login failures are limited and do not grow a notice store', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  const form = fields({ intent: 'login', password: 'nope', csrf });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const denied = await handleDeskForm(
      form,
      input(directory, { clientKey: 'limited' }),
    );
    expect(denied).toMatchObject({
      kind: 'redirect',
      location: '/?error=unauthorized',
    });
  }
  expect(
    await handleDeskForm(form, input(directory, { clientKey: 'limited' })),
  ).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(directory.saves).toBe(0);
  expect(directory.session).toBeUndefined();

  const locked = await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory, { clientKey: 'limited' }),
  );
  expect(locked).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(directory.session).toBeUndefined();

  const other = memoryDirectory();
  const beside = await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(other, { clientKey: 'someone-else' }),
  );
  expect(beside).toMatchObject({ kind: 'redirect', location: '/' });
  expect(other.session).toBeDefined();

  const start = 1_700_000_000_000;
  const windowed = memoryDirectory();
  const earlyCsrf = issueFormCsrf(SECRET, start);
  const wrong = fields({ intent: 'login', password: 'nope', csrf: earlyCsrf });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await handleDeskForm(
      wrong,
      input(windowed, { clientKey: 'window', now: start }),
    );
  }
  const during = start + 1_000;
  expect(
    await handleDeskForm(
      fields({
        intent: 'login',
        password: SECRET,
        csrf: issueFormCsrf(SECRET, during),
      }),
      input(windowed, { clientKey: 'window', now: during }),
    ),
  ).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  const released = start + 10 * 60 * 1000;
  const opened = await handleDeskForm(
    fields({
      intent: 'login',
      password: SECRET,
      csrf: issueFormCsrf(SECRET, released),
    }),
    input(windowed, { clientKey: 'window', now: released }),
  );
  expect(opened).toMatchObject({ kind: 'redirect', location: '/' });
  expect(windowed.session).toBeDefined();
});

test('without a client address there is no rate limit', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  const wrong = fields({ intent: 'login', password: 'nope', csrf });
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const denied = await handleDeskForm(
      wrong,
      input(directory, { clientKey: undefined }),
    );
    expect(denied).toMatchObject({
      kind: 'redirect',
      location: '/?error=unauthorized',
    });
  }

  const opened = await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory, { clientKey: undefined }),
  );
  expect(opened).toMatchObject({ kind: 'redirect', location: '/' });
  expect(directory.session).toBeDefined();
});

test('a locked address waits the same time for a wrong key and the right key', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await handleDeskForm(
      fields({ intent: 'login', password: 'nope', csrf }),
      input(directory, { clientKey: 'timed-lock' }),
    );
  }
  const measure = async (password: string) => {
    const started = performance.now();
    const result = await handleDeskForm(
      fields({ intent: 'login', password, csrf }),
      input(directory, {
        clientKey: 'timed-lock',
        wrongGuessDelayMs: 500,
      }),
    );
    return { result, elapsed: performance.now() - started };
  };
  const wrong = await measure('nope');
  const right = await measure(SECRET);
  expect(wrong.result).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(right.result).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(wrong.elapsed).toBeGreaterThanOrEqual(450);
  expect(right.elapsed).toBeGreaterThanOrEqual(450);
  expect(Math.abs(wrong.elapsed - right.elapsed)).toBeLessThan(200);
  expect(directory.session).toBeUndefined();
});

test('parallel wrong guesses do not delay a correct login', async () => {
  const directory = memoryDirectory();
  const csrf = issueFormCsrf(SECRET);
  const started = performance.now();
  const wrongs = Array.from({ length: 8 }, (_value, index) =>
    handleDeskForm(
      fields({ intent: 'login', password: 'nope', csrf }),
      input(directory, {
        clientKey: `parallel-${index}`,
        wrongGuessDelayMs: 500,
      }),
    ),
  );
  const opened = await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory, {
      clientKey: 'parallel-ok',
      wrongGuessDelayMs: 500,
    }),
  );
  expect(performance.now() - started).toBeLessThan(400);
  expect(opened).toMatchObject({ kind: 'redirect', location: '/' });
  expect(directory.session).toBeDefined();

  const denied = await Promise.all(wrongs);
  expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  for (const result of denied) {
    expect(result).toMatchObject({
      kind: 'redirect',
      location: '/?error=unauthorized',
    });
  }
});

test('register, issue, and revoke require the session csrf token', async () => {
  const directory = memoryDirectory();
  const client = writes();
  const csrf = issueFormCsrf(SECRET);
  const register = fields({
    intent: 'register',
    name: 'alpha',
    returnTo: '/?inbox=keep',
    csrf,
  });
  expect(
    await handleDeskForm(register, input(directory, { writes: client })),
  ).toEqual({
    kind: 'redirect',
    location: '/?error=unauthorized',
    cookies: [],
  });
  expect(client.calls).toEqual([]);

  await handleDeskForm(
    fields({ intent: 'login', password: SECRET, csrf }),
    input(directory),
  );
  const sessionId = directory.session?.id;
  const sessionCsrf = directory.session?.csrfToken ?? '';
  expect(
    await handleDeskForm(
      register,
      input(directory, { writes: client, sessionId }),
    ),
  ).toEqual({ kind: 'status', status: 403 });
  expect(client.calls).toEqual([]);

  const issued = await handleDeskForm(
    fields({
      intent: 'register',
      name: 'alpha',
      returnTo: '/?inbox=keep',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: client, sessionId }),
  );
  expect(issued).toMatchObject({ kind: 'redirect', location: '/?inbox=keep' });
  expect(client.calls).toEqual(['register']);
  expect(directory.saves).toBe(0);
  if (issued.kind === 'redirect') {
    const sealed = cookieValue(issued.cookies, 'switchboard_token');
    expect(sealed).toBeDefined();
    expect(issued.cookies.join('\n')).toContain('HttpOnly');
    expect(issued.cookies.join('\n')).toContain('SameSite=Strict');
    expect(issued.cookies.join('\n')).toContain('Max-Age=120');
    expect(issued.cookies.join('\n')).not.toContain('issued-token');
    expect(openIssuedToken(SECRET, sealed ?? '')).toMatchObject({
      id: 'agent-id',
      name: 'alpha',
      token: 'issued-token',
      handover: false,
    });
  }

  const conflict: LedgerWrites = {
    ...client,
    registerAgent: () =>
      Promise.resolve({
        ok: false,
        failure: 'conflict',
      } satisfies DeskResult<never>),
  };
  const again = await handleDeskForm(
    fields({
      intent: 'register',
      name: 'alpha',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: conflict, sessionId }),
  );
  if (again.kind === 'redirect') {
    const noticeId = cookieValue(again.cookies, 'switchboard_flash');
    expect(directory.notices.get(noticeId ?? '')).toEqual({
      type: 'failure',
      failure: 'conflict',
    });
  }

  const rotated = await handleDeskForm(
    fields({
      intent: 'issue',
      id: '00000000-0000-4000-8000-000000000001',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: client, sessionId }),
  );
  expect(client.calls).toContain('issue');
  expect(directory.saves).toBe(1);
  expect(rotated.kind).toBe('redirect');
  if (rotated.kind !== 'redirect') {
    return;
  }
  const rotatedSeal = cookieValue(rotated.cookies, 'switchboard_token');
  expect(rotated.cookies.join('\n')).not.toContain('rotated-token');
  expect(rotated.cookies.join('\n')).toContain('SameSite=Strict');
  expect(openIssuedToken(SECRET, rotatedSeal ?? '')).toMatchObject({
    token: 'rotated-token',
    handover: true,
  });

  const unknown = await handleDeskForm(
    fields({
      intent: 'issue',
      id: '00000000-0000-4000-8000-000000000001',
      csrf: sessionCsrf,
    }),
    input(directory, {
      sessionId,
      writes: {
        ...client,
        issueAgentToken: () =>
          Promise.resolve({ ok: false, failure: 'unknown' }),
      },
    }),
  );
  expect(unknown).toEqual({
    kind: 'redirect',
    location: '/?error=handover',
    cookies: [],
  });
  expect(directory.discards).toEqual(['00000000-0000-4000-8000-000000000001']);
  expect(JSON.stringify(unknown)).not.toContain('rotated-token');

  directory.confirmOk = false;
  const held = await handleDeskForm(
    fields({ intent: 'ack-token', csrf: sessionCsrf }),
    input(directory, { writes: client, sessionId, tokenCookie: rotatedSeal }),
  );
  expect(held).toEqual({
    kind: 'redirect',
    location: '/?error=handover',
    cookies: [],
  });
  expect(directory.confirms).toEqual(['agent-id']);
  expect(JSON.stringify(held)).not.toContain('rotated-token');

  directory.confirmOk = true;
  directory.confirmHandover = () =>
    Promise.resolve({ ok: false, failure: 'not_found' });
  const settled = await handleDeskForm(
    fields({ intent: 'ack-token', csrf: sessionCsrf }),
    input(directory, { writes: client, sessionId, tokenCookie: rotatedSeal }),
  );
  expect(settled.kind).toBe('redirect');
  if (settled.kind === 'redirect') {
    expect(settled.location).toBe('/');
    expect(cookieValue(settled.cookies, 'switchboard_token')).toBe('');
    expect(settled.cookies.join('\n')).not.toContain('rotated-token');
  }

  directory.confirmHandover = (_config, id) => {
    directory.confirms.push(id);
    return Promise.resolve({ ok: true, value: true });
  };
  const acked = await handleDeskForm(
    fields({ intent: 'ack-token', csrf: sessionCsrf }),
    input(directory, { writes: client, sessionId, tokenCookie: rotatedSeal }),
  );
  expect(acked.kind).toBe('redirect');
  if (acked.kind === 'redirect') {
    expect(cookieValue(acked.cookies, 'switchboard_token')).toBe('');
    expect(acked.cookies.join('\n')).toContain('SameSite=Strict');
    expect(acked.cookies.join('\n')).toContain('Max-Age=0');
    expect(acked.cookies.join('\n')).not.toContain('rotated-token');
  }
  expect(directory.confirms).toEqual(['agent-id', 'agent-id']);
  const revoked = await handleDeskForm(
    fields({
      intent: 'revoke',
      id: '00000000-0000-4000-8000-000000000001',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: client, sessionId }),
  );
  if (revoked.kind === 'redirect') {
    const noticeId = cookieValue(revoked.cookies, 'switchboard_flash');
    expect(directory.notices.get(noticeId ?? '')).toEqual({
      type: 'revoked',
      name: 'alpha',
    });
  }
  expect(JSON.stringify(client.calls)).not.toContain(SECRET);
});
