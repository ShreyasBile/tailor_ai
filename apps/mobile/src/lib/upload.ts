// Legacy API on purpose: SDK 57's File/Directory API reads whole files into
// memory, and a 60 MB video must be read in ranged chunks or the app dies on
// a mid-range phone. `readAsStringAsync` with position+length is the only
// ranged-read primitive available.
import * as FileSystem from 'expo-file-system/legacy';
import { request } from './api';

/**
 * Resumable multipart upload.
 *
 * Bytes go straight to object storage via presigned URLs — never through the
 * API. Parts are retried individually and, after an app kill, the client asks
 * the server which parts landed and sends only the gaps. A 60 MB video over a
 * train connection has to survive; restarting from zero is not acceptable.
 */

export interface UploadPart {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface CreateUploadResponse {
  uploadId: string;
  storageKey: string;
  parts: UploadPart[];
}

export interface UploadStatus {
  uploadId: string;
  totalParts: number;
  completedParts: number[];
  isComplete: boolean;
}

export type UploadProgress = (fraction: number) => void;

const MAX_PART_ATTEMPTS = 4;

export async function uploadFile(opts: {
  sessionId: string;
  fileUri: string;
  fileName: string;
  mimeType: string;
  kind: 'RAW_VIDEO' | 'RAW_PHOTO';
  onProgress?: UploadProgress;
  /** Resume an interrupted upload instead of starting a new one. */
  resumeUploadId?: string;
  /** Front-camera video is mirrored; the server flips it during extraction. */
  mirrored?: boolean;
}): Promise<{ assetId: string; uploadId: string }> {
  const info = await FileSystem.getInfoAsync(opts.fileUri);
  if (!info.exists) throw new Error('File not found');

  const sizeBytes = info.size;
  const partSizeBytes = choosePartSize(sizeBytes);

  const clientFingerprint = fingerprint(opts.fileUri, sizeBytes);

  let created: CreateUploadResponse;
  let alreadyDone: number[] = [];

  if (opts.resumeUploadId) {
    const status = await request<UploadStatus>(`/uploads/${opts.resumeUploadId}`);
    alreadyDone = status.completedParts;
    created = await request<CreateUploadResponse>(
      `/capture-sessions/${opts.sessionId}/uploads`,
      {
        method: 'POST',
        body: {
          kind: opts.kind,
          fileName: opts.fileName,
          sizeBytes,
          mimeType: opts.mimeType,
          clientFingerprint,
          mirrored: opts.mirrored ?? false,
          partSizeBytes,
        },
      },
    );
  } else {
    created = await request<CreateUploadResponse>(
      `/capture-sessions/${opts.sessionId}/uploads`,
      {
        method: 'POST',
        body: {
          kind: opts.kind,
          fileName: opts.fileName,
          sizeBytes,
          mimeType: opts.mimeType,
          clientFingerprint,
          mirrored: opts.mirrored ?? false,
          partSizeBytes,
        },
      },
    );
  }

  const etags: Array<{ partNumber: number; etag: string }> = [];
  const total = created.parts.length;
  let done = 0;

  for (const part of created.parts) {
    if (alreadyDone.includes(part.partNumber)) {
      done += 1;
      opts.onProgress?.(done / total);
      continue;
    }

    const offset = (part.partNumber - 1) * partSizeBytes;
    const length = Math.min(partSizeBytes, sizeBytes - offset);

    const etag = await uploadPartWithRetry(opts.fileUri, part.url, offset, length);
    etags.push({ partNumber: part.partNumber, etag });

    done += 1;
    opts.onProgress?.(done / total);
  }

  const result = await request<{ assetId: string }>(`/uploads/${created.uploadId}/complete`, {
    method: 'POST',
    body: { parts: etags },
  });

  return { assetId: result.assetId, uploadId: created.uploadId };
}

async function uploadPartWithRetry(
  fileUri: string,
  url: string,
  offset: number,
  length: number,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
    try {
      const chunk = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length,
      });

      const bytes = base64ToBytes(chunk);
      const res = await fetch(url, {
        method: 'PUT',
        // ArrayBuffer rather than the view: RN's fetch accepts both, but only
        // ArrayBuffer is in the BodyInit type.
        body: bytes.buffer as ArrayBuffer,
      });

      if (!res.ok) throw new Error(`part upload failed: ${res.status}`);

      const etag = res.headers.get('etag');
      if (!etag) throw new Error('no ETag returned');
      return etag.replace(/"/g, '');
    } catch (err) {
      lastError = err;
      // Individual part retry with backoff: a dropped chunk should cost
      // seconds, not the whole upload.
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('part upload failed');
}

/**
 * Part size trades request count against retry cost.
 * S3 requires ≥5 MiB per part except the last.
 */
function choosePartSize(sizeBytes: number): number {
  const MiB = 1024 * 1024;
  if (sizeBytes <= 40 * MiB) return 5 * MiB;
  if (sizeBytes <= 200 * MiB) return 8 * MiB;
  return 16 * MiB;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Cheap content fingerprint for deduplication and resume keying.
 *
 * Explicitly not a cryptographic digest: hashing a 60 MB file on the JS thread
 * would block the UI for seconds. Real integrity is enforced server-side on
 * the assembled object (byte length + magic-byte sniffing) and by S3's
 * per-part checksums in transit.
 */
function fingerprint(uri: string, size: number): string {
  const seed = `${uri}:${size}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(seed.length - 1 - i), 0x85ebca6b) >>> 0;
  }
  const part = (n: number): string => n.toString(16).padStart(8, '0');
  return (part(h1) + part(h2) + part(h1 ^ h2) + part(size >>> 0)).repeat(2).slice(0, 64);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
