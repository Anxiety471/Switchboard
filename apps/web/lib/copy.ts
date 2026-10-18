import type { DeskFailure } from './ledger';

const DESK_COPY: Record<DeskFailure, string> = {
  unconfigured:
    'Set DASHBOARD_SECRET and SWITCHBOARD_URL on the web server. Set the same DASHBOARD_SECRET on the API.',
  unreachable:
    'The API is not responding. Start Switchboard and check SWITCHBOARD_URL. Nothing on this desk can be loaded until then.',
  database_unavailable:
    'The database is unavailable (HTTP 503). Postgres is not answering, so the ledger cannot be read or changed.',
  unauthorized:
    'The API rejected the dashboard secret (HTTP 401). DASHBOARD_SECRET on the web server must match the API.',
  invalid:
    'The API rejected that request. Check the name, or return to the first page of the ledger.',
  conflict: 'That name is already on the ledger.',
  not_found: 'That agent is no longer on the ledger.',
  failed:
    'The API returned an unexpected response. The ledger was left unchanged.',
  unknown: 'The API returned an unexpected response. The result is unknown.',
  handover: 'The new token could not be shown. The previous token still works.',
  limited: 'Too many attempts, try again later.',
};

export function failureCopy(
  failure: DeskFailure,
  where: 'login' | 'desk',
): string {
  if (where === 'login' && failure === 'unauthorized') {
    return 'That desk key was not accepted.';
  }
  return DESK_COPY[failure];
}
