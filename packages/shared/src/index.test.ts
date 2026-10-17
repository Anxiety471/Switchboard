import { expect, test } from 'vitest';
import type { AgentId } from './index.js';

test('AgentId accepts a string', () => {
  const id: AgentId = 'agent_1';
  expect(id).toBe('agent_1');
});
