'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { SearchX, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtPrice, titleCase } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { AdminStatus, GarmentSummary, RecommendationView } from '@/lib/types';
import { ProductImage } from '@/components/garment-art';
import { Badge, Button, ButtonLink, Card, EmptyState, Segmented, Spinner, cx } from '@/components/ui';

const CATEGORIES = [
  { value: 'ALL', label: 'All' },
  { value: 'TOPS', label: 'Tops' },
  { value: 'OUTERWEAR', label: 'Outerwear' },
  { value: 'BOTTOMS', label: 'Bottoms' },
  { value: 'DRESSES', label: 'Dresses' },
] as const;

export default function ShopPage() {
  const { user } = useSession();
  const [items, setItems] = useState<GarmentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recs, setRecs] = useState<Record<string, RecommendationView>>({});
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('ALL');
  const [gender, setGender] = useState<'all' | 'women' | 'men'>('all');

  // A failed load is an error, not an empty catalogue — say so and offer a retry.
  const load = useCallback(() => {
    setLoadError(null);
    setItems(null);
    api<GarmentSummary[]>('/garments', { auth: false })
      .then(setItems)
      .catch((err) => setLoadError((err as Error).message));
  }, []);
  useEffect(load, [load]);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!user) return;
    api<RecommendationView[]>('/me/recommendations')
      .then((rs) => setRecs(Object.fromEntries(rs.map((r) => [r.garment.slug, r]))))
      .catch(() => {});
    api<AdminStatus>('/admin/status')
      .then((s) => setIsAdmin(s.isAdmin))
      .catch(() => {});
  }, [user]);

  const shown = useMemo(
    () =>
      (items ?? []).filter(
        (g) =>
          (category === 'ALL' || g.category === category) &&
          (gender === 'all' || g.gender === gender || g.gender === 'unisex'),
      ),
    [items, category, gender],
  );

  return (
    <div className="container-page py-10">
      <p className="eyebrow mb-3">Shop</p>
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div>
          <h1 className="font-display text-5xl">Find your size in anything</h1>
          <p className="mt-3 max-w-xl text-ink-muted">
            Every brand cuts differently. Open an item and we&apos;ll match its size chart to your Body Profile.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <ButtonLink href="/admin/outfits" variant="secondary" size="sm">
              + Add outfit
            </ButtonLink>
          )}
          <Segmented
            size="sm"
            value={gender}
            onChange={setGender}
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'women', label: 'Women' },
              { value: 'men', label: 'Men' },
            ]}
          />
        </div>
      </div>

      <div className="scroll-thin mt-8 flex gap-2 overflow-x-auto pb-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            onClick={() => setCategory(c.value)}
            className={cx(
              'focus-ring shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition',
              category === c.value ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink-soft hover:border-ink-faint',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {loadError ? (
        <Card className="mt-6">
          <EmptyState
            icon={<WifiOff className="h-6 w-6" />}
            title="The shop didn't load"
            body={loadError}
            action={<Button onClick={load}>Try again</Button>}
          />
        </Card>
      ) : !items ? (
        <div className="grid min-h-[40vh] place-items-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : shown.length === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={<SearchX className="h-6 w-6" />}
            title="Nothing here yet"
            body="No items match these filters. Try another category, or show everything."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setCategory('ALL');
                  setGender('all');
                }}
              >
                Show everything
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {shown.map((g) => {
            const rec = recs[g.slug];
            return (
              <Link key={g.id} href={`/shop/${g.slug}`} className="focus-ring group rounded-xl2">
                <Card className="overflow-hidden transition group-hover:-translate-y-0.5 group-hover:shadow-lift">
                  <div className={cx('relative aspect-square overflow-hidden bg-gradient-to-b from-[#fbfaf6] to-[#efece4]', !g.imageUrl && 'p-6')}>
                    <ProductImage
                      imageUrl={g.imageUrl}
                      name={g.name}
                      subcategory={g.subcategory}
                      category={g.category}
                      colorHex={g.colorHex}
                      className="h-full w-full transition duration-500 group-hover:scale-[1.04]"
                    />
                    {rec && (
                      <span className="absolute right-3 top-3 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-paper">
                        Your size {rec.recommendedSize}
                      </span>
                    )}
                  </div>
                  <div className="p-4">
                    <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">{g.brand.name}</p>
                    <p className="mt-1 truncate font-medium">{g.name}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-sm">{fmtPrice(g.priceCents, g.currency)}</span>
                      <Badge>{titleCase(g.fitIntent)} fit</Badge>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
