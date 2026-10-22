'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { Spinner } from './ui';
import type { UserProfile } from '@/lib/types';

/**
 * Gate a page on sign-in and (optionally) a completed onboarding — height is
 * the scan's scale anchor, so nothing downstream works without it.
 */
export function RequireUser({
  needsProfile = true,
  children,
}: {
  needsProfile?: boolean;
  children: (user: UserProfile) => React.ReactNode;
}) {
  const { user, loading } = useSession();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace(`/signin?next=${encodeURIComponent(path)}`);
    else if (needsProfile && user.heightCm == null) router.replace(`/onboarding?next=${encodeURIComponent(path)}`);
  }, [loading, user, needsProfile, router, path]);

  if (loading || !user || (needsProfile && user.heightCm == null)) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  return <>{children(user)}</>;
}
