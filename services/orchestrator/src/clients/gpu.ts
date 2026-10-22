import { AppError } from '@tailorai/contracts';
import type {
  ScanReport,
  BodyInferRequest,
  BodyInferResponse,
  FuseRequest,
  FuseResponse,
  ReconHealth,
  SegmentRequest,
  SegmentResponse,
  TextureRequest,
  TextureResponse,
} from '@tailorai/contracts';
import { config } from '../config';
import { log } from '../logger';

// Media-plane contracts. These live here rather than in @tailorai/contracts
// because they are private to the worker↔GPU boundary and version together.

/**
 * A presigned PUT target for one extracted frame.
 *
 * Presigned URLs sign an exact key, so they cannot be templated per index.
 * The orchestrator signs a fixed pool up front and the service consumes what
 * it needs.
 */
export interface FrameSlot {
  index: number;
  key: string;
  url: string;
}

export interface ExtractRequest {
  jobId: string;
  videoUrl: string;
  sampleFps: number;
  maxDurationS: number;
  uploadSlots: FrameSlot[];
  /** Front-camera video is mirrored; frames are flipped back on extraction. */
  mirrored: boolean;
}

export interface ExtractedFrame {
  index: number;
  key: string;
  width: number;
  height: number;
  timestampMs: number;
}

export interface ExtractResponse {
  frames: ExtractedFrame[];
  durationMs: number;
  fps: number;
  elapsedMs: number;
}

export interface ScanAnalyzeRequest {
  jobId: string;
  heightCm: number;
  views: Array<{ view: 'front' | 'back' | 'left' | 'right'; imageUrl: string }>;
  fitBody: boolean;
}

export interface SelectRequest {
  jobId: string;
  frames: Array<{ index: number; imageUrl: string; key: string }>;
  targetCount: number;
}

export interface ScoredFrame {
  index: number;
  key: string;
  sharpness: number;
  exposure: number;
  qualityScore: number;
  selected: boolean;
  rejectReason: string | null;
}

export interface SelectResponse {
  frames: ScoredFrame[];
  selectedCount: number;
  elapsedMs: number;
}

export interface BuildMeshRequest {
  jobId: string;
  shape: number[];
  metricScale: number;
  textureUrl: string | null;
  outputGlbUrl: string;
  outputObjUrl: string | null;
  outputThumbnailUrl: string;
}

export interface BuildMeshResponse {
  vertexCount: number;
  triangleCount: number;
  glbBytes: number;
  objBytes: number | null;
  elapsedMs: number;
}

/**
 * HTTP client for the reconstruction service.
 *
 * The service is stateless and knows nothing about users, jobs or the database.
 * Everything it touches arrives as a presigned URL. Moving it from this laptop
 * to a rented GPU is a change to RECONSTRUCTION_URL and nothing else.
 */
export class GpuClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor() {
    const cfg = config();
    this.baseUrl = cfg.RECONSTRUCTION_URL.replace(/\/$/, '');
    this.timeoutMs = cfg.RECONSTRUCTION_TIMEOUT_MS;
    this.apiKey = cfg.RECONSTRUCTION_API_KEY;
  }

  async health(): Promise<ReconHealth> {
    return this.request<ReconHealth>('GET', '/health');
  }

  extract(req: ExtractRequest): Promise<ExtractResponse> {
    return this.request('POST', '/media/extract', req);
  }

  select(req: SelectRequest): Promise<SelectResponse> {
    return this.request('POST', '/media/select', req);
  }

  segment(req: SegmentRequest): Promise<SegmentResponse> {
    return this.request('POST', '/infer/segment', req);
  }

  body(req: BodyInferRequest): Promise<BodyInferResponse> {
    return this.request('POST', '/infer/body', req);
  }

  fuse(req: FuseRequest): Promise<FuseResponse> {
    return this.request('POST', '/infer/fuse', req);
  }

  texture(req: TextureRequest): Promise<TextureResponse> {
    return this.request('POST', '/infer/texture', req);
  }

  /** Four-view scan: validate, measure, fit. A rejected scan is a normal
   * response (status: 'rejected'), not an HTTP error. */
  scanAnalyze(req: ScanAnalyzeRequest): Promise<ScanReport> {
    return this.request('POST', '/scan/analyze', req);
  }

  buildMesh(req: BuildMeshRequest): Promise<BuildMeshResponse> {
    return this.request('POST', '/mesh/build', req);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The GPU service reports its own taxonomy codes; pass them through so
        // the user sees "it was too dark" rather than "500".
        let code: string | undefined;
        try {
          code = (JSON.parse(text) as { code?: string }).code;
        } catch {
          /* not JSON */
        }

        log.error('GPU service error', { path, status: res.status, code, body: text.slice(0, 400) });

        if (res.status === 503) throw new AppError('GPU_UNAVAILABLE', { path, status: res.status });
        if (code && isKnownCode(code)) throw new AppError(code as never, { path });
        throw new AppError('INFERENCE_FAILED', { path, status: res.status });
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('TIMEOUT', { path, timeoutMs: this.timeoutMs });
      }
      throw new AppError('GPU_UNAVAILABLE', { path, cause: String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
}

const KNOWN = new Set([
  'NO_PERSON_DETECTED',
  'MULTIPLE_PEOPLE',
  'INPUT_TOO_DARK',
  'INPUT_TOO_BLURRY',
  'PARTIAL_BODY',
  'INSUFFICIENT_COVERAGE',
  'INSUFFICIENT_FRAMES',
  'CORRUPT_MEDIA',
  'NUDITY_DETECTED',
  'GPU_OOM',
  'SCALE_UNRESOLVED',
  'TEXTURE_BAKE_FAILED',
  'MESH_INVALID',
]);

function isKnownCode(code: string): boolean {
  return KNOWN.has(code);
}
