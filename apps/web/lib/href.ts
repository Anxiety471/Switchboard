const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type LedgerQuery = {
  inbox: string | undefined;
  historyAfter: string | undefined;
  inboxAfter: string | undefined;
  inboxInvalid: boolean;
};

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function cursor(value: string | undefined): string | undefined {
  if (value === undefined || !CURSOR.test(value)) {
    return undefined;
  }
  return value;
}

export function parseLedgerQuery(
  params: Record<string, string | string[] | undefined>,
): LedgerQuery {
  const inboxValue = first(params.inbox);
  const inboxInvalid =
    inboxValue !== undefined && inboxValue !== '' && !UUID.test(inboxValue);
  return {
    inbox:
      inboxValue !== undefined && UUID.test(inboxValue)
        ? inboxValue
        : undefined,
    historyAfter: cursor(first(params.historyAfter)),
    inboxAfter: cursor(first(params.inboxAfter)),
    inboxInvalid,
  };
}

export function ledgerHref(query: {
  inbox: string | undefined;
  historyAfter: string | undefined;
  inboxAfter: string | undefined;
}): string {
  const params = new URLSearchParams();
  if (query.inbox !== undefined) {
    params.set('inbox', query.inbox);
  }
  if (query.historyAfter !== undefined) {
    params.set('historyAfter', query.historyAfter);
  }
  if (query.inboxAfter !== undefined) {
    params.set('inboxAfter', query.inboxAfter);
  }
  const search = params.toString();
  return search === '' ? '/' : `/?${search}`;
}
