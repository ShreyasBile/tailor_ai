'use client';

import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowRight, Camera, Lightbulb, RefreshCw, Shirt, Sun, Timer, Trash2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { preparePhoto, uploadPhoto } from '@/lib/upload';
import { VIEWS, type UserProfile, type View } from '@/lib/types';
import { RequireUser } from '@/components/guard';
import { PoseGuide, VIEW_COPY } from '@/components/pose-guide';
import { Button, Card, cx } from '@/components/ui';

const TIPS = [
  { icon: Shirt, text: 'Wear fitted clothes — leggings and a fitted top are ideal. No coats or baggy layers.' },
  { icon: Sun, text: 'Stand against a plain wall in even light. Avoid strong light behind you.' },
  { icon: Camera, text: 'Phone at waist height, about 2–3 m away. Your whole body, head to feet, in frame.' },
  { icon: Timer, text: 'Use the 10-second timer, or ask someone to take the photos for you.' },
];

function ScanFlow({ user }: { user: UserProfile }) {
  const router = useRouter();
  const retake = useSearchParams().get('retake') ?? '';
  // Seeded once from the URL; a slot's flag clears when its photo is replaced.
  const [flagged, setFlagged] = useState(() => new Set(retake.split(',').filter(Boolean)));
  const unflag = (view: View) =>
    setFlagged((prev) => {
      const next = new Set(prev);
      next.delete(view);
      return next;
    });
  const { photos, setPhoto } = useSession();
  const [errors, setErrors] = useState<Partial<Record<View, string>>>({});
  const [phase, setPhase] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const ready = VIEWS.every((v) => photos[v]);
  const count = VIEWS.filter((v) => photos[v]).length;

  async function choose(view: View, file: File) {
    setErrors((e) => ({ ...e, [view]: undefined }));
    try {
      setPhoto(view, await preparePhoto(file));
      unflag(view);
    } catch (err) {
      setErrors((e) => ({ ...e, [view]: (err as Error).message }));
    }
  }

  async function useSamples() {
    setSubmitError(null);
    setPhase('Loading sample photos…');
    try {
      for (const v of VIEWS) {
        const res = await fetch(`/demo-scan/${v}.jpg`);
        const blob = await res.blob();
        setPhoto(v, await preparePhoto(new File([blob], `${v}.jpg`, { type: 'image/jpeg' })));
        unflag(v);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setPhase(null);
    }
  }

  async function submit() {
    setSubmitError(null);
    try {
      setPhase('Creating your scan…');
      const session = await api<{ id: string }>('/capture-sessions', {
        method: 'POST',
        body: { mode: 'PHOTO_SET', deviceModel: navigator.userAgent.slice(0, 120) },
      });
      for (const [i, v] of VIEWS.entries()) {
        setPhase(`Uploading photo ${i + 1} of 4 · ${VIEW_COPY[v].title}`);
        await uploadPhoto(session.id, v, photos[v]!);
      }
      setPhase('Starting analysis…');
      await api(`/capture-sessions/${session.id}/finalise`, { method: 'POST' });
      // Untextured: the viewer renders a clean "clay" body; a texture baked
      // from four stills smears more than it helps.
      const job = await api<{ id: string }>('/jobs', {
        method: 'POST',
        body: { sessionId: session.id, options: { quality: 'standard', textured: false } },
      });
      router.push(`/scan/${job.id}`);
    } catch (err) {
      setSubmitError((err as Error).message);
      setPhase(null);
    }
  }

  return (
    <div className="container-page py-10">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p className="eyebrow mb-3">Step 2 of 2 · Body scan</p>
          <h1 className="font-display text-5xl">Four photos, {user.displayName ?? 'you'}</h1>
          <p className="mt-3 max-w-xl text-ink-muted">
            We&apos;ll measure you at {user.heightCm} cm tall.{' '}
            <a href="/onboarding?next=/scan" className="underline decoration-line underline-offset-4 hover:text-ink">
              Not right?
            </a>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5" aria-label={`${count} of 4 photos`}>
            {VIEWS.map((v) => (
              <span key={v} className={cx('h-1.5 w-8 rounded-full transition', photos[v] ? 'bg-accent' : 'bg-black/10')} />
            ))}
          </div>
          <span className="text-sm text-ink-muted">{count}/4</span>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {VIEWS.map((v) => (
          <Slot
            key={v}
            view={v}
            preview={photos[v]?.previewUrl}
            error={errors[v]}
            flagged={flagged.has(v)}
            disabled={phase !== null}
            onFile={(f) => choose(v, f)}
            onClear={() => setPhoto(v, null)}
          />
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
        <Card className="p-6">
          <p className="mb-4 flex items-center gap-2 font-semibold">
            <Lightbulb className="h-4 w-4 text-accent" /> For an accurate scan
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {TIPS.map((t) => (
              <li key={t.text} className="flex gap-3 text-sm text-ink-soft">
                <t.icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
                {t.text}
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col items-stretch gap-3 lg:w-72">
          <Button size="lg" variant="accent" disabled={!ready} loading={phase !== null} onClick={submit}>
            {phase ? 'Working…' : 'Measure my body'} {!phase && <ArrowRight className="h-4 w-4" />}
          </Button>
          <p className="min-h-[1.25rem] text-center text-sm text-ink-muted" aria-live="polite">
            {phase ?? (ready ? 'Takes about 30 seconds.' : 'Add all four photos to continue.')}
          </p>
          {submitError && <p className="rounded-xl bg-bad/10 px-4 py-3 text-sm text-bad">{submitError}</p>}
          {count === 0 && phase === null && (
            <button
              type="button"
              onClick={useSamples}
              className="focus-ring rounded-lg text-center text-xs text-ink-muted underline decoration-line underline-offset-4 hover:text-ink"
            >
              No photos handy? Try a sample scan (a rendered model)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Slot({
  view,
  preview,
  error,
  flagged,
  disabled,
  onFile,
  onClear,
}: {
  view: View;
  preview?: string;
  error?: string;
  flagged: boolean;
  disabled: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const copy = VIEW_COPY[view];

  return (
    <div className="flex flex-col">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f && !disabled) onFile(f);
        }}
        className={cx(
          'group relative aspect-[3/4] overflow-hidden rounded-xl2 border-2 transition',
          preview ? 'border-transparent bg-black' : 'border-dashed bg-card',
          drag ? 'border-accent bg-accent-soft' : !preview && 'border-line hover:border-ink-faint',
          (flagged || error) && 'border-solid border-warn ring-4 ring-warn/15',
        )}
      >
        {preview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt={`${copy.title} photo`} className="h-full w-full object-contain" />
            <div className="absolute inset-x-2 bottom-2 flex justify-end gap-1.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
              <IconBtn label="Replace" onClick={() => input.current?.click()} disabled={disabled}>
                <RefreshCw className="h-4 w-4" />
              </IconBtn>
              <IconBtn label="Remove" onClick={onClear} disabled={disabled}>
                <Trash2 className="h-4 w-4" />
              </IconBtn>
            </div>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => input.current?.click()}
            className="focus-ring flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-ink-faint transition group-hover:text-ink-muted"
          >
            <PoseGuide view={view} className="h-1/2" />
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper">
              <Upload className="h-3.5 w-3.5" /> Add photo
            </span>
          </button>
        )}
        {flagged && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-warn px-2 py-0.5 text-[11px] font-semibold text-white">
            <AlertTriangle className="h-3 w-3" /> Retake
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </div>
      <div className="mt-3 px-1">
        <p className="font-semibold">{copy.title}</p>
        <p className={cx('mt-0.5 text-xs leading-relaxed', error ? 'text-bad' : 'text-ink-muted')}>{error ?? copy.tip}</p>
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring grid h-9 w-9 place-items-center rounded-full bg-white/90 text-ink shadow-soft backdrop-blur transition hover:bg-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export default function ScanPage() {
  return (
    <RequireUser>
      {(user) => (
        <Suspense>
          <ScanFlow user={user} />
        </Suspense>
      )}
    </RequireUser>
  );
}
