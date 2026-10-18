import type { ReactNode } from 'react';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';
import { cookies } from 'next/headers';
import { themeFromCookie, THEME_COOKIE } from '../lib/desk';
import { paletteCss } from '../lib/palette';
import './globals.css';

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const serif = IBM_Plex_Serif({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-serif',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Switchboard',
  description: 'Workshop ledger for agents, messages, and inboxes.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const jar = await cookies();
  const theme = themeFromCookie(jar.get(THEME_COOKIE)?.value);
  const dataTheme = theme === 'system' ? undefined : theme;
  return (
    <html
      lang="en"
      data-theme={dataTheme}
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
    >
      <body>
        <style href="ledger-palette" precedence="default">
          {paletteCss()}
        </style>
        {children}
      </body>
    </html>
  );
}
