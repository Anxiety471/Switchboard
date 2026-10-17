import { expect, test } from 'vitest';
import { isAgentId } from './index.js';

test('isAgentId accepts non-empty strings', () => {
  expect(isAgentId('agent_1')).toBe(true);
  expect(isAgentId('')).toBe(false);
  expect(isAgentId('   ')).toBe(false);
  expect(isAgentId(1)).toBe(false);
  expect(isAgentId(null)).toBe(false);
});
