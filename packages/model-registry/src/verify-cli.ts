#!/usr/bin/env node
/**
 * CI / build gate. Run from the repo root:
 *
 *   npm run verify:licenses
 *
 * Reads the adapter ids a deployment is configured with and exits non-zero if
 * any of them are not cleared for the configured MODEL_TIER.
 *
 * This runs in CI and in the production Docker build. Shipping a
 * non-commercial weight to production requires deliberately deleting this
 * check — not merely forgetting to swap a model.
 */
import { verify, blockedModels, MODELS, type ModelTier } from './index.js';

const ADAPTER_TO_MODEL: Record<string, string> = {
  mock: 'mock-v1',
  sam3dbody: 'sam3dbody-vith-v1',
  'sam3dbody-dinov3': 'sam3dbody-dinov3-v1',
  birefnet: 'birefnet-v1',
  pshuman: 'pshuman-v1',
  lhm: 'lhm-0.5b',
  sifu: 'sifu-v1',
  // `remote` delegates to whatever the remote endpoint runs; it is verified
  // there, at that service's own boot, not here.
  remote: 'mock-v1',
};

function resolveAdapter(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  const mapped = ADAPTER_TO_MODEL[name];
  return mapped ?? name;
}

function main(): void {
  const tier = (process.env.MODEL_TIER ?? 'production') as ModelTier;

  if (tier !== 'production' && tier !== 'research') {
    console.error(`✖ MODEL_TIER must be "production" or "research", got "${tier}"`);
    process.exit(2);
  }

  const configured = [
    resolveAdapter(process.env.RECONSTRUCTION_ADAPTER, 'mock-v1'),
    resolveAdapter(process.env.SEGMENTATION_ADAPTER, 'mock-v1'),
    // Body model and UV are structural, always present.
    'mhr-v1',
    'xatlas',
  ];

  const result = verify(configured, tier);

  console.log(`\n  TailorAI model licence gate`);
  console.log(`  ───────────────────────────`);
  console.log(`  tier       : ${result.tier}`);
  console.log(`  registry   : ${MODELS.length} models declared`);
  console.log(`  configured : ${result.configured.join(', ')}\n`);

  if (result.unknown.length > 0) {
    console.error(`✖ Undeclared model(s): ${result.unknown.join(', ')}`);
    console.error(
      `  Every loadable model needs an entry in packages/model-registry/licenses.json\n` +
        `  with a reviewed licence. Add it there rather than bypassing this check.\n`,
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`✖ BUILD BLOCKED — ${result.violations.length} model(s) not cleared for commercial use:\n`);
    for (const v of result.violations) {
      console.error(`    ${v.id}  (${v.name})`);
      console.error(`    licence: ${v.license}`);
      console.error(`    ${v.note}\n`);
    }
    console.error(`  Set MODEL_TIER=research for local experiments only.\n`);
    process.exit(1);
  }

  if (tier === 'research') {
    console.warn(
      `⚠  MODEL_TIER=research — licence enforcement is OFF.\n` +
        `   This build must never serve real users.\n`,
    );
  }

  const blocked = blockedModels();
  console.log(`✔ All configured models cleared for commercial use.`);
  if (blocked.length > 0) {
    console.log(
      `  (${blocked.length} model(s) in the registry are marked unshippable ` +
        `and are not configured: ${blocked.map((m) => m.id).join(', ')})`,
    );
  }
  console.log('');
}

main();
