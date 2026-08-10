/**
 * Design tokens.
 *
 * Dark-first, near-black rather than pure black so the 3D viewport is the
 * brightest thing on screen — the avatar should be what the eye lands on.
 */

export const colors = {
  // Surfaces, ascending elevation
  bg: '#0A0A0B',
  surface: '#141416',
  surfaceRaised: '#1C1C1F',
  surfaceOverlay: 'rgba(20,20,22,0.92)',

  border: '#2A2A2E',
  borderStrong: '#3A3A40',

  // Text
  text: '#F5F5F7',
  textSecondary: '#A1A1A8',
  textTertiary: '#6E6E76',

  // A single accent, used sparingly so it retains meaning
  accent: '#5B8DEF',
  accentPressed: '#4A77CC',
  accentSubtle: 'rgba(91,141,239,0.12)',

  success: '#3DD68C',
  warning: '#F5A524',
  danger: '#F04438',

  // Capture guidance states
  guideOk: '#3DD68C',
  guideAdjust: '#F5A524',
  guideBad: '#F04438',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/** Two weights only. Hierarchy comes from size and colour, not weight soup. */
export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, fontWeight: '400' as const },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '500' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  mono: { fontSize: 13, lineHeight: 18, fontFamily: 'Menlo' },
} as const;

/** Spring configs. Motion quality is where the premium feel actually lives. */
export const motion = {
  gentle: { damping: 20, stiffness: 180, mass: 1 },
  snappy: { damping: 22, stiffness: 320, mass: 0.8 },
  slow: { damping: 26, stiffness: 110, mass: 1.2 },
} as const;
