import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { enforceRuntimeSecrets, runtimeSecrets } from './options.js';

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

test('a short dashboard secret prints one line and exits non-zero', () => {
  const optionsUrl = new URL('./options.ts', import.meta.url);
  const source = `import { enforceRuntimeSecrets } from ${JSON.stringify(optionsUrl.href)};
enforceRuntimeSecrets({ DASHBOARD_SECRET: 'too-short' });
`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', source],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe(
    'DASHBOARD_SECRET must be at least 32 characters',
  );
  expect(enforceRuntimeSecrets({ DASHBOARD_SECRET: DESK_SECRET })).toEqual({
    dashboardSecret: DESK_SECRET,
  });
});
