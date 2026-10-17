import type { ReactNode } from 'react';
import { AcknowledgeToken } from './acknowledge-token';
import type { DashboardAgent, InboxPage } from '@switchboard/shared';
import { failureCopy } from '../lib/copy';
import type { Flash } from '../lib/desk';
import { formatSeen, formatStamp } from '../lib/format';
import { ledgerHref, type LedgerQuery } from '../lib/href';
import type { DeskFailure, DeskResult, LedgerSnapshot } from '../lib/ledger';

export type LedgerModel =
  | { kind: 'unconfigured' }
  | { kind: 'login' }
  | { kind: 'desk'; result: DeskResult<LedgerSnapshot> };

export type LedgerPageProps = {
  theme: 'light' | 'dark' | 'system';
  query: LedgerQuery;
  flash: Flash | undefined;
  csrf: string;
  model: LedgerModel;
};

function Banner(props: { failure: DeskFailure; where: 'login' | 'desk' }) {
  return (
    <p className="banner" role="alert">
      {failureCopy(props.failure, props.where)}
    </p>
  );
}

function Shell(props: {
  theme: LedgerPageProps['theme'];
  returnTo: string;
  signedIn: boolean;
  csrf: string;
  children: ReactNode;
}) {
  return (
    <>
      <a className="skip" href="#ledger">
        Skip to ledger
      </a>
      <div className="frame">
        <header className="masthead">
          <div>
            <p className="eyebrow">Paper workshop ledger</p>
            <h1>
              <a href="/">Switchboard</a>
            </h1>
            <p className="lede">Agents, messages, and inboxes.</p>
          </div>
          <div className="masthead-actions">
            <form method="post" action="/desk" className="theme-switch">
              <input type="hidden" name="intent" value="theme" />
              <input type="hidden" name="returnTo" value={props.returnTo} />
              <input type="hidden" name="csrf" value={props.csrf} />
              <button
                type="submit"
                name="theme"
                value="light"
                aria-pressed={props.theme === 'light'}
              >
                Light
              </button>
              <button
                type="submit"
                name="theme"
                value="dark"
                aria-pressed={props.theme === 'dark'}
              >
                Dark
              </button>
            </form>
            {props.signedIn ? (
              <form method="post" action="/desk">
                <input type="hidden" name="intent" value="logout" />
                <input type="hidden" name="csrf" value={props.csrf} />
                <button type="submit" className="secondary">
                  Close desk
                </button>
              </form>
            ) : null}
          </div>
        </header>
        <main id="ledger">{props.children}</main>
        <footer className="colophon">
          <p>Tokens are shown once. The API stores only a SHA-256 hash.</p>
        </footer>
      </div>
    </>
  );
}

function Notices(props: {
  flash: Flash | undefined;
  where: 'login' | 'desk';
  csrf: string;
}) {
  if (props.flash === undefined) {
    return null;
  }
  if (props.flash.type === 'issued') {
    return (
      <section className="token-slip" aria-live="polite">
        <h2>Token issued for {props.flash.name}</h2>
        <p>
          Copy this token now. Switchboard stores only its SHA-256 hash, and
          this slip is shown once.
        </p>
        {props.flash.handover ? (
          <p>The previous token stops working once this slip has been shown.</p>
        ) : null}
        <pre>
          <code>{props.flash.token}</code>
        </pre>
        <AcknowledgeToken />
        <form method="post" action="/desk">
          <input type="hidden" name="intent" value="ack-token" />
          <input type="hidden" name="csrf" value={props.csrf} />
          <button type="submit">Acknowledge this token</button>
        </form>
      </section>
    );
  }
  if (props.flash.type === 'revoked') {
    return (
      <p className="banner" role="status">
        The token for {props.flash.name} was revoked. Issue a new one before
        that agent can sign in again.
      </p>
    );
  }
  return <Banner failure={props.flash.failure} where={props.where} />;
}

function recipient(value: string): string {
  return value === '*' ? 'All agents' : value;
}

function Desk(props: {
  snapshot: LedgerSnapshot;
  query: LedgerQuery;
  returnTo: string;
  csrf: string;
}) {
  const { snapshot, query, returnTo, csrf } = props;
  const selected = snapshot.agents.find((agent) => agent.id === query.inbox);
  return (
    <>
      <section className="folio" aria-labelledby="register-heading">
        <h2 id="register-heading">01 Register</h2>
        <form method="post" action="/desk" className="register-form">
          <input type="hidden" name="intent" value="register" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="csrf" value={csrf} />
          <label htmlFor="agent-name">Agent name</label>
          <input
            id="agent-name"
            name="name"
            required
            maxLength={64}
            pattern={'[A-Za-z0-9][A-Za-z0-9_\\-]*'}
            autoComplete="off"
          />
          <button type="submit">Register agent</button>
        </form>
        <p className="hint">
          Start with a letter or number, then use letters, numbers, underscores,
          or hyphens. A later token keeps the previous one working until the new
          slip has been shown.
        </p>
      </section>

      <section className="folio" aria-labelledby="agents-heading">
        <h2 id="agents-heading">02 Agents</h2>
        {snapshot.agents.length === 0 ? (
          <p>No agents are registered yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table">
              <caption className="visually-hidden">Registered agents</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Token</th>
                  <th scope="col">Desk</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    current={agent.id === query.inbox}
                    query={query}
                    returnTo={returnTo}
                    csrf={csrf}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="folio" aria-labelledby="history-heading">
        <h2 id="history-heading">03 Message history</h2>
        {snapshot.historyReset ? (
          <p>The page marker was not valid, so the first page is shown.</p>
        ) : null}
        {snapshot.history.messages.length === 0 ? (
          <p>No messages have been sent.</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table">
              <caption className="visually-hidden">Message history</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Body</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.history.messages.map((message) => (
                  <tr key={message.id}>
                    <td className="when">{formatStamp(message.createdAt)}</td>
                    <td>{message.from}</td>
                    <td>{recipient(message.to)}</td>
                    <td className="message">{message.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className="pager" aria-label="Message history pages">
          {query.historyAfter !== undefined ? (
            <a
              href={ledgerHref({
                inbox: query.inbox,
                historyAfter: undefined,
                inboxAfter: query.inboxAfter,
              })}
            >
              First page
            </a>
          ) : null}
          {snapshot.history.next !== null ? (
            <a
              href={ledgerHref({
                inbox: query.inbox,
                historyAfter: snapshot.history.next,
                inboxAfter: query.inboxAfter,
              })}
            >
              Next page
            </a>
          ) : null}
        </nav>
      </section>

      <section className="folio" aria-labelledby="inbox-heading">
        <h2 id="inbox-heading">
          {selected === undefined
            ? '04 Inbox'
            : `04 Inbox for ${selected.name}`}
        </h2>
        <p className="hint">Reading this inbox does not mark messages read.</p>
        {query.inboxInvalid ? <p>That inbox link is not valid.</p> : null}
        {snapshot.inboxMissing ? (
          <p>{failureCopy('not_found', 'desk')}</p>
        ) : null}
        {snapshot.inboxReset ? (
          <p>The page marker was not valid, so the first page is shown.</p>
        ) : null}
        {query.inbox === undefined && !query.inboxInvalid ? (
          <p>Select an agent in the register to open their inbox.</p>
        ) : null}
        {snapshot.inbox !== null ? (
          <InboxTable
            inbox={snapshot.inbox}
            query={query}
            next={snapshot.inbox.next}
          />
        ) : null}
      </section>
    </>
  );
}

function AgentRow(props: {
  agent: DashboardAgent;
  current: boolean;
  query: LedgerQuery;
  returnTo: string;
  csrf: string;
}) {
  const { agent, query, returnTo, csrf } = props;
  return (
    <tr data-current={props.current ? 'true' : undefined}>
      <th scope="row">
        <a
          href={ledgerHref({
            inbox: agent.id,
            historyAfter: query.historyAfter,
            inboxAfter: undefined,
          })}
          aria-current={props.current ? 'page' : undefined}
        >
          {agent.name}
        </a>
      </th>
      <td>
        <span className="status">
          <span
            className={agent.online ? 'mark mark-online' : 'mark mark-offline'}
            aria-hidden="true"
          />
          {agent.online ? 'Online' : 'Offline'}
        </span>
      </td>
      <td className="when">{formatSeen(agent.lastSeenAt)}</td>
      <td>{agent.tokenRevoked ? 'Revoked' : 'Active'}</td>
      <td>
        <div className="row-actions">
          <form method="post" action="/desk">
            <input type="hidden" name="intent" value="issue" />
            <input type="hidden" name="id" value={agent.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="csrf" value={csrf} />
            <button type="submit">Issue new token</button>
          </form>
          {agent.tokenRevoked ? null : (
            <details>
              <summary>Revoke token</summary>
              <form method="post" action="/desk">
                <input type="hidden" name="intent" value="revoke" />
                <input type="hidden" name="id" value={agent.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="csrf" value={csrf} />
                <p>This signs {agent.name} out until you issue a new token.</p>
                <button type="submit">Revoke token for {agent.name}</button>
              </form>
            </details>
          )}
        </div>
      </td>
    </tr>
  );
}

function InboxTable(props: {
  inbox: InboxPage;
  query: LedgerQuery;
  next: string | null;
}) {
  if (props.inbox.messages.length === 0) {
    return <p>This inbox is empty.</p>;
  }
  return (
    <>
      <div className="table-wrap">
        <table className="ledger-table">
          <caption className="visually-hidden">Agent inbox</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Read</th>
              <th scope="col">Body</th>
            </tr>
          </thead>
          <tbody>
            {props.inbox.messages.map((message) => (
              <tr key={message.id}>
                <td className="when">{formatStamp(message.createdAt)}</td>
                <td>{message.from}</td>
                <td>{recipient(message.to)}</td>
                <td>
                  {message.readAt === null
                    ? 'Unread'
                    : `Read ${formatStamp(message.readAt)}`}
                </td>
                <td className="message">{message.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Inbox pages">
        {props.query.inboxAfter !== undefined ? (
          <a
            href={ledgerHref({
              inbox: props.query.inbox,
              historyAfter: props.query.historyAfter,
              inboxAfter: undefined,
            })}
          >
            First page
          </a>
        ) : null}
        {props.next !== null ? (
          <a
            href={ledgerHref({
              inbox: props.query.inbox,
              historyAfter: props.query.historyAfter,
              inboxAfter: props.next,
            })}
          >
            Next page
          </a>
        ) : null}
      </nav>
    </>
  );
}

export function LedgerPage(props: LedgerPageProps) {
  const returnTo = ledgerHref(props.query);
  const where = props.model.kind === 'login' ? 'login' : 'desk';
  const flashFailure =
    props.flash?.type === 'failure' ? props.flash.failure : undefined;
  return (
    <Shell
      theme={props.theme}
      returnTo={returnTo}
      signedIn={props.model.kind === 'desk'}
      csrf={props.csrf}
    >
      <Notices flash={props.flash} where={where} csrf={props.csrf} />
      {props.model.kind === 'unconfigured' ? (
        <Banner failure="unconfigured" where="desk" />
      ) : null}
      {props.model.kind === 'login' ? (
        <section className="folio" aria-labelledby="login-heading">
          <h2 id="login-heading">Open the desk</h2>
          <p className="hint">
            Enter the dashboard secret. It stays on this server and is not
            stored in the page.
          </p>
          <form method="post" action="/desk" className="login-form">
            <input type="hidden" name="intent" value="login" />
            <input type="hidden" name="csrf" value={props.csrf} />
            <label className="visually-hidden" htmlFor="desk-user">
              Desk
            </label>
            <input
              className="visually-hidden"
              id="desk-user"
              name="username"
              type="text"
              autoComplete="username"
              defaultValue="desk"
            />
            <label htmlFor="desk-key">Desk key</label>
            <input
              id="desk-key"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
            <button type="submit">Open ledger</button>
          </form>
        </section>
      ) : null}
      {props.model.kind === 'desk' && !props.model.result.ok ? (
        props.model.result.failure === flashFailure ? null : (
          <Banner failure={props.model.result.failure} where="desk" />
        )
      ) : null}
      {props.model.kind === 'desk' && props.model.result.ok ? (
        <Desk
          snapshot={props.model.result.value}
          query={props.query}
          returnTo={returnTo}
          csrf={props.csrf}
        />
      ) : null}
    </Shell>
  );
}
