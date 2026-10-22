/**
 * Flat-lay garment illustrations, drawn in each product's own colour.
 * The catalogue needs no photography and stays self-contained.
 */

type Kind = 'tee' | 'shirt' | 'knit' | 'jacket' | 'coat' | 'jeans' | 'trousers' | 'dress';

export function garmentKind(subcategory: string, category: string): Kind {
  const s = subcategory.toLowerCase();
  if (s.includes('t-shirt')) return 'tee';
  if (s.includes('shirt')) return 'shirt';
  if (s.includes('knit') || s.includes('sweater')) return 'knit';
  if (s.includes('coat')) return 'coat';
  if (s.includes('jacket')) return 'jacket';
  if (s.includes('jean')) return 'jeans';
  if (s.includes('trouser') || s.includes('chino')) return 'trousers';
  if (s.includes('dress') || category === 'DRESSES') return 'dress';
  if (category === 'BOTTOMS') return 'trousers';
  if (category === 'OUTERWEAR') return 'jacket';
  return 'tee';
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 200;
}

const PATHS: Record<Kind, { body: string; detail?: string }> = {
  tee: {
    body: 'M70 40 L100 28 Q120 44 140 28 L170 40 L200 78 L176 96 L164 84 L164 200 L76 200 L76 84 L64 96 L40 78 Z',
    detail: 'M100 28 Q120 50 140 28',
  },
  shirt: {
    body: 'M72 40 L102 26 L120 44 L138 26 L168 40 L196 150 L176 156 L164 92 L164 204 L76 204 L76 92 L64 156 L44 150 Z',
    detail: 'M102 26 L112 50 L120 44 L128 50 L138 26 M120 44 L120 204',
  },
  knit: {
    body: 'M72 40 L104 30 Q120 42 136 30 L168 40 L198 150 L180 158 L164 96 L166 198 Q120 206 74 198 L76 96 L60 158 L42 150 Z',
    detail: 'M104 30 Q120 46 136 30 M76 190 Q120 198 166 190',
  },
  jacket: {
    body: 'M70 38 L100 26 L120 56 L140 26 L170 38 L198 160 L178 166 L166 98 L168 208 L72 208 L74 98 L62 166 L42 160 Z',
    detail: 'M100 26 L112 96 L120 208 M140 26 L128 96 L120 208 M86 140 L106 140 M134 140 L154 140',
  },
  coat: {
    body: 'M70 34 L100 22 L120 52 L140 22 L170 34 L198 170 L178 176 L166 100 L172 226 L68 226 L74 100 L62 176 L42 170 Z',
    detail: 'M100 22 L114 100 L120 226 M140 22 L126 100 M112 130 a3 3 0 1 0 0.1 0 M112 160 a3 3 0 1 0 0.1 0',
  },
  jeans: {
    body: 'M80 30 L160 30 L166 60 L172 224 L132 224 L122 92 L118 92 L108 224 L68 224 L74 60 Z',
    detail: 'M80 44 L160 44 M120 44 L120 92 M86 60 Q98 74 112 60 M128 60 Q142 74 154 60',
  },
  trousers: {
    body: 'M80 30 L160 30 L164 60 L168 224 L130 224 L122 96 L118 96 L110 224 L72 224 L76 60 Z',
    detail: 'M80 42 L160 42 M120 42 L120 96 M100 42 L100 224 M140 42 L140 224',
  },
  dress: {
    body: 'M96 24 L108 22 Q120 36 132 22 L144 24 L150 70 Q140 92 146 112 L190 226 Q120 238 50 226 L94 112 Q100 92 90 70 Z',
    detail: 'M94 112 Q120 120 146 112',
  },
};

export function GarmentArt({
  subcategory,
  category,
  colorHex,
  className,
}: {
  subcategory: string;
  category: string;
  colorHex: string;
  className?: string;
}) {
  const kind = garmentKind(subcategory, category);
  const p = PATHS[kind];
  const light = isLight(colorHex);
  const stroke = light ? shade(colorHex, -60) : shade(colorHex, -35);
  const detail = light ? shade(colorHex, -45) : shade(colorHex, 40);
  const id = `g-${kind}-${colorHex.slice(1)}`;

  return (
    <svg viewBox="0 0 240 250" className={className} role="img" aria-label={`${subcategory} illustration`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(colorHex, 18)} />
          <stop offset="1" stopColor={shade(colorHex, -14)} />
        </linearGradient>
      </defs>
      <ellipse cx="120" cy="238" rx="78" ry="6" fill="rgba(20,22,26,0.08)" />
      <path d={p.body} fill={`url(#${id})`} stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      {p.detail && (
        <path d={p.detail} fill="none" stroke={detail} strokeWidth="1.4" strokeLinecap="round" opacity="0.9" />
      )}
    </svg>
  );
}
