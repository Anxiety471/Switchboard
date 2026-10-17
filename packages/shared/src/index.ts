export type AgentId = string;

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && value.trim().length > 0;
}
