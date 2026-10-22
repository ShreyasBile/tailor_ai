import { api } from './api';
import type { View } from './types';

const MIN_PART = 5 * 1024 * 1024; // S3's minimum part size
const MAX_SIDE = 2048;
const MIN_LONG_SIDE = 300;

export interface PreparedPhoto {
  blob: Blob;
  width: number;
  height: number;
  previewUrl: string;
}

/**
 * Normalise a photo in the browser before upload: apply EXIF rotation, cap the
 * long side at 2048 px and re-encode as JPEG. Measurement gains nothing above
 * that resolution (the pose model runs at 256 px; silhouettes at ~1.3k), and a
 * 2 MB upload beats a 12 MB one on a phone connection.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose a photo (JPEG or PNG).');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("This photo couldn't be read. Try a JPEG or PNG (HEIC isn't supported in every browser).");
  }
  // Only true thumbnails are refused here. Whether a photo has enough detail
  // depends on how tall the person is in it, which only the server can see —
  // it enlarges small photos and flags any it can't measure, per photo.
  // Keep in step with MIN_IMAGE_SIDE in services/reconstruction/app/scan/quality.py.
  if (Math.max(bitmap.width, bitmap.height) < MIN_LONG_SIDE) {
    const { width, height } = bitmap;
    bitmap.close();
    throw new Error(
      `This photo is only ${width}×${height} pixels — too small to measure. ` +
        'Use the original photo from your camera, not a screenshot or thumbnail.',
    );
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process this photo.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', 0.92),
  );
  return { blob, width: w, height: h, previewUrl: URL.createObjectURL(blob) };
}

async function fingerprint(blob: Blob): Promise<string> {
  const head = await blob.slice(0, 65536).arrayBuffer();
  const tail = await blob.slice(Math.max(0, blob.size - 65536)).arrayBuffer();
  const size = new TextEncoder().encode(String(blob.size));
  const all = new Uint8Array(head.byteLength + tail.byteLength + size.byteLength);
  all.set(new Uint8Array(head), 0);
  all.set(new Uint8Array(tail), head.byteLength);
  all.set(size, head.byteLength + tail.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Multipart upload of one photo, tagged with its scan view. Returns assetId. */
export async function uploadPhoto(sessionId: string, view: View, photo: PreparedPhoto): Promise<string> {
  const created = await api<{ uploadId: string; parts: { partNumber: number; url: string }[] }>(
    `/capture-sessions/${sessionId}/uploads`,
    {
      method: 'POST',
      body: {
        kind: 'RAW_PHOTO',
        fileName: `${view}.jpg`,
        sizeBytes: photo.blob.size,
        mimeType: 'image/jpeg',
        clientFingerprint: await fingerprint(photo.blob),
        partSizeBytes: MIN_PART,
        view,
      },
    },
  );

  const etags: { partNumber: number; etag: string }[] = [];
  for (const part of created.parts) {
    const start = (part.partNumber - 1) * MIN_PART;
    const chunk = photo.blob.slice(start, start + MIN_PART);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(part.url, { method: 'PUT', body: chunk, headers: { 'content-type': 'image/jpeg' } });
        if (!res.ok) throw new Error(`upload part ${res.status}`);
        const etag = res.headers.get('etag');
        if (!etag) throw new Error('Storage did not return an ETag (check CORS ExposeHeaders).');
        etags.push({ partNumber: part.partNumber, etag: etag.replaceAll('"', '') });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    if (lastErr) throw lastErr instanceof Error ? lastErr : new Error('Upload failed');
  }

  const done = await api<{ assetId: string }>(`/uploads/${created.uploadId}/complete`, {
    method: 'POST',
    body: { parts: etags },
  });
  return done.assetId;
}
