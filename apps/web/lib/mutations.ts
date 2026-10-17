import { readDeskConfig, type DeskConfig, type EnvSource } from './config';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  deskSessionValid,
  deskSessionValue,
  flashCookie,
  safeReturnPath,
  secretsEqual,
  sessionCookie,
  stageFlash,
  themeCookie,
  type CookieOptions,
  type Flash,
} from './desk';
import {
  issueAgentToken,
  registerAgent,
  revokeAgentToken,
  type DeskResult,
} from './ledger';
import type { RegisteredAgent, RevokedAgent } from '@switchboard/shared';

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CookieJar = {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string): void;
};

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

const defaultWrites: LedgerWrites = {
  registerAgent,
  issueAgentToken,
  revokeAgentToken,
};

function envString(env: EnvSource, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value : '';
}

function remember(jar: CookieJar, secure: boolean, flash: Flash): void {
  jar.set(FLASH_COOKIE, stageFlash(flash), flashCookie(secure));
}

function agentId(form: FormData): string | undefined {
  const id = form.get('id');
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    return undefined;
  }
  return id;
}

export async function handleDeskForm(
  form: FormData,
  input: {
    env: EnvSource;
    jar: CookieJar;
    secure: boolean;
    writes?: LedgerWrites;
  },
): Promise<string> {
  const writes = input.writes ?? defaultWrites;
  const intent = form.get('intent');
  const returnTo = safeReturnPath(form.get('returnTo'));
  if (intent === 'theme') {
    const theme = form.get('theme');
    if (theme === 'light' || theme === 'dark') {
      input.jar.set(THEME_COOKIE, theme, themeCookie(input.secure));
    }
    return returnTo;
  }
  if (intent === 'logout') {
    input.jar.delete(DESK_COOKIE);
    return '/';
  }

  const secret = envString(input.env, 'DASHBOARD_SECRET');
  if (secret === '') {
    return '/';
  }
  if (intent === 'login') {
    const password = form.get('password');
    if (typeof password !== 'string' || !secretsEqual(secret, password)) {
      remember(input.jar, input.secure, {
        type: 'failure',
        failure: 'unauthorized',
      });
      return '/';
    }
    input.jar.set(
      DESK_COOKIE,
      deskSessionValue(secret),
      sessionCookie(input.secure),
    );
    return '/';
  }
  if (!deskSessionValid(secret, input.jar.get(DESK_COOKIE))) {
    remember(input.jar, input.secure, {
      type: 'failure',
      failure: 'unauthorized',
    });
    return '/';
  }

  const config = readDeskConfig(input.env);
  if (config === undefined) {
    remember(input.jar, input.secure, {
      type: 'failure',
      failure: 'unconfigured',
    });
    return returnTo;
  }

  if (intent === 'register') {
    const name = form.get('name');
    if (typeof name !== 'string' || name === '') {
      remember(input.jar, input.secure, {
        type: 'failure',
        failure: 'invalid',
      });
      return returnTo;
    }
    const result = await writes.registerAgent(config, name);
    if (!result.ok) {
      remember(input.jar, input.secure, {
        type: 'failure',
        failure: result.failure,
      });
      return returnTo;
    }
    remember(input.jar, input.secure, {
      type: 'issued',
      id: result.value.id,
      name: result.value.name,
      token: result.value.token,
    });
    return returnTo;
  }

  if (intent === 'issue' || intent === 'revoke') {
    const id = agentId(form);
    if (id === undefined) {
      remember(input.jar, input.secure, {
        type: 'failure',
        failure: 'invalid',
      });
      return returnTo;
    }
    if (intent === 'issue') {
      const result = await writes.issueAgentToken(config, id);
      if (!result.ok) {
        remember(input.jar, input.secure, {
          type: 'failure',
          failure: result.failure,
        });
        return returnTo;
      }
      remember(input.jar, input.secure, {
        type: 'issued',
        id: result.value.id,
        name: result.value.name,
        token: result.value.token,
      });
      return returnTo;
    }
    const result = await writes.revokeAgentToken(config, id);
    if (!result.ok) {
      remember(input.jar, input.secure, {
        type: 'failure',
        failure: result.failure,
      });
      return returnTo;
    }
    remember(input.jar, input.secure, {
      type: 'revoked',
      name: result.value.name,
    });
    return returnTo;
  }

  return returnTo;
}
