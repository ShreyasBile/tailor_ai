import type { View } from '@/lib/types';

/** How to stand for each of the four photos — drawn, not described. */
export function PoseGuide({ view, className }: { view: View; className?: string }) {
  const side = view === 'left' || view === 'right';
  const flip = view === 'right';
  return (
    <svg viewBox="0 0 100 160" className={className} aria-hidden>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={flip ? 'translate(100 0) scale(-1 1)' : undefined}
      >
        {side ? (
          <>
            <circle cx="50" cy="20" r="9" />
            {/* nose marks the facing direction */}
            <path d="M58.5 19 l3 2 l-3 1" />
            <path d="M50 29 L50 33 M42 36 Q50 32 58 36 L58 82 Q50 86 42 82 Z" />
            <path d="M50 38 L52 64 L54 82" />
            <path d="M46 84 L46 118 L47 150 M53 84 L54 118 L55 150" />
            <path d="M47 150 L56 150 M55 150 L62 150" />
          </>
        ) : (
          <>
            <circle cx="50" cy="20" r="9" />
            {view === 'back' && <path d="M43 16 Q50 10 57 16" />}
            <path d="M50 29 L50 33" />
            <path d="M34 36 Q50 31 66 36 L64 84 L36 84 Z" />
            {/* A-pose: arms away from the body */}
            <path d="M34 37 L22 66 L18 88 M66 37 L78 66 L82 88" />
            <path d="M40 84 L36 118 L33 150 M60 84 L64 118 L67 150" />
          </>
        )}
      </g>
    </svg>
  );
}

export const VIEW_COPY: Record<View, { title: string; tip: string }> = {
  front: { title: 'Front', tip: 'Face the camera, arms slightly out, feet hip-width apart.' },
  back: { title: 'Back', tip: 'Turn around fully. Same pose — arms out, feet apart.' },
  left: { title: 'Left side', tip: 'Turn so your left side faces the camera. Arms relaxed by your sides.' },
  right: { title: 'Right side', tip: 'Turn so your right side faces the camera. Arms relaxed by your sides.' },
};
