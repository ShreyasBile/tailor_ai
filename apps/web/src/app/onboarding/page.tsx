'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Check, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { RequireUser } from '@/components/guard';
import { Button, Card, Field, Segmented, cx, inputClass } from '@/components/ui';
import type { FitPreference, UserProfile } from '@/lib/types';

type Sex = 'FEMALE' | 'MALE' | 'UNSPECIFIED';

function Onboarding({ user }: { user: UserProfile }) {
  const router = useRouter();
  const raw = useSearchParams().get('next') ?? '/scan';
  const next = raw.startsWith('/onboarding') ? '/scan' : raw;
  const { reload } = useSession();

  const [name, setName] = useState(user.displayName ?? '');
  const [units, setUnits] = useState<'cm' | 'ft'>('cm');
  const [heightCm, setHeightCm] = useState(user.heightCm ? String(user.heightCm) : '');
  const [feet, setFeet] = useState('');
  const [inches, setInches] = useState('');
  const [weight, setWeight] = useState(user.weightKg ? String(user.weightKg) : '');
  const [sex, setSex] = useState<Sex>(user.sexAtBirth ?? 'UNSPECIFIED');
  const [pref, setPref] = useState<FitPreference>(user.fitPreference ?? 'REGULAR');
  const [consent, setConsent] = useState(false);
  const [retain, setRetain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ kind: string; granted: boolean; revokedAt: string | null }[]>('/me/consents')
      .then((cs) => {
        if (cs.some((c) => c.kind === 'BIOMETRIC_PROCESSING' && c.granted && !c.revokedAt)) setConsent(true);
      })
      .catch(() => {});
  }, []);

  const height =
    units === 'cm' ? Number(heightCm) : (Number(feet) * 12 + Number(inches || 0)) * 2.54;
  const heightOk = Number.isFinite(height) && height >= 120 && height <= 230;

  // Carry the height across a unit switch instead of showing empty fields.
  function switchUnits(to: 'cm' | 'ft') {
    if (to === units) return;
    if (heightOk) {
      if (to === 'ft') {
        const totalIn = Math.round(height / 2.54);
        setFeet(String(Math.floor(totalIn / 12)));
        setInches(String(totalIn % 12));
      } else {
        setHeightCm(String(Math.round(height * 10) / 10));
      }
    }
    setUnits(to);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!heightOk) return setError('Enter your height (120–230 cm). It sets the scale of every measurement.');
    if (!consent) return setError('We need your consent to process body images before you can scan.');
    setError(null);
    setBusy(true);
    try {
      await api('/me', {
        method: 'PATCH',
        body: {
          ...(name.trim() ? { displayName: name.trim() } : {}),
          heightCm: Math.round(height * 10) / 10,
          ...(weight ? { weightKg: Number(weight) } : {}),
          sexAtBirth: sex,
          fitPreference: pref,
        },
      });
      await api('/me/consents', {
        method: 'POST',
        body: { kind: 'BIOMETRIC_PROCESSING', version: 'biometric-v1', granted: true },
      });
      if (retain) {
        await api('/me/consents', {
          method: 'POST',
          body: { kind: 'RAW_MEDIA_RETENTION', version: 'retention-v1', granted: true },
        }).catch(() => {});
      }
      await reload();
      router.push(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="container-page max-w-2xl py-12">
      <p className="eyebrow mb-3">Step 1 of 2 · About you</p>
      <h1 className="font-display text-5xl">Let&apos;s set up your profile</h1>
      <p className="mt-3 text-ink-muted">
        Your height is the one number we can&apos;t see in a photo — it turns pixels into centimetres.
      </p>

      <form onSubmit={submit} className="mt-10 space-y-6">
        <Card className="space-y-6 p-6 sm:p-8">
          <Field label="Name (optional)">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" />
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">Height</span>
              <Segmented
                size="sm"
                value={units}
                onChange={switchUnits}
                options={[
                  { value: 'cm', label: 'cm' },
                  { value: 'ft', label: 'ft / in' },
                ]}
              />
            </div>
            {units === 'cm' ? (
              <input
                className={inputClass}
                inputMode="decimal"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder="175"
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <input className={inputClass} inputMode="numeric" value={feet} onChange={(e) => setFeet(e.target.value)} placeholder="5 ft" />
                <input className={inputClass} inputMode="numeric" value={inches} onChange={(e) => setInches(e.target.value)} placeholder="9 in" />
              </div>
            )}
            <p className="mt-1.5 text-xs text-ink-muted">Measured barefoot. Accuracy here sets the accuracy of everything.</p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Weight (optional)" hint="kg — not used for measurement yet">
              <input className={inputClass} inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="70" />
            </Field>
            <div>
              <span className="mb-1.5 block text-sm font-medium">Sex</span>
              <Segmented
                value={sex}
                onChange={setSex}
                options={[
                  { value: 'FEMALE', label: 'Female' },
                  { value: 'MALE', label: 'Male' },
                  { value: 'UNSPECIFIED', label: 'Other' },
                ]}
              />
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">How do you like clothes to fit?</span>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['SNUG', 'Snug', 'Close to the body'],
                  ['REGULAR', 'Regular', 'As the brand intends'],
                  ['LOOSE', 'Loose', 'Room to move'],
                ] as const
              ).map(([v, label, sub]) => (
                <button
                  type="button"
                  key={v}
                  onClick={() => setPref(v)}
                  className={cx(
                    'focus-ring rounded-xl border p-3 text-left transition',
                    pref === v ? 'border-ink bg-ink text-paper' : 'border-line bg-white hover:border-ink-faint',
                  )}
                >
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className={cx('block text-xs', pref === v ? 'text-paper/70' : 'text-ink-muted')}>{sub}</span>
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card className="space-y-4 p-6 sm:p-8">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-accent" />
            <h2 className="font-semibold">Your photos, your data</h2>
          </div>
          <Check2 checked={consent} onChange={setConsent}>
            <strong>I consent to TailorAI processing my body photos</strong> to measure me and build my Body Profile.
            Required to scan. You can delete your data at any time.
          </Check2>
          <Check2 checked={retain} onChange={setRetain}>
            Keep my original photos beyond 30 days so I can re-process them when the measurement engine improves.
            Optional.
          </Check2>
        </Card>

        {error && <p className="rounded-xl bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}

        <div className="flex justify-end">
          <Button type="submit" size="lg" loading={busy}>
            Continue to scan <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function Check2({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink-soft">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        className={cx(
          'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
          checked ? 'border-accent bg-accent text-white' : 'border-ink-faint bg-white',
        )}
      >
        {checked && <Check className="h-3.5 w-3.5" />}
      </span>
      <span>{children}</span>
    </label>
  );
}

export default function OnboardingPage() {
  return (
    <RequireUser needsProfile={false}>
      {(user) => (
        <Suspense>
          <Onboarding user={user} />
        </Suspense>
      )}
    </RequireUser>
  );
}
