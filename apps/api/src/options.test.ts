import { expect, test } from 'vitest';
import { runtimeSecrets } from './options.js';

const DESK_SECRET = 'desk-secret-desk-secret-desk-secret';

test('runtime secrets omit blank values and reject a short dashboard secret', () => {
  expect(runtimeSecrets({})).toEqual({});
  expect(
    runtimeSecrets({
      REGISTRATION_SECRET: '',
      DASHBOARD_SECRET: '',
    }),
  ).toEqual({});
  expect(
    runtimeSecrets({
      REGISTRATION_SECRET: 'reg',
      DASHBOARD_SECRET: DESK_SECRET,
    }),
  ).toEqual({
    registrationSecret: 'reg',
    dashboardSecret: DESK_SECRET,
  });
  expect(() =>
    runtimeSecrets({
      DASHBOARD_SECRET: 'too-short',
    }),
  ).toThrow(/DASHBOARD_SECRET must be at least 32 characters/);
});
