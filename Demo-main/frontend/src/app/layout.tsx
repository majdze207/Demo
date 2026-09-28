import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/frontend';

export const metadata: Metadata = {
  title: 'CryptoPlay',
  description: 'Crypto MLM + Casino Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
