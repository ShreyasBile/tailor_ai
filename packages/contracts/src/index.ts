/**
 * @tailorai/contracts
 *
 * The single source of truth for every type crossing a process boundary.
 * The API's validation pipe, the OpenAPI document, the orchestrator, and the
 * mobile client all derive from here. There is no second place to update.
 */
export * from './enums.js';
export * from './errors.js';
export * from './schemas.js';
export * from './internal.js';

/** Bumped when the pipeline changes in a way that alters output. Recorded per job. */
export const PIPELINE_VERSION = '1.0.0';

/** Bumped when the mesh/texture generator changes. Drives re-render decisions. */
export const RENDERER_VERSION = '1.0.0';

export const API_VERSION = 'v1';
