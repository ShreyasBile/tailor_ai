'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Cpu, Info, Layers, Shirt, Sparkles, UserRound, Wand2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { FitPreference, FitPreviewView, RecommendationView, TryOnCapabilities } from '@/lib/types';
import { Badge, Button, Card, Segmented, Spinner, cx } from './ui';

type Mode = 'product' | 'own';
type View = 'front' | 'back';
type Engine = 'fast' | 'gemini' | 'local';

const TONE: Record<string, { dot: string; pill: string }> = {
  bad: { dot: '#b4432f', pill: 'bg-bad text-white' },
  warn: { dot: '#b7791f', pill: 'bg-warn text-white' },
  good: { dot: '#2f7a4f', pill: 'bg-good text-white' },
  loose: { dot: '#3b6fb0', pill: 'bg-[#3b6fb0] text-white' },
  'bad-loose': { dot: '#284f86', pill: 'bg-[#284f86] text-white' },
};

const ENGINE_NAME: Record<Engine, string> = { fast: 'TailorAI renderer', gemini: 'Gemini', local: 'on-device AI' };
const CONSENT_KEY = 'tailorai.geminiConsent';

function summaryTone(s: string): 'bad' | 'warn' | 'good' | 'accent' | 'neutral' {
  if (s.startsWith('Very tight')) return 'bad';
  if (s.startsWith('Snug')) return 'warn';
  if (s.startsWith('True')) return 'good';
  return 'accent';
}

function readConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

/**
 * The fitting room: the shopper's own scan photo, wearing this item in the
 * chosen size — or the top they're wearing, sized like this item.
 *
 * Fast: TailorAI's own renderer draws the size from the fit numbers — instant,
 * on this server. AI photo: an image model (Gemini in the cloud, or FASHN VTON
 * on this server's GPU) makes that sized draft photoreal, keeping its fit.
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
  caps,
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
  caps: TryOnCapabilities | null;
}) {
  const isTop = category !== 'BOTTOMS';
  const [mode, setMode] = useState<Mode>('product');
  const [view, setView] = useState<View>('front');
  const [quality, setQuality] = useState<'fast' | 'ai'>('fast');
  const [provider, setProvider] = useState<'gemini' | 'local'>('local');
  const [consent, setConsent] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [compare, setCompare] = useState(false);
  const [cache, setCache] = useState<Record<string, FitPreviewView>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const inflight = useRef(new Map<string, Promise<FitPreviewView>>());

  const anyAi = !!caps && (caps.gemini || caps.local);
  useEffect(() => setConsent(readConsent()), []);
  useEffect(() => {
    if (caps) setProvider(caps.local ? 'local' : 'gemini');
  }, [caps]);

  const engine: Engine = quality === 'fast' ? 'fast' : provider;
  const needsConsent = engine === 'gemini' && !consent;
  const size = selectedSize ?? rec?.recommendedSize ?? null;
  const keyFor = useCallback(
    (s: string, m: Mode, v: View, e: Engine) => `${e}|${m}|${v}|${s}|${preference}`,
    [preference],
  );

  const load = useCallback(
    (s: string, m: Mode, v: View, e: Engine): Promise<FitPreviewView> => {
      const key = keyFor(s, m, v, e);
      const existing = inflight.current.get(key);
      if (existing) return existing;
      const pr = api<FitPreviewView>(`/garments/${slug}/fit-preview`, {
        method: 'POST',
        body: { size: s, mode: m, view: v, preference, engine: e, ...(e === 'gemini' ? { consent: true } : {}) },
      }).then((res) => {
        setCache((c) => ({ ...c, [key]: res }));
        return res;
      });
      pr.catch((err) => {
        inflight.current.delete(key);
        setErrors((x) => ({ ...x, [key]: err instanceof ApiError ? err.message : (err as Error).message }));
      });
      inflight.current.set(key, pr);
      return pr;
    },
    [slug, preference, keyFor],
  );

  // The shown size (and, when comparing, the recommended one).
  useEffect(() => {
    if (!size || !rec || needsConsent) return;
    const want = [size, ...(compare && rec.recommendedSize !== size ? [rec.recommendedSize] : [])];
    const key = keyFor(size, mode, view, engine);
    if (cache[key]) return;
    setErrors((x) => {
      const { [key]: _drop, ...rest } = x;
      return rest;
    });
    setLoadingKey(key);
    Promise.all(want.map((s) => load(s, mode, view, engine)))
      .catch(() => {})
      .finally(() => setLoadingKey((k) => (k === key ? null : k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, mode, view, compare, rec?.id, load, engine, needsConsent]);

  // Fast engine: every other size quietly, so tapping through them is instant.
  // (AI photos are made on demand — each takes several seconds.)
  useEffect(() => {
    if (engine !== 'fast' || !rec || !size || !cache[keyFor(size, mode, view, 'fast')]) return;
    let stop = false;
    (async () => {
      for (const s of rec.sizes.map((x) => x.label)) {
        if (stop) return;
        if (!cache[keyFor(s, mode, view, 'fast')]) await load(s, mode, view, 'fast').catch(() => {});
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id, mode, view, engine, size && cache[keyFor(size, mode, view, 'fast')] ? 1 : 0]);

  const curKey = size ? keyFor(size, mode, view, engine) : '';
  const current = size ? cache[curKey] : undefined;
  // While an AI photo is being made, show the instant draft underneath.
  const draft = size && engine !== 'fast' ? cache[keyFor(size, mode, view, 'fast')] : undefined;
  const base = rec ? cache[keyFor(rec.recommendedSize, mode, view, engine)] : undefined;
  const loading = !!size && loadingKey === curKey && !current;
  const error = errors[curKey];
  const backAvailable = (current ?? draft)?.backAvailable;

  // Make sure the draft exists for the AI's loading backdrop.
  useEffect(() => {
    if (engine !== 'fast' && size && rec && !cache[keyFor(size, mode, view, 'fast')]) {
      load(size, mode, view, 'fast').catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, size, mode, view, rec?.id]);

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

  const showing = current ?? (loading ? draft : undefined);
  const comparing = compare && size !== rec.recommendedSize;

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
        {backAvailable && (
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
        {anyAi && (
          <Segmented
            size="sm"
            value={quality}
            onChange={setQuality}
            options={[
              { value: 'fast', label: 'Fast' },
              { value: 'ai', label: 'AI photo' },
            ]}
          />
        )}
        {quality === 'ai' && caps?.gemini && caps?.local && (
          <Segmented
            size="sm"
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'local', label: 'On this PC' },
              { value: 'gemini', label: 'Gemini' },
            ]}
          />
        )}
        {engine === 'fast' && (
          <ToggleChip on={showMap} onClick={() => setShowMap((v) => !v)}>
            <Layers className="h-3.5 w-3.5" /> Fit map
          </ToggleChip>
        )}
        {size !== rec.recommendedSize && (
          <ToggleChip on={compare} onClick={() => setCompare((v) => !v)}>
            <Columns2 className="h-3.5 w-3.5" /> Compare with {rec.recommendedSize}
          </ToggleChip>
        )}
      </div>

      {needsConsent ? (
        <Card className="p-6">
          <div className="flex gap-3">
            <Wand2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div>
              <h3 className="font-semibold">Make it a photo with Gemini</h3>
              <p className="mt-1 text-sm text-ink-soft">
                Gemini turns our measured draft into a photo-real image, keeping the fit of the size you pick. Your scan
                photo is sent to Google to make it; the result is cached on this server.
              </p>
              <Button
                variant="accent"
                size="sm"
                className="mt-4"
                onClick={() => {
                  try {
                    window.localStorage.setItem(CONSENT_KEY, 'yes');
                  } catch {
                    /* private mode: consent for this page only */
                  }
                  setConsent(true);
                }}
              >
                I agree — send my scan photo to Gemini
              </Button>
            </div>
          </div>
        </Card>
      ) : error && !current ? (
        <Card className="grid aspect-[3/4] place-items-center p-8 text-center">
          <div>
            <Shirt className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mx-auto mt-3 max-w-xs text-sm text-ink-soft">{error}</p>
            {engine !== 'fast' && (
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => setQuality('fast')}>
                Use the fast renderer
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className={cx('grid gap-3', comparing && 'grid-cols-2')}>
          {comparing && (
            <Frame shot={base} label={`${rec.recommendedSize} · your size`} showMap={false} loading={!base} compact />
          )}
          <Frame
            shot={showing}
            label={size ? `${size}${showing ? ` · ${showing.summary}` : ''}` : ''}
            showMap={showMap && engine === 'fast'}
            loading={loading || !showing}
            loadingText={engine === 'fast' ? 'Dressing your photo…' : `Making a photo with ${ENGINE_NAME[engine]}… ~20 s`}
            compact={comparing}
            engine={current?.engine ?? engine}
          />
        </div>
      )}

      {/* captions for AI photos (the fit map is drawn on the fast render) */}
      {current && current.engine !== 'fast' && current.zones.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {current.zones.map((z) => (
            <span key={z.name} className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', (TONE[z.tone] ?? TONE.good).pill)}>
              {z.label}: {z.text}
            </span>
          ))}
        </div>
      )}

      {/* sizes */}
      <div className="scroll-thin flex gap-2 overflow-x-auto p-1">
        {rec.sizes.map((s) => {
          const on = s.label === size;
          const ready = !!cache[keyFor(s.label, mode, view, engine)];
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
          ? `Your own top from your scan photo, sized like the ${garmentName}. `
          : `The ${garmentName} on your scan photo. `}
        {engine === 'fast'
          ? "Drawn by TailorAI from your measurements and this brand's size chart — a size too small hugs, creases and rides up; a size too big hangs long and loose. Rendered on this server; your photo isn't sent anywhere."
          : engine === 'local'
            ? 'TailorAI draws the size from your measurements; FASHN VTON (open-source, Apache-2.0) makes it photo-real on this server’s GPU — your photo never leaves it.'
            : 'TailorAI draws the size from your measurements; Google Gemini makes it photo-real, told the exact fit in centimetres so it can’t flatter you.'}
      </p>
    </div>
  );
}

function ToggleChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition',
        on ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink-soft hover:border-ink-faint',
      )}
    >
      {children}
    </button>
  );
}

function Frame({
  shot,
  label,
  showMap,
  loading,
  loadingText = 'Dressing your photo…',
  compact,
  engine = 'fast',
}: {
  shot: FitPreviewView | undefined;
  label: string;
  showMap: boolean;
  loading: boolean;
  loadingText?: string;
  compact?: boolean;
  engine?: Engine;
}) {
  const src = useMemo(() => (shot ? `data:${shot.mimeType};base64,${shot.imageBase64}` : null), [shot]);
  return (
    <Card className="relative overflow-hidden bg-[#eceae4] p-0">
      <div className="relative" style={{ aspectRatio: shot ? `${shot.width} / ${shot.height}` : '3 / 4' }}>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className={cx('h-full w-full object-cover transition', loading && 'opacity-50 blur-[1px]')} />
        )}
        {shot && showMap && !compact && !loading && (
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
            <div className="flex items-center gap-2 rounded-full bg-card/95 px-3 py-1.5 text-xs font-medium shadow-soft">
              <Spinner className="h-3.5 w-3.5" /> {loadingText}
            </div>
          </div>
        )}
        {label && (
          <div className="absolute left-3 top-3 flex items-center gap-1.5">
            <span className="rounded-full bg-card/95 shadow-soft">
              <Badge tone={shot ? summaryTone(shot.summary) : 'neutral'}>{label}</Badge>
            </span>
            {shot && engine !== 'fast' && !loading && (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-semibold text-paper">
                {engine === 'local' ? <Cpu className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />} AI photo
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
