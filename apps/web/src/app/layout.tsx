import type { Metadata } from 'next';
import { Inter, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { Header } from '@/components/header';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TailorAI — Body Intelligence',
  description: 'Four photos. A 3D body. Clothes that fit.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans">
        <SessionProvider>
          <Header />
          <main>{children}</main>
          <footer className="container-page mt-24 flex flex-col gap-2 border-t border-line py-8 text-xs text-ink-muted sm:flex-row sm:justify-between">
            <span>TailorAI · Body Intelligence MVP</span>
            <span>Measurements are estimates with stated uncertainty — not a tailor&apos;s tape.</span>
          </footer>
        </SessionProvider>
      </body>
    </html>
  );
}
