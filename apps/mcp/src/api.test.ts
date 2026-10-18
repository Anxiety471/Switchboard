import { expect, test } from 'vitest';
import { mapApiError } from './api.js';

test('maps API error statuses onto stable messages', () => {
  expect(mapApiError(401, { error: 'unauthorized' })).toMatchObject({
    status: 401,
    message: 'unauthorized',
  });
  expect(mapApiError(400, { error: 'invalid request' })).toMatchObject({
    status: 400,
    message: 'invalid request',
  });
  expect(mapApiError(503, { error: 'database_unavailable' })).toMatchObject({
    status: 503,
    message: 'database_unavailable',
  });
  expect(mapApiError(404, { error: 'recipient not found' })).toMatchObject({
    status: 404,
    message: 'recipient not found',
  });
  expect(mapApiError(413, 'payload too large')).toMatchObject({
    status: 413,
    message: 'invalid request',
  });
  expect(mapApiError(414, '<html>URI Too Long</html>')).toMatchObject({
    status: 414,
    message: 'request too large',
  });
  expect(
    mapApiError(431, { error: '<html>Request Header Fields Too Large</html>' }),
  ).toMatchObject({
    status: 431,
    message: 'request too large',
  });
  expect(mapApiError(500, { error: 'internal error' })).toMatchObject({
    status: 500,
    message: 'internal error',
  });
  expect(mapApiError(502, { error: 'bad gateway' })).toMatchObject({
    status: 502,
    message: 'request_failed',
  });
});

test('drops API error text that is not a known message', () => {
  const secret = 'raw-token-value';
  const mapped = [
    mapApiError(400, { error: `bad ${secret}` }),
    mapApiError(401, { error: secret }),
    mapApiError(503, `<html>${secret}</html>`),
    mapApiError(503, { error: { detail: secret } }),
    mapApiError(431, `<html>${secret}</html>`),
    mapApiError(414, { error: secret }),
  ];
  for (const error of mapped) {
    expect(error.message).not.toContain(secret);
    expect(`${error.status} ${error.message}`).not.toContain(secret);
  }
  expect(mapped.map((error) => error.message)).toEqual([
    'invalid request',
    'unauthorized',
    'database_unavailable',
    'database_unavailable',
    'request too large',
    'request too large',
  ]);
});
