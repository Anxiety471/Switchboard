import { expect, test } from 'vitest';
import { isDatabaseUnavailable } from './app.js';

const OUTAGE_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57014',
  '57P01',
  '57P02',
  '57P03',
];

const OUTAGE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'timeout expired',
  'connection terminated',
  'Query read timeout',
  'server closed the connection unexpectedly',
  'the database system is shutting down',
  'the database system is starting up',
];

test('database outages are classified by error code', () => {
  for (const code of OUTAGE_CODES) {
    expect(isDatabaseUnavailable({ code, message: 'unrelated failure' })).toBe(
      true,
    );
  }
  expect(
    isDatabaseUnavailable({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    }),
  ).toBe(true);
});

test('message text is only a fallback when the error has no code', () => {
  for (const message of OUTAGE_MESSAGES) {
    expect(isDatabaseUnavailable({ message })).toBe(true);
    expect(isDatabaseUnavailable({ code: '23505', message })).toBe(false);
  }
  const cancelled = 'canceling statement due to statement timeout';
  expect(isDatabaseUnavailable({ message: cancelled })).toBe(false);
  expect(isDatabaseUnavailable({ code: '23505', message: cancelled })).toBe(
    false,
  );
});

test('non-outage codes stay non-outages even when the message matches', () => {
  for (const code of ['23505', '23503', '23514', '42P01', '55P03', 'ENOENT']) {
    expect(
      isDatabaseUnavailable({
        code,
        message: 'timeout expired while the connection terminated',
      }),
    ).toBe(false);
  }
});

test('nested causes and aggregate errors are classified from their codes', () => {
  expect(
    isDatabaseUnavailable({
      message: 'request failed',
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
    }),
  ).toBe(true);
  expect(
    isDatabaseUnavailable({
      message: 'wrapper',
      cause: {
        code: '57014',
        message: 'canceling statement due to statement timeout',
      },
    }),
  ).toBe(true);
  expect(
    isDatabaseUnavailable({
      errors: [
        { message: 'nope' },
        { code: '57P01', message: 'admin shutdown' },
      ],
    }),
  ).toBe(true);
  expect(
    isDatabaseUnavailable({
      message: 'nope',
      cause: { message: 'Query read timeout' },
    }),
  ).toBe(true);

  const loop: { message: string; cause?: unknown } = { message: 'nope' };
  loop.cause = loop;
  expect(isDatabaseUnavailable(loop)).toBe(false);
  expect(
    isDatabaseUnavailable({ message: 'syntax error', code: '42601' }),
  ).toBe(false);
  expect(isDatabaseUnavailable(null)).toBe(false);
  expect(isDatabaseUnavailable(undefined)).toBe(false);
  expect(isDatabaseUnavailable('ECONNREFUSED')).toBe(false);
});
