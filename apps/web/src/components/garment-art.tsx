/**
 * Flat-lay garment illustrations, drawn in each product's own colour.
 * The catalogue needs no photography and stays self-contained.
 */

export type Kind =
  | 'tee' | 'polo' | 'shirt' | 'knit' | 'hoodie' | 'kurta' | 'blazer' | 'jacket' | 'vest' | 'coat'
  | 'jeans' | 'trousers' | 'joggers' | 'shorts' | 'skirt' | 'dress';

export function garmentKind(subcategory: string, category: string): Kind {
  const s = subcategory.toLowerCase();
  if (s.includes('t-shirt')) return 'tee';
  if (s.includes('polo')) return 'polo';
  if (s.includes('hood')) return 'hoodie';
  if (s.includes('kurta')) return 'kurta';
  if (s.includes('short')) return 'shorts';
  if (s.includes('skirt')) return 'skirt';
  if (s.includes('shirt')) return 'shirt';
  if (s.includes('knit') || s.includes('sweater')) return 'knit';
  if (s.includes('coat')) return 'coat';
  if (s.includes('blazer')) return 'blazer';
  if (s.includes('vest') || s.includes('nehru')) return 'vest';
  if (s.includes('jacket')) return 'jacket';
  if (s.includes('jean')) return 'jeans';
  if (s.includes('jogger') || s.includes('legging')) return 'joggers';
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
  polo: {
    body: 'M70 40 L100 28 L120 38 L140 28 L170 40 L200 78 L176 96 L164 84 L164 200 L76 200 L76 84 L64 96 L40 78 Z',
    detail: 'M100 28 L108 46 L120 38 L132 46 L140 28 M120 38 L120 74 M120 52 a2 2 0 1 0 0.1 0 M120 64 a2 2 0 1 0 0.1 0',
  },
  hoodie: {
    body: 'M72 46 L98 34 Q94 8 120 6 Q146 8 142 34 L168 46 L198 152 L180 160 L164 98 L166 202 Q120 210 74 202 L76 98 L60 160 L42 152 Z',
    detail: 'M98 34 Q120 56 142 34 M112 44 L110 76 M128 44 L130 76 M100 150 L140 150 L144 182 L96 182 Z',
  },
  kurta: {
    body: 'M74 38 L104 26 Q120 40 136 26 L166 38 L194 148 L176 154 L162 96 L168 234 L72 234 L78 96 L64 154 L46 148 Z',
    detail: 'M104 26 Q120 40 136 26 M120 34 L120 96 M120 50 a2 2 0 1 0 0.1 0 M120 66 a2 2 0 1 0 0.1 0 M120 82 a2 2 0 1 0 0.1 0 M76 196 L72 234 M164 196 L168 234',
  },
  blazer: {
    body: 'M70 38 L100 26 L120 56 L140 26 L170 38 L198 160 L178 166 L166 98 L168 208 L72 208 L74 98 L62 166 L42 160 Z',
    detail: 'M100 26 L106 72 L120 124 L134 72 L140 26 M106 72 L114 64 M134 72 L126 64 M120 150 a3 3 0 1 0 0.1 0 M120 174 a3 3 0 1 0 0.1 0 M84 150 L104 150 M136 150 L156 150 M140 104 L154 104',
  },
  vest: {
    body: 'M80 36 L102 26 L120 60 L138 26 L160 36 L170 92 L166 206 L74 206 L70 92 Z',
    detail: 'M102 26 L112 100 L120 206 M138 26 L128 100 M120 120 a2.5 2.5 0 1 0 0.1 0 M120 145 a2.5 2.5 0 1 0 0.1 0 M120 170 a2.5 2.5 0 1 0 0.1 0 M84 150 L102 150 M138 150 L156 150',
  },
  joggers: {
    body: 'M80 30 L160 30 L166 64 L158 206 L160 224 L130 224 L128 206 L122 96 L118 96 L112 206 L110 224 L80 224 L82 206 L74 64 Z',
    detail: 'M80 44 L160 44 M120 44 L120 96 M82 206 L112 206 M128 206 L158 206 M112 30 L110 58 M128 30 L130 58',
  },
  shorts: {
    body: 'M78 40 L162 40 L168 70 L176 150 L130 156 L122 104 L118 104 L110 156 L64 150 L72 70 Z',
    detail: 'M78 54 L162 54 M120 54 L120 104 M84 70 Q96 82 110 70 M130 70 Q144 82 156 70',
  },
  skirt: {
    body: 'M86 40 L154 40 L158 60 L196 210 Q120 222 44 210 L82 60 Z',
    detail: 'M86 54 L154 54 M100 60 L84 212 M120 60 L120 216 M140 60 L156 212',
  },
};

/** The product photo when there is one, else the drawn illustration. */
export function ProductImage({
  imageUrl,
  name,
  subcategory,
  category,
  colorHex,
  className,
}: {
  imageUrl: string | null | undefined;
  name?: string;
  subcategory: string;
  category: string;
  colorHex: string;
  className?: string;
}) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={imageUrl} alt={name ? `${name} — product photo` : `${subcategory} photo`} loading="lazy" className={`object-cover ${className ?? ''}`} />
    );
  }
  return <GarmentArt subcategory={subcategory} category={category} colorHex={colorHex} className={className} />;
}

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
