'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { useSession } from '@/lib/session';
import { Button, Card, Field, inputClass } from '@/components/ui';

function SignInForm() {
  const { signIn } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/profile';
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const me = await signIn(email);
      router.push(me.heightCm == null ? `/onboarding?next=${encodeURIComponent(next)}` : next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="container-page grid min-h-[70vh] place-items-center py-12">
      <Card className="w-full max-w-md animate-fade-up p-8">
        <p className="eyebrow mb-3">Welcome</p>
        <h1 className="font-display text-4xl">Sign in to TailorAI</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your Body Profile is saved to your account, so you only scan once.
        </p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <Field label="Email" error={error} hint="Development sign-in: any email address works.">
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputClass}
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
