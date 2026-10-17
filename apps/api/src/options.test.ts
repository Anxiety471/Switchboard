import { expect, test } from 'vitest';
import { runtimeSecrets } from './options.js';

test('runtime secrets omit blank values', () => {
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
      DASHBOARD_SECRET: 'desk',
    }),
  ).toEqual({
    registrationSecret: 'reg',
    dashboardSecret: 'desk',
  });
});
