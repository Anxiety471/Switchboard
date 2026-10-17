import type { RegisteredAgent, RevokedAgent } from '@switchboard/shared';
import { readDeskConfig, type DeskConfig, type EnvSource } from './config';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  clearCookie,
  flashCookie,
  formCsrfValid,
  safeReturnPath,
  secretsEqual,
  serializeCookie,
  sessionCookie,
  themeCookie,
  type Flash,
  ReturnPathError,
} from './desk';
import {
  clearLoginFailures,
  loginLimited,
  noteLoginFailure,
} from './login-limit';
import {
  closeDeskSession,
  issueAgentToken,
  openDeskSession,
  readDeskSession,
  registerAgent,
  revokeAgentToken,
  saveDeskNotice,
  type DeskResult,
} from './ledger';

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeskAction =
  | { kind: 'redirect'; location: string; cookies: string[] }
  | { kind: 'status'; status: 400 | 403 | 429 };

export type LedgerWrites = {
  registerAgent(
    config: DeskConfig,
    name: string,
  ): Promise<DeskResult<RegisteredAgent>>;
  issueAgentToken(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<RegisteredAgent>>;
  revokeAgentToken(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<RevokedAgent>>;
};

export type DeskDirectory = {
  openSession(
    config: DeskConfig,
  ): Promise<DeskResult<{ id: string; csrfToken: string }>>;
  closeSession(config: DeskConfig, id: string): Promise<DeskResult<true>>;
  readSession(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<{ csrfToken: string }>>;
  saveNotice(
    config: DeskConfig,
    id: string,
    flash: Flash,
  ): Promise<DeskResult<{ id: string }>>;
};

const defaultWrites: LedgerWrites = {
  registerAgent,
  issueAgentToken,
  revokeAgentToken,
};

const defaultDirectory: DeskDirectory = {
  openSession: openDeskSession,
  closeSession: closeDeskSession,
  readSession: readDeskSession,
  saveNotice: saveDeskNotice,
};

export type DeskFormInput = {
  env: EnvSource;
  secure: boolean;
  origin: string | null;
  host: string | null;
  sessionId: string | undefined;
  clientKey: string;
  now?: number;
  writes?: LedgerWrites;
  directory?: DeskDirectory;
};

function redirect(location: string, cookies: string[] = []): DeskAction {
  return { kind: 'redirect', location, cookies };
}

function status(code: 400 | 403 | 429): DeskAction {
  return { kind: 'status', status: code };
}

function isAction(value: { id: string } | DeskAction): value is DeskAction {
  return 'kind' in value;
}

function sameOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null || host === null || host === '') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.host === host;
}

function csrfField(form: FormData): string {
  const value = form.get('csrf');
  return typeof value === 'string' ? value : '';
}

function agentId(form: FormData): string | undefined {
  const id = form.get('id');
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    return undefined;
  }
  return id;
}

function themeCookieHeader(form: FormData, secure: boolean): string[] {
  const theme = form.get('theme');
  if (theme !== 'light' && theme !== 'dark') {
    return [];
  }
  return [serializeCookie(THEME_COOKIE, theme, themeCookie(secure))];
}

function clearedSession(secure: boolean): string[] {
  return [clearCookie(DESK_COOKIE, secure), clearCookie(FLASH_COOKIE, secure)];
}

export async function handleDeskForm(
  form: FormData,
  input: DeskFormInput,
): Promise<DeskAction> {
  if (!sameOrigin(input.origin, input.host)) {
    return status(403);
  }
  let returnTo: string;
  try {
    returnTo = safeReturnPath(form.get('returnTo'));
  } catch (error) {
    if (error instanceof ReturnPathError) {
      return status(400);
    }
    throw error;
  }

  const writes = input.writes ?? defaultWrites;
  const directory = input.directory ?? defaultDirectory;
  const now = input.now ?? Date.now();
  const config = readDeskConfig(input.env);
  const intent = form.get('intent');
  const secure = input.secure;

  if (intent === 'theme') {
    const cookies = themeCookieHeader(form, secure);
    if (config === undefined) {
      return redirect(returnTo, cookies);
    }
    if (input.sessionId !== undefined && input.sessionId !== '') {
      const session = await directory.readSession(config, input.sessionId);
      if (session.ok) {
        if (!secretsEqual(session.value.csrfToken, csrfField(form))) {
          return status(403);
        }
        return redirect(returnTo, cookies);
      }
      if (
        session.failure !== 'not_found' &&
        session.failure !== 'invalid' &&
        session.failure !== 'unauthorized'
      ) {
        return status(403);
      }
    }
    if (!formCsrfValid(config.secret, csrfField(form), now)) {
      return status(403);
    }
    return redirect(returnTo, cookies);
  }

  if (config === undefined) {
    if (intent === 'logout') {
      return redirect('/', clearedSession(secure));
    }
    return redirect('/?error=unconfigured');
  }

  if (intent === 'login') {
    if (!formCsrfValid(config.secret, csrfField(form), now)) {
      return status(403);
    }
    if (loginLimited(input.clientKey, now)) {
      return status(429);
    }
    const password = form.get('password');
    if (
      typeof password !== 'string' ||
      !secretsEqual(config.secret, password)
    ) {
      noteLoginFailure(input.clientKey, now);
      return redirect('/?error=unauthorized');
    }
    const opened = await directory.openSession(config);
    if (!opened.ok) {
      return redirect(`/?error=${opened.failure}`);
    }
    clearLoginFailures(input.clientKey);
    return redirect('/', [
      serializeCookie(DESK_COOKIE, opened.value.id, sessionCookie(secure)),
      clearCookie(FLASH_COOKIE, secure),
    ]);
  }

  if (intent === 'logout') {
    const auth = await authorizeSession(directory, config, form, input);
    if (isAction(auth)) {
      return auth;
    }
    await directory.closeSession(config, auth.id);
    return redirect('/', clearedSession(secure));
  }

  const auth = await authorizeSession(directory, config, form, input);
  if (isAction(auth)) {
    return auth;
  }

  if (intent === 'register') {
    const name = form.get('name');
    if (typeof name !== 'string' || name === '') {
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: 'invalid',
      });
    }
    const result = await writes.registerAgent(config, name);
    if (!result.ok) {
      if (result.failure === 'unknown') {
        return redirect('/?error=unknown');
      }
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: result.failure,
      });
    }
    return remember(directory, config, auth.id, secure, returnTo, {
      type: 'issued',
      id: result.value.id,
      name: result.value.name,
      token: result.value.token,
    });
  }

  if (intent === 'issue' || intent === 'revoke') {
    const id = agentId(form);
    if (id === undefined) {
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: 'invalid',
      });
    }
    if (intent === 'issue') {
      const result = await writes.issueAgentToken(config, id);
      if (!result.ok) {
        if (result.failure === 'unknown') {
          return redirect('/?error=unknown');
        }
        return remember(directory, config, auth.id, secure, returnTo, {
          type: 'failure',
          failure: result.failure,
        });
      }
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'issued',
        id: result.value.id,
        name: result.value.name,
        token: result.value.token,
      });
    }
    const result = await writes.revokeAgentToken(config, id);
    if (!result.ok) {
      if (result.failure === 'unknown') {
        return redirect('/?error=unknown');
      }
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: result.failure,
      });
    }
    return remember(directory, config, auth.id, secure, returnTo, {
      type: 'revoked',
      name: result.value.name,
    });
  }

  return redirect(returnTo);
}

async function authorizeSession(
  directory: DeskDirectory,
  config: DeskConfig,
  form: FormData,
  input: DeskFormInput,
): Promise<{ id: string } | DeskAction> {
  const sessionId = input.sessionId;
  if (sessionId === undefined || sessionId === '') {
    return redirect('/?error=unauthorized');
  }
  const session = await directory.readSession(config, sessionId);
  if (!session.ok) {
    if (
      session.failure === 'not_found' ||
      session.failure === 'invalid' ||
      session.failure === 'unauthorized'
    ) {
      return redirect('/?error=unauthorized', [
        clearCookie(DESK_COOKIE, input.secure),
      ]);
    }
    return redirect(`/?error=${session.failure}`);
  }
  if (!secretsEqual(session.value.csrfToken, csrfField(form))) {
    return status(403);
  }
  return { id: sessionId };
}

async function remember(
  directory: DeskDirectory,
  config: DeskConfig,
  sessionId: string,
  secure: boolean,
  returnTo: string,
  flash: Flash,
): Promise<DeskAction> {
  const saved = await directory.saveNotice(config, sessionId, flash);
  if (!saved.ok) {
    if (flash.type === 'issued') {
      return redirect('/?error=unknown');
    }
    return redirect(returnTo);
  }
  return redirect(returnTo, [
    serializeCookie(FLASH_COOKIE, saved.value.id, flashCookie(secure)),
  ]);
}
