import { expect, test } from 'vitest';
import {
  deskSessionValid,
  deskSessionValue,
  safeReturnPath,
  stageFlash,
  takeFlash,
} from './desk';

test('session cookies match only the configured secret', () => {
  const secret = 'desk-secret';
  expect(deskSessionValid(secret, deskSessionValue(secret))).toBe(true);
  expect(deskSessionValid(secret, deskSessionValue('other'))).toBe(false);
  expect(deskSessionValid(secret, undefined)).toBe(false);
  expect(deskSessionValid('', deskSessionValue(''))).toBe(false);
  expect(deskSessionValue(secret)).not.toContain(secret);
});

test('return paths stay on this desk', () => {
  expect(safeReturnPath('/?inbox=abc')).toBe('/?inbox=abc');
  expect(safeReturnPath('//evil.example')).toBe('/');
  expect(safeReturnPath('https://evil.example')).toBe('/');
  expect(safeReturnPath('/\\evil')).toBe('/');
  expect(safeReturnPath(null)).toBe('/');
});

test('a flash is readable once', () => {
  const id = stageFlash({
    type: 'issued',
    id: 'agent',
    name: 'alpha',
    token: 'shown-once',
  });
  expect(takeFlash(id)).toEqual({
    type: 'issued',
    id: 'agent',
    name: 'alpha',
    token: 'shown-once',
  });
  expect(takeFlash(id)).toBeUndefined();
});
