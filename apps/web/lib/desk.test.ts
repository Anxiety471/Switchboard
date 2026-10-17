import { expect, test } from 'vitest';
import {
  ReturnPathError,
  formCsrfValid,
  issueFormCsrf,
  safeReturnPath,
  serializeCookie,
  sessionCookie,
} from './desk';

const SECRET = 'desk-secret-desk-secret-desk-secret';

test('a form csrf token matches only the configured secret and expiry', () => {
  const now = 1_700_000_000_000;
  const token = issueFormCsrf(SECRET, now);
  expect(formCsrfValid(SECRET, token, now + 1_000)).toBe(true);
  expect(
    formCsrfValid('other-secret-other-secret-other', token, now + 1_000),
  ).toBe(false);
  expect(formCsrfValid(SECRET, `${token}x`, now + 1_000)).toBe(false);
  expect(formCsrfValid(SECRET, token, now + 3 * 60 * 60 * 1000)).toBe(false);
  expect(token).not.toContain(SECRET);
});

test('return paths stay on this desk and control characters are rejected', () => {
  expect(safeReturnPath('/?inbox=abc')).toBe('/?inbox=abc');
  expect(safeReturnPath('//evil.example')).toBe('/');
  expect(safeReturnPath('https://evil.example')).toBe('/');
  expect(safeReturnPath('/\\evil')).toBe('/');
  expect(safeReturnPath(null)).toBe('/');

  for (const value of ['/\t', '/\r', '/ok\n', '/\u0000', '/\u007F']) {
    expect(() => safeReturnPath(value)).toThrow(ReturnPathError);
    try {
      safeReturnPath(value);
    } catch (error) {
      expect(error).toBeInstanceOf(ReturnPathError);
      expect((error as ReturnPathError).status).toBe(400);
    }
  }
});

test('session cookies are HttpOnly and Secure only when asked', () => {
  const plain = serializeCookie(
    'switchboard_desk',
    'session-id',
    sessionCookie(false),
  );
  expect(plain).toContain('HttpOnly');
  expect(plain).toContain('SameSite=Lax');
  expect(plain).toContain('Path=/');
  expect(plain).not.toContain('Secure');

  const secure = serializeCookie(
    'switchboard_desk',
    'session-id',
    sessionCookie(true),
  );
  expect(secure).toContain('Secure');
  expect(secure).not.toContain(SECRET);
});
