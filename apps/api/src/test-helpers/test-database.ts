export function assertTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('TEST_DATABASE_URL is required');
  }
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    throw new Error('TEST_DATABASE_URL is invalid');
  }
  const name = decodeURIComponent(pathname.replace(/^\//, ''));
  if (name === '' || name.includes('/')) {
    throw new Error('TEST_DATABASE_URL is invalid');
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database ${JSON.stringify(name)}; the name must end in _test`,
    );
  }
  return value;
}
