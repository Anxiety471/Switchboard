import { expect, test } from 'vitest';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

test('tests refuse a database whose name does not end in _test', () => {
  expect(() => assertTestDatabaseUrl(undefined)).toThrow(
    /TEST_DATABASE_URL is required/,
  );
  expect(() =>
    assertTestDatabaseUrl(
      'postgres://postgres:postgres@127.0.0.1:5432/switchboard',
    ),
  ).toThrow(/switchboard/);
  expect(() =>
    assertTestDatabaseUrl(
      'postgres://postgres:postgres@127.0.0.1:5432/switchboard_e2e',
    ),
  ).toThrow(/switchboard_e2e/);
  expect(
    assertTestDatabaseUrl(
      'postgres://postgres:postgres@127.0.0.1:5432/switchboard_test',
    ),
  ).toBe('postgres://postgres:postgres@127.0.0.1:5432/switchboard_test');
});
