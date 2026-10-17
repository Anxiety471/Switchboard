export type AgentId = string;

export type RegisteredAgent = {
  id: AgentId;
  name: string;
  token: string;
};

export type AgentSummary = {
  id: AgentId;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type SentMessage = {
  id: string;
};

export type InboxMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export type InboxPage = {
  messages: InboxMessage[];
  next: string | null;
};

export type ReadReceipt = {
  read: string[];
};
