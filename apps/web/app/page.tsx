import { cookies } from 'next/headers';
import { LedgerPage } from '../components/ledger-page';
import { readDeskConfig } from '../lib/config';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  deskSessionValid,
  takeFlash,
  themeFromCookie,
} from '../lib/desk';
import { parseLedgerQuery } from '../lib/href';
import {
  loadLedger,
  type DeskResult,
  type LedgerSnapshot,
} from '../lib/ledger';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function envString(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value : '';
}

export default async function HomePage(props: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.searchParams;
  const query = parseLedgerQuery(params);
  const jar = await cookies();
  const theme = themeFromCookie(jar.get(THEME_COOKIE)?.value);
  const flashId = jar.get(FLASH_COOKIE)?.value;
  const flash = flashId === undefined ? undefined : takeFlash(flashId);
  const secret = envString('DASHBOARD_SECRET');
  const config = readDeskConfig(process.env);
  const shell = { theme, query, flash };

  if (secret === '' || config === undefined) {
    return <LedgerPage {...shell} model={{ kind: 'unconfigured' }} />;
  }
  if (!deskSessionValid(secret, jar.get(DESK_COOKIE)?.value)) {
    return <LedgerPage {...shell} model={{ kind: 'login' }} />;
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
  return <LedgerPage {...shell} model={{ kind: 'desk', result }} />;
}
