import { cookies } from 'next/headers';
import { LedgerPage } from '../components/ledger-page';
import { readDeskConfig } from '../lib/config';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  issueFormCsrf,
  themeFromCookie,
  type Flash,
} from '../lib/desk';
import { parseLedgerQuery } from '../lib/href';
import {
  loadLedger,
  readDeskSession,
  takeDeskNotice,
  type DeskFailure,
  type DeskResult,
  type LedgerSnapshot,
} from '../lib/ledger';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function isFailure(value: string): value is DeskFailure {
  return (
    value === 'unconfigured' ||
    value === 'unreachable' ||
    value === 'database_unavailable' ||
    value === 'unauthorized' ||
    value === 'invalid' ||
    value === 'conflict' ||
    value === 'not_found' ||
    value === 'failed' ||
    value === 'unknown'
  );
}

function errorFlash(params: SearchParams): Flash | undefined {
  const raw = params.error;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !isFailure(value)) {
    return undefined;
  }
  return { type: 'failure', failure: value };
}

function sessionMissing(failure: DeskFailure): boolean {
  return (
    failure === 'not_found' ||
    failure === 'invalid' ||
    failure === 'unauthorized'
  );
}

export default async function HomePage(props: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.searchParams;
  const query = parseLedgerQuery(params);
  const jar = await cookies();
  const theme = themeFromCookie(jar.get(THEME_COOKIE)?.value);
  const config = readDeskConfig(process.env);
  const banner = errorFlash(params);

  if (config === undefined) {
    return (
      <LedgerPage
        theme={theme}
        query={query}
        flash={banner}
        csrf=""
        model={{ kind: 'unconfigured' }}
      />
    );
  }

  const formCsrf = issueFormCsrf(config.secret);
  const sessionId = jar.get(DESK_COOKIE)?.value;
  if (sessionId === undefined || sessionId === '') {
    return (
      <LedgerPage
        theme={theme}
        query={query}
        flash={banner}
        csrf={formCsrf}
        model={{ kind: 'login' }}
      />
    );
  }

  const session = await readDeskSession(config, sessionId);
  if (!session.ok) {
    if (sessionMissing(session.failure)) {
      return (
        <LedgerPage
          theme={theme}
          query={query}
          flash={banner}
          csrf={formCsrf}
          model={{ kind: 'login' }}
        />
      );
    }
    return (
      <LedgerPage
        theme={theme}
        query={query}
        flash={banner}
        csrf={formCsrf}
        model={{ kind: 'desk', result: session }}
      />
    );
  }

  let flash = banner;
  const noticeId = jar.get(FLASH_COOKIE)?.value;
  if (noticeId !== undefined && noticeId !== '') {
    const taken = await takeDeskNotice(config, sessionId, noticeId);
    if (taken.ok) {
      flash = taken.value;
    } else if (taken.failure === 'unknown') {
      flash = { type: 'failure', failure: 'unknown' };
    }
  }

  let result: DeskResult<LedgerSnapshot>;
  try {
    result = await loadLedger(config, {
      inboxId: query.inbox,
      historyAfter: query.historyAfter,
      inboxAfter: query.inboxAfter,
    });
  } catch {
    result = { ok: false, failure: 'unreachable' };
  }
  return (
    <LedgerPage
      theme={theme}
      query={query}
      flash={flash}
      csrf={session.value.csrfToken}
      model={{ kind: 'desk', result }}
    />
  );
}
