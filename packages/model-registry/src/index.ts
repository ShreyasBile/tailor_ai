/**
 * Model licence registry.
 *
 * Every AI model the platform can load is declared in `licenses.json`. Nothing
 * loads a model without a corresponding entry — see `assertLoadable`.
 *
 * This exists because the alternative (a promise in a design document that we
 * will swap non-commercial models out before launch) is not a control. A CI
 * check is a control. See docs/00 ADR-2.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

export const ModelRole = z.enum([
  'body_reconstruction',
  'body_model',
  'segmentation',
  'uv_unwrap',
  'inpainting',
]);
export type ModelRole = z.infer<typeof ModelRole>;

export const ModelEntry = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    vendor: z.string().min(1),
    role: ModelRole,
    license: z.string().min(1),
    licenseUrl: z.string(),
    /** The single field the build gate reads. */
    commercial_ok: z.boolean(),
    commercialNote: z.string().min(1),
    source_url: z.string(),
    estPeakVramGb: z.number().positive().optional(),
    approxWeightsGb: z.number().positive().optional(),
    verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  // Extra descriptive keys (vertices, joints, $comment…) are allowed and ignored.
  .passthrough();
export type ModelEntry = z.infer<typeof ModelEntry>;

const Registry = z.object({
  schemaVersion: z.literal(1),
  models: z.array(ModelEntry),
});

export type ModelTier = 'production' | 'research';

function load(): ModelEntry[] {
  // Resolve from dist/ (built) or src/ (ts-node) — licenses.json sits at package root.
  const path = resolve(here, '..', 'licenses.json');
  const parsed = Registry.parse(JSON.parse(readFileSync(path, 'utf8')));

  const seen = new Set<string>();
  for (const m of parsed.models) {
    if (seen.has(m.id)) throw new Error(`Duplicate model id in registry: ${m.id}`);
    seen.add(m.id);
  }
  return parsed.models;
}

export const MODELS: readonly ModelEntry[] = Object.freeze(load());

export function getModel(id: string): ModelEntry {
  const found = MODELS.find((m) => m.id === id);
  if (!found) {
    throw new Error(
      `Unknown model "${id}". Every loadable model must be declared in ` +
        `packages/model-registry/licenses.json with a reviewed licence.`,
    );
  }
  return found;
}

export function isCommercialSafe(id: string): boolean {
  return getModel(id).commercial_ok;
}

export function blockedModels(): ModelEntry[] {
  return MODELS.filter((m) => !m.commercial_ok);
}

/**
 * Runtime guard. Call before loading any model's weights.
 *
 * Deliberately throws rather than warning: a warning in a log nobody reads is
 * how non-commercial weights reach production.
 */
export function assertLoadable(id: string, tier: ModelTier): void {
  const model = getModel(id);
  if (tier === 'production' && !model.commercial_ok) {
    throw new Error(
      [
        `Refusing to load "${model.id}" (${model.name}).`,
        `Licence: ${model.license} — not cleared for commercial use.`,
        model.commercialNote,
        ``,
        `MODEL_TIER=production forbids this model. If this is deliberate`,
        `research use, set MODEL_TIER=research — and never point that build`,
        `at real users.`,
      ].join('\n'),
    );
  }
}

export interface VerifyResult {
  ok: boolean;
  tier: ModelTier;
  configured: string[];
  violations: Array<{ id: string; name: string; license: string; note: string }>;
  unknown: string[];
}

/**
 * Build-time gate. Given the adapter ids a deployment is configured to use,
 * report whether any of them are unshippable at the requested tier.
 */
export function verify(configuredIds: string[], tier: ModelTier): VerifyResult {
  const violations: VerifyResult['violations'] = [];
  const unknown: string[] = [];

  for (const id of configuredIds) {
    let model: ModelEntry;
    try {
      model = getModel(id);
    } catch {
      unknown.push(id);
      continue;
    }
    if (tier === 'production' && !model.commercial_ok) {
      violations.push({
        id: model.id,
        name: model.name,
        license: model.license,
        note: model.commercialNote,
      });
    }
  }

  return {
    ok: violations.length === 0 && unknown.length === 0,
    tier,
    configured: configuredIds,
    violations,
    unknown,
  };
}
