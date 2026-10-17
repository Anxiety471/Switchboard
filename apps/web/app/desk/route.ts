import { DESK_COOKIE } from '../../lib/desk';
import { deskClientKey } from '../../lib/login-limit';
import { handleDeskForm } from '../../lib/mutations';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const action = await handleDeskForm(form, {
    env: process.env,
    secure: process.env.COOKIE_SECURE === 'true',
    origin: request.headers.get('origin'),
    host: requestHost(request),
    sessionId: cookieValue(request, DESK_COOKIE),
    clientKey: deskClientKey(request),
  });
  if (action.kind === 'status') {
    return new Response(null, { status: action.status });
  }
  const headers = new Headers();
  headers.set('location', action.location);
  for (const cookie of action.cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

function requestHost(request: Request): string | null {
  const host = request.headers.get('host');
  if (host !== null && host !== '') {
    return host;
  }
  try {
    return new URL(request.url).host;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return undefined;
}
