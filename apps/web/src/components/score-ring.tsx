/** Circular fit score, 0–100. */
export function ScoreRing({ score, size = 112 }: { score: number; size?: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? '#2f7a4f' : score >= 70 ? '#2f5d50' : score >= 50 ? '#b7791f' : '#b4432f';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Fit score ${score} out of 100`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(20,22,26,0.08)" strokeWidth="7" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - score / 100)}
        transform="rotate(-90 50 50)"
        style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
      />
      <text x="50" y="52" textAnchor="middle" dominantBaseline="middle" fontSize="28" fontWeight="600" fill="#14161a">
        {score}
      </text>
      <text x="50" y="72" textAnchor="middle" fontSize="9" fill="#6b7079" letterSpacing="1">
        FIT
      </text>
    </svg>
  );
}
