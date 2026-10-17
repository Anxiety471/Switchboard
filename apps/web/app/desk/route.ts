import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { handleDeskForm, type CookieJar } from '../../lib/mutations';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<void> {
  const form = await request.formData();
  const jar = await cookies();
  const headerStore = await headers();
  const adapter: CookieJar = {
    get(name) {
      return jar.get(name)?.value;
    },
    set(name, value, options) {
      jar.set(name, value, options);
    },
    delete(name) {
      jar.delete(name);
    },
  };
  const destination = await handleDeskForm(form, {
    env: process.env,
    jar: adapter,
    secure: headerStore.get('x-forwarded-proto') === 'https',
  });
  redirect(destination);
}
