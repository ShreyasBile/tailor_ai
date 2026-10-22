export type Units = 'cm' | 'in';

export function fmtLength(cm: number, units: Units, digits = 1): string {
  return units === 'cm' ? `${cm.toFixed(digits)} cm` : `${(cm / 2.54).toFixed(digits)} in`;
}

export function fmtNumber(cm: number, units: Units, digits = 1): string {
  return units === 'cm' ? cm.toFixed(digits) : (cm / 2.54).toFixed(digits);
}

export function fmtPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    cents / 100,
  );
}

export function confidenceTone(c: number): 'good' | 'warn' | 'bad' {
  return c >= 0.7 ? 'good' : c >= 0.5 ? 'warn' : 'bad';
}

export function confidenceWord(c: number): string {
  return c >= 0.7 ? 'High' : c >= 0.5 ? 'Medium' : 'Low';
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
