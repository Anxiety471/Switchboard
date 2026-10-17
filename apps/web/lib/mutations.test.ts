import { beforeEach, expect, test } from 'vitest';
import { issueFormCsrf, type Flash } from './desk';
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
};

function memoryDirectory(): MemoryDirectory {
  const directory: MemoryDirectory = {
    session: undefined,
    notices: new Map(),
    saves: 0,
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
    clientKey: 'client-a',
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
  ).toEqual({ kind: 'status', status: 429 });
  expect(directory.saves).toBe(0);
  expect(directory.session).toBeUndefined();
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
  if (issued.kind === 'redirect') {
    const noticeId = cookieValue(issued.cookies, 'switchboard_flash');
    expect(directory.notices.get(noticeId ?? '')).toEqual({
      type: 'issued',
      id: 'agent-id',
      name: 'alpha',
      token: 'issued-token',
    });
    expect(issued.cookies.join('\n')).not.toContain('issued-token');
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

  await handleDeskForm(
    fields({
      intent: 'issue',
      id: '00000000-0000-4000-8000-000000000001',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: client, sessionId }),
  );
  expect(client.calls).toContain('issue');

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
    location: '/?error=unknown',
    cookies: [],
  });
  expect(JSON.stringify(unknown)).not.toContain('rotated-token');

  directory.saveNotice = () => {
    directory.saves += 1;
    return Promise.resolve({ ok: false, failure: 'unreachable' });
  };
  const lost = await handleDeskForm(
    fields({
      intent: 'issue',
      id: '00000000-0000-4000-8000-000000000001',
      csrf: sessionCsrf,
    }),
    input(directory, { writes: client, sessionId }),
  );
  expect(lost).toEqual({
    kind: 'redirect',
    location: '/?error=unknown',
    cookies: [],
  });
  expect(JSON.stringify(lost)).not.toContain('rotated-token');

  directory.saveNotice = memoryDirectory().saveNotice.bind(directory);
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
