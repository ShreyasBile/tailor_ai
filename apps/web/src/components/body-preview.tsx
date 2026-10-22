/** Illustrated body with a sweeping scan line and live-looking callouts. */
export function BodyPreview() {
  const callouts = [
    { y: 31, label: 'Chest', value: '98.4 cm', side: 'right' as const },
    { y: 42, label: 'Waist', value: '83.1 cm', side: 'left' as const },
    { y: 51, label: 'Hip', value: '99.0 cm', side: 'right' as const },
    { y: 70, label: 'Inseam', value: '81.6 cm', side: 'left' as const },
  ];
  return (
    <div className="relative aspect-[4/5] bg-gradient-to-b from-[#fbfaf6] to-[#efece4]">
      <svg viewBox="0 0 200 250" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="skin" x1="0" x2="1">
            <stop offset="0" stopColor="#d9cbbb" />
            <stop offset="0.5" stopColor="#e8ddcf" />
            <stop offset="1" stopColor="#cdbdaa" />
          </linearGradient>
        </defs>
        <ellipse cx="100" cy="236" rx="46" ry="5" fill="rgba(20,22,26,0.08)" />
        <g fill="url(#skin)" stroke="#b6a48f" strokeWidth="0.8">
          <ellipse cx="100" cy="30" rx="11" ry="13.5" />
          <path d="M94 42 h12 l1 8 h-14 z" />
          <path d="M76 52 Q100 46 124 52 L127 74 Q126 92 121 102 Q124 116 123 126 L77 126 Q76 116 79 102 Q74 92 73 74 Z" />
          <path d="M76 54 Q68 56 66 66 L56 108 Q54 116 58 118 L62 118 L73 76 Z" />
          <path d="M124 54 Q132 56 134 66 L144 108 Q146 116 142 118 L138 118 L127 76 Z" />
          <path d="M78 124 L99 124 L98 172 L96 226 L84 226 L82 172 Z" />
          <path d="M101 124 L122 124 L118 172 L116 226 L104 226 L102 172 Z" />
        </g>
      </svg>

      {/* scanning beam */}
      <div className="pointer-events-none absolute inset-x-0 top-[6%] h-[88%] overflow-hidden">
        <div className="h-full animate-scan">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-accent to-transparent shadow-[0_0_18px_4px_rgba(47,93,80,0.35)]" />
        </div>
      </div>

      {callouts.map((c) => (
        <div
          key={c.label}
          className="absolute flex items-center gap-2"
          style={{ top: `${c.y}%`, [c.side === 'right' ? 'left' : 'right']: '58%' }}
        >
          {c.side === 'left' && <Pill label={c.label} value={c.value} />}
          <span className="h-px w-8 bg-ink/30" />
          <span className="h-2 w-2 rounded-full bg-accent ring-4 ring-accent/15" />
          {c.side === 'right' && <Pill label={c.label} value={c.value} />}
        </div>
      ))}

      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between rounded-xl border border-line bg-white/80 px-4 py-3 text-xs backdrop-blur">
        <span className="text-ink-muted">Recommended</span>
        <span className="font-semibold">Oxford Shirt · M</span>
        <span className="rounded-full bg-good/10 px-2 py-0.5 font-semibold text-good">92 fit</span>
      </div>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap rounded-lg border border-line bg-white/90 px-2 py-1 text-[11px] shadow-soft">
      <span className="text-ink-muted">{label}</span> <span className="font-semibold">{value}</span>
    </span>
  );
}
