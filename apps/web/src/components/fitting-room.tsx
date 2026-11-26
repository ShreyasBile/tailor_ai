'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Info, Layers, Shirt, Sparkles, UserRound } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { FitPreference, FitPreviewView, RecommendationView } from '@/lib/types';
import { Badge, Button, Card, Segmented, Spinner, cx } from './ui';

type Mode = 'product' | 'own';
type View = 'front' | 'back';

const TONE: Record<string, { dot: string; pill: string; label: string }> = {
  bad: { dot: '#b4432f', pill: 'bg-bad text-white', label: 'Too small' },
  warn: { dot: '#b7791f', pill: 'bg-warn text-white', label: 'Snug' },
  good: { dot: '#2f7a4f', pill: 'bg-good text-white', label: 'Good' },
  loose: { dot: '#3b6fb0', pill: 'bg-[#3b6fb0] text-white', label: 'Loose' },
  'bad-loose': { dot: '#284f86', pill: 'bg-[#284f86] text-white', label: 'Too big' },
};

function summaryTone(s: string): 'bad' | 'warn' | 'good' | 'accent' | 'neutral' {
  if (s.startsWith('Very tight')) return 'bad';
  if (s.startsWith('Snug')) return 'warn';
  if (s.startsWith('True')) return 'good';
  return 'accent';
}

/**
 * The fitting room: the shopper's own scan photo, wearing this item in the
 * chosen size — or the top they're wearing, sized like this item. Rendered
 * by our own engine from the fit numbers (no image generation), so a size too
 * small visibly hugs, creases and rides up, and a size too big hangs long.
 */
export function FittingRoom({
  slug,
  garmentName,
  category,
  rec,
  selectedSize,
  onSelectSize,
  preference,
  onNeedSize,
  busy,
}: {
  slug: string;
  garmentName: string;
  category: string;
  rec: RecommendationView | null;
  selectedSize: string | null;
  onSelectSize: (s: string) => void;
  preference: FitPreference;
  onNeedSize: () => void;
  busy: boolean;
}) {
  const isTop = category !== 'BOTTOMS';
  const [mode, setMode] = useState<Mode>('product');
  const [view, setView] = useState<View>('front');
  const [showMap, setShowMap] = useState(true);
  const [compare, setCompare] = useState(false);
  const [cache, setCache] = useState<Record<string, FitPreviewView>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const inflight = useRef(new Map<string, Promise<FitPreviewView>>());

  const size = selectedSize ?? rec?.recommendedSize ?? null;
  const keyFor = useCallback((s: string, m: Mode, v: View) => `${m}|${v}|${s}|${preference}`, [preference]);

  const load = useCallback(
    (s: string, m: Mode, v: View): Promise<FitPreviewView> => {
      const key = keyFor(s, m, v);
      const existing = inflight.current.get(key);
      if (existing) return existing;
      const pr = api<FitPreviewView>(`/garments/${slug}/fit-preview`, {
        method: 'POST',
        body: { size: s, mode: m, view: v, preference },
      }).then((res) => {
        setCache((c) => ({ ...c, [key]: res }));
        return res;
      });
      pr.catch(() => inflight.current.delete(key));
      inflight.current.set(key, pr);
      return pr;
    },
    [slug, preference, keyFor],
  );

  // The shown size (and, when comparing, the recommended one).
  useEffect(() => {
    if (!size || !rec) return;
    const want = [size, ...(compare && rec.recommendedSize !== size ? [rec.recommendedSize] : [])];
    const key = keyFor(size, mode, view);
    if (!cache[key]) setLoadingKey(key);
    setError(null);
    Promise.all(want.map((s) => load(s, mode, view)))
      .catch((err) => setError(err instanceof ApiError ? err.message : (err as Error).message))
      .finally(() => setLoadingKey((k) => (k === key ? null : k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, mode, view, compare, rec?.id, load]);

  // Then every other size, quietly, so tapping through them is instant.
  useEffect(() => {
    if (!rec || !size || !cache[keyFor(size, mode, view)]) return;
    let stop = false;
    (async () => {
      for (const s of rec.sizes.map((x) => x.label)) {
        if (stop) return;
        if (!cache[keyFor(s, mode, view)]) await load(s, mode, view).catch(() => {});
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id, mode, view, size && cache[keyFor(size, mode, view)] ? 1 : 0]);

  const current = size ? cache[keyFor(size, mode, view)] : undefined;
  const base = rec ? cache[keyFor(rec.recommendedSize, mode, view)] : undefined;
  const loading = !!size && loadingKey === keyFor(size, mode, view) && !current;

  if (!rec) {
    return (
      <Card className="grid aspect-[3/4] place-items-center p-8 text-center">
        <div>
          <UserRound className="mx-auto h-8 w-8 text-accent" />
          <h3 className="mt-3 font-semibold">See it on you</h3>
          <p className="mx-auto mt-1 max-w-xs text-sm text-ink-muted">
            We size you first, then dress your own scan photo in every size — tight ones hug, loose ones hang.
          </p>
          <Button variant="accent" className="mt-5" loading={busy} onClick={onNeedSize}>
            <Sparkles className="h-4 w-4" /> Find my size &amp; try it on
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {isTop && (
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'product', label: 'This item' },
              { value: 'own', label: "What I'm wearing" },
            ]}
          />
        )}
        {current?.backAvailable && (
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'front', label: 'Front' },
              { value: 'back', label: 'Back' },
            ]}
          />
        )}
        <button
          type="button"
          onClick={() => setShowMap((v) => !v)}
          aria-pressed={showMap}
          className={cx(
            'focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition',
            showMap ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink-soft hover:border-ink-faint',
          )}
        >
          <Layers className="h-3.5 w-3.5" /> Fit map
        </button>
        {size !== rec.recommendedSize && (
          <button
            type="button"
            onClick={() => setCompare((v) => !v)}
            aria-pressed={compare}
            className={cx(
              'focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition',
              compare ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink-soft hover:border-ink-faint',
            )}
          >
            <Columns2 className="h-3.5 w-3.5" /> Compare with {rec.recommendedSize}
          </button>
        )}
      </div>

      {error ? (
        <Card className="grid aspect-[3/4] place-items-center p-8 text-center">
          <div>
            <Shirt className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mx-auto mt-3 max-w-xs text-sm text-ink-soft">{error}</p>
          </div>
        </Card>
      ) : (
        <div className={cx('grid gap-3', compare && size !== rec.recommendedSize && 'grid-cols-2')}>
          {compare && size !== rec.recommendedSize && (
            <Frame shot={base} label={`${rec.recommendedSize} · your size`} showMap={false} loading={!base} compact />
          )}
          <Frame
            shot={current}
            label={size ? `${size}${current ? ` · ${current.summary}` : ''}` : ''}
            showMap={showMap}
            loading={loading || !current}
            compact={compare && size !== rec.recommendedSize}
          />
        </div>
      )}

      {/* sizes */}
      <div className="scroll-thin flex gap-2 overflow-x-auto p-1">
        {rec.sizes.map((s) => {
          const on = s.label === size;
          const ready = !!cache[keyFor(s.label, mode, view)];
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onSelectSize(s.label)}
              aria-pressed={on}
              className={cx(
                'focus-ring relative flex min-w-[3.25rem] shrink-0 flex-col items-center rounded-xl border px-3 py-1.5 transition',
                s.label === rec.recommendedSize ? 'border-ink bg-ink text-paper' : 'border-line bg-white text-ink-soft hover:border-ink-faint',
                on && 'ring-2 ring-accent ring-offset-2 ring-offset-paper',
              )}
            >
              <span className="text-sm font-semibold">{s.label}</span>
              <span className={cx('text-[10px]', s.label === rec.recommendedSize ? 'text-paper/70' : 'text-ink-muted')}>
                {s.label === rec.recommendedSize ? 'yours' : s.blocked ? 'too small' : `${s.score}`}
              </span>
              {!ready && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-ink-faint/50" />}
            </button>
          );
        })}
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        {mode === 'own'
          ? `Your own top from your scan photo, sized like the ${garmentName}: `
          : `The ${garmentName} on your scan photo: `}
        drawn by TailorAI from your measurements and this brand&apos;s size chart — a size too small hugs, creases and
        rides up; a size too big hangs long and loose. Rendered on this server; your photo isn&apos;t sent anywhere.
      </p>
    </div>
  );
}

function Frame({
  shot,
  label,
  showMap,
  loading,
  compact,
}: {
  shot: FitPreviewView | undefined;
  label: string;
  showMap: boolean;
  loading: boolean;
  compact?: boolean;
}) {
  const src = useMemo(() => (shot ? `data:${shot.mimeType};base64,${shot.imageBase64}` : null), [shot]);
  return (
    <Card className="relative overflow-hidden bg-[#eceae4] p-0">
      <div className="relative" style={{ aspectRatio: shot ? `${shot.width} / ${shot.height}` : '3 / 4' }}>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className={cx('h-full w-full object-cover transition', loading && 'opacity-60')} />
        )}
        {shot && showMap && !compact && (
          <div className="pointer-events-none absolute inset-0 animate-fade-up">
            {shot.zones.map((z) => {
              const tone = TONE[z.tone] ?? TONE.good;
              // Labels point towards the middle of the photo, so they stay on it.
              const right = z.x <= 0.5;
              return (
                <div key={z.name} className="absolute" style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%` }}>
                  <span
                    className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                    style={{ background: tone.dot }}
                  />
                  <span
                    className="absolute top-1/2 h-px w-6 -translate-y-1/2 bg-white/90"
                    style={right ? { left: 4 } : { right: 4 }}
                  />
                  <span
                    className={cx(
                      'absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-soft',
                      tone.pill,
                    )}
                    style={right ? { left: 30 } : { right: 30 }}
                  >
                    {z.label}: {z.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-2 rounded-full bg-card/90 px-3 py-1.5 text-xs font-medium shadow-soft">
              <Spinner className="h-3.5 w-3.5" /> Dressing your photo…
            </div>
          </div>
        )}
        {label && (
          <div className="absolute left-3 top-3 rounded-full bg-card/95 shadow-soft">
            <Badge tone={shot ? summaryTone(shot.summary) : 'neutral'}>{label}</Badge>
          </div>
        )}
      </div>
    </Card>
  );
}
