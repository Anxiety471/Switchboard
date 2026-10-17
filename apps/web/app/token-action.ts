'use server';

import { cookies } from 'next/headers';
import { readDeskConfig } from '../lib/config';
import { TOKEN_COOKIE, openIssuedToken } from '../lib/desk';
import { confirmTokenHandover } from '../lib/ledger';

export async function acknowledgeToken(): Promise<void> {
  const jar = await cookies();
  const config = readDeskConfig(process.env);
  const raw = jar.get(TOKEN_COOKIE)?.value;
  if (config === undefined || raw === undefined || raw === '') {
    return;
  }
  const slip = openIssuedToken(config.secret, raw);
  if (slip?.handover !== true) {
    return;
  }
  await confirmTokenHandover(config, slip.id);
}
