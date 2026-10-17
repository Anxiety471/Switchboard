import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { LedgerSnapshot } from '../lib/ledger';
import { LedgerPage, type LedgerPageProps } from './ledger-page';

const query: LedgerPageProps['query'] = {
  inbox: '00000000-0000-4000-8000-000000000002',
  historyAfter: undefined,
  inboxAfter: undefined,
  inboxInvalid: false,
};

const snapshot: LedgerSnapshot = {
  agents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'alpha',
      online: true,
      lastSeenAt: '2026-10-17T12:04:00.000Z',
      createdAt: '2026-10-17T12:00:00.000Z',
      tokenRevoked: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'beta',
      online: false,
      lastSeenAt: null,
      createdAt: '2026-10-17T12:01:00.000Z',
      tokenRevoked: true,
    },
  ],
  history: {
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000010',
        from: 'alpha',
        to: '*',
        body: '<script>alert(1)</script>',
        createdAt: '2026-10-17T12:05:00.000Z',
      },
    ],
    next: '2026-10-17T12:05:00.000Z|00000000-0000-4000-8000-000000000010',
  },
  inbox: {
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        from: 'alpha',
        to: 'beta',
        body: 'hello beta',
        createdAt: '2026-10-17T12:06:00.000Z',
        readAt: null,
      },
    ],
    next: null,
  },
  inboxMissing: false,
  historyReset: false,
  inboxReset: false,
};

function html(props: LedgerPageProps): string {
  return renderToStaticMarkup(<LedgerPage {...props} />);
}

test('renders the ledger, escapes message bodies, and hides stored tokens', () => {
  const markup = html({
    theme: 'light',
    query,
    flash: undefined,
    model: { kind: 'desk', result: { ok: true, value: snapshot } },
  });
  expect(markup).toContain('Switchboard');
  expect(markup).toContain('Paper workshop ledger');
  expect(markup).toContain('Online');
  expect(markup).toContain('Offline');
  expect(markup).toContain('Active');
  expect(markup).toContain('Revoked');
  expect(markup).toContain('All agents');
  expect(markup).toContain('Inbox for beta');
  expect(markup).toContain('Unread');
  expect(markup).toContain('does not mark messages read');
  expect(markup).toContain('Next page');
  expect(markup).toContain('Issue new token');
  expect(markup).toContain('Revoke token for alpha');
  expect(markup).not.toContain('Revoke token for beta');
  expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(markup).not.toContain('<script>alert');
  expect(markup).not.toContain('desk-secret');
  expect(markup).toContain('action="/desk"');
  const pattern = markup.match(/pattern="([^"]+)"/)?.[1] ?? '';
  expect(pattern).toBe('[A-Za-z0-9][A-Za-z0-9_\\-]*');
  expect(() => new RegExp(pattern, 'v')).not.toThrow();
});

test('shows an issued token once in the slip and explains outages', () => {
  const issued = html({
    theme: 'dark',
    query,
    flash: {
      type: 'issued',
      id: 'id',
      name: 'alpha',
      token: 'shown-once-token',
    },
    model: { kind: 'desk', result: { ok: true, value: snapshot } },
  });
  expect(issued).toContain('Copy this token now.');
  expect(issued).toContain('shown-once-token');

  const down = html({
    theme: 'system',
    query,
    flash: undefined,
    model: {
      kind: 'desk',
      result: { ok: false, failure: 'database_unavailable' },
    },
  });
  expect(down).toContain('The database is unavailable (HTTP 503).');
  expect(down).not.toContain('01 Register');

  const unreachable = html({
    theme: 'system',
    query,
    flash: undefined,
    model: { kind: 'desk', result: { ok: false, failure: 'unreachable' } },
  });
  expect(unreachable).toContain('The API is not responding.');

  const login = html({
    theme: 'system',
    query,
    flash: { type: 'failure', failure: 'unauthorized' },
    model: { kind: 'login' },
  });
  expect(login).toContain('That desk key was not accepted.');
  expect(login).toContain('Desk key');
  expect(login).not.toContain('01 Register');

  const unconfigured = html({
    theme: 'system',
    query,
    flash: undefined,
    model: { kind: 'unconfigured' },
  });
  expect(unconfigured).toContain('Set DASHBOARD_SECRET and SWITCHBOARD_URL');
});
