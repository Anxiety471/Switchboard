import { expect, test } from 'vitest';
import { ledgerHref, parseLedgerQuery } from './href';

const INBOX = '00000000-0000-4000-8000-000000000001';
const CURSOR = '2026-10-17T12:04:00.000Z|00000000-0000-4000-8000-000000000010';

test('builds ledger links and drops invalid query values', () => {
  expect(
    ledgerHref({
      inbox: undefined,
      historyAfter: undefined,
      inboxAfter: undefined,
    }),
  ).toBe('/');
  const href = ledgerHref({
    inbox: INBOX,
    historyAfter: CURSOR,
    inboxAfter: undefined,
  });
  expect(href.startsWith('/?')).toBe(true);
  const params = new URLSearchParams(href.slice(2));
  expect(params.get('inbox')).toBe(INBOX);
  expect(params.get('historyAfter')).toBe(CURSOR);

  expect(parseLedgerQuery({})).toEqual({
    inbox: undefined,
    historyAfter: undefined,
    inboxAfter: undefined,
    inboxInvalid: false,
  });
  expect(
    parseLedgerQuery({
      inbox: INBOX,
      historyAfter: CURSOR,
      inboxAfter: 'nope',
    }),
  ).toEqual({
    inbox: INBOX,
    historyAfter: CURSOR,
    inboxAfter: undefined,
    inboxInvalid: false,
  });
  expect(parseLedgerQuery({ inbox: 'alpha' }).inboxInvalid).toBe(true);
  expect(parseLedgerQuery({ inbox: 'alpha' }).inbox).toBeUndefined();
});
