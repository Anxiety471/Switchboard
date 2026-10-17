import { expect, test } from 'vitest';
import { readConfig } from './config.js';

const token = 'a'.repeat(43);

test('readConfig requires a URL and a token', () => {
  expect(() => readConfig({})).toThrow('SWITCHBOARD_URL is required');
  expect(() =>
    readConfig({ SWITCHBOARD_URL: 'http://127.0.0.1:3001' }),
  ).toThrow('SWITCHBOARD_TOKEN is required');
  expect(() =>
    readConfig({ SWITCHBOARD_URL: '', SWITCHBOARD_TOKEN: token }),
  ).toThrow('SWITCHBOARD_URL is required');
  expect(() =>
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      SWITCHBOARD_TOKEN: '',
    }),
  ).toThrow('SWITCHBOARD_TOKEN is required');
});

test('readConfig rejects URLs and tokens it would not send', () => {
  const secret = 'not a token';
  const cases = [
    'not a url',
    'ftp://127.0.0.1/mcp',
    'http://user:password@127.0.0.1:3001',
    'http://127.0.0.1:3001?token=super-secret-token',
    'http://127.0.0.1:3001#fragment',
  ];
  for (const url of cases) {
    expect(() =>
      readConfig({ SWITCHBOARD_URL: url, SWITCHBOARD_TOKEN: token }),
    ).toThrow('SWITCHBOARD_URL is invalid');
  }
  expect(() =>
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      SWITCHBOARD_TOKEN: secret,
    }),
  ).toThrow(/^SWITCHBOARD_TOKEN is invalid$/);
  try {
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      SWITCHBOARD_TOKEN: secret,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').not.toContain(secret);
  }
  expect(() =>
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      SWITCHBOARD_TOKEN: `${'a'.repeat(128)}b`,
    }),
  ).toThrow('SWITCHBOARD_TOKEN is invalid');
});

test('readConfig keeps the origin and a non-root path', () => {
  expect(
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001/base/',
      SWITCHBOARD_TOKEN: token,
    }),
  ).toEqual({
    url: 'http://127.0.0.1:3001/base',
    token,
  });
  expect(
    readConfig({
      SWITCHBOARD_URL: 'https://switchboard.example',
      SWITCHBOARD_TOKEN: token,
    }),
  ).toEqual({
    url: 'https://switchboard.example',
    token,
  });
});
