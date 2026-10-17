import { expect, test } from 'vitest';
import { ConfigError, readConfig } from './config.js';

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
    expect(error).toBeInstanceOf(ConfigError);
    expect(error instanceof ConfigError ? error.message : '').not.toContain(
      secret,
    );
  }
  expect(() =>
    readConfig({
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
      SWITCHBOARD_TOKEN: `${'a'.repeat(128)}b`,
    }),
  ).toThrow('SWITCHBOARD_TOKEN is invalid');
});

test('readConfig allows http only for loopback hosts', () => {
  for (const url of [
    'http://localhost:3001',
    'http://LOCALHOST:3001',
    'http://127.0.0.1:3001',
    'http://127.42.1.2:9',
    'http://[::1]:3001',
  ]) {
    expect(
      readConfig({ SWITCHBOARD_URL: url, SWITCHBOARD_TOKEN: token }).url,
    ).toBe(new URL(url).origin);
  }
  for (const url of [
    'http://example.com',
    'http://10.1.2.3:3001',
    'http://[::2]:3001',
  ]) {
    expect(() =>
      readConfig({ SWITCHBOARD_URL: url, SWITCHBOARD_TOKEN: token }),
    ).toThrow('SWITCHBOARD_URL must use https');
  }
  expect(
    readConfig({
      SWITCHBOARD_URL: 'https://example.com/base',
      SWITCHBOARD_TOKEN: token,
    }),
  ).toEqual({ url: 'https://example.com/base', token });
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
