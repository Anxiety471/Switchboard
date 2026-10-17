import type { ReactNode } from 'react';

export const metadata = {
  title: 'Switchboard',
  description: 'Self-hosted message hub for AI coding agents.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
