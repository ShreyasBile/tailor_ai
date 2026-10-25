'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, ScanLine } from 'lucide-react';
import { useSession } from '@/lib/session';
import { cx } from './ui';

const NAV = [
  { href: '/profile', label: 'Body Profile' },
  { href: '/scan', label: 'Scan' },
  { href: '/shop', label: 'Shop' },
  { href: '/accuracy', label: 'Accuracy' },
];

export function Logo() {
  return (
    <Link href="/" className="focus-ring group flex items-center gap-2 rounded-lg">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-paper transition group-hover:bg-accent">
        <ScanLine className="h-4 w-4" />
      </span>
      <span className="font-display text-[22px] leading-none tracking-tight">TailorAI</span>
    </Link>
  );
}

export function Header() {
  const { user, signOut } = useSession();
  const path = usePathname();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-paper/85 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Logo />
        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                'focus-ring rounded-full px-3 py-1.5 font-medium transition',
                path.startsWith(n.href) ? 'bg-black/[0.06] text-ink' : 'text-ink-muted hover:text-ink',
                (n.href === '/scan' || n.href === '/accuracy') && 'hidden sm:inline-flex',
              )}
            >
              {n.label}
            </Link>
          ))}
          {user ? (
            <button
              onClick={async () => {
                await signOut();
                router.push('/');
              }}
              className="focus-ring ml-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-ink-muted transition hover:text-ink"
              // Below md only the icon shows; name the action, not the account.
              aria-label="Sign out"
              title={user.email ? `Sign out (${user.email})` : 'Sign out'}
            >
              <span className="hidden max-w-[10rem] truncate md:inline">{user.displayName ?? user.email}</span>
              <LogOut className="h-4 w-4" />
            </button>
          ) : (
            <Link
              href="/signin"
              className="focus-ring ml-1 rounded-full bg-ink px-4 py-1.5 font-medium text-paper transition hover:bg-ink-soft"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
