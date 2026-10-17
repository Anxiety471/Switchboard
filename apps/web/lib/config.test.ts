import { expect, test } from 'vitest';
import { readDeskConfig } from './config';

test('reads a loopback desk config and rejects unsafe urls', () => {
  expect(
    readDeskConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001/',
      DASHBOARD_SECRET: 'desk-secret',
    }),
  ).toEqual({
    url: 'http://127.0.0.1:3001',
    secret: 'desk-secret',
  });
  expect(
    readDeskConfig({
      SWITCHBOARD_URL: 'https://ledger.example/switchboard/',
      DASHBOARD_SECRET: 'desk-secret',
    }),
  ).toEqual({
    url: 'https://ledger.example/switchboard',
    secret: 'desk-secret',
  });

  const rejected = [
    {},
    { SWITCHBOARD_URL: 'http://127.0.0.1:3001', DASHBOARD_SECRET: '' },
    { SWITCHBOARD_URL: '', DASHBOARD_SECRET: 'desk-secret' },
    { SWITCHBOARD_URL: 'http://example.com', DASHBOARD_SECRET: 'desk-secret' },
    {
      SWITCHBOARD_URL: 'http://user:pass@127.0.0.1:3001',
      DASHBOARD_SECRET: 'desk-secret',
    },
    {
      SWITCHBOARD_URL: 'http://127.0.0.1:3001?x=1',
      DASHBOARD_SECRET: 'desk-secret',
    },
    { SWITCHBOARD_URL: 'ftp://127.0.0.1', DASHBOARD_SECRET: 'desk-secret' },
    {
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      DASHBOARD_SECRET: 'line\nsecret',
    },
  ];
  for (const env of rejected) {
    expect(readDeskConfig(env)).toBeUndefined();
  }
});
