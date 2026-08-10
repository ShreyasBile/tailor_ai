/**
 * Magic-byte sniffing.
 *
 * A client-declared Content-Type is a hint from an untrusted source. The only
 * trustworthy statement about a file's type is what its bytes say — so we read
 * the first bytes of every completed upload and compare (docs/02 §6).
 */

export type DetectedType =
  | { category: 'video'; mime: string }
  | { category: 'image'; mime: string }
  | { category: 'unknown'; mime: null };

const ALLOWED_VIDEO = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Reads an ISO-BMFF (MP4/MOV/HEIC) brand from the `ftyp` box. */
function isoBrand(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (!startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return null; // "ftyp"
  return buf.subarray(8, 12).toString('ascii');
}

export function detectMediaType(header: Buffer): DetectedType {
  // JPEG
  if (startsWith(header, [0xff, 0xd8, 0xff])) return { category: 'image', mime: 'image/jpeg' };

  // PNG
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { category: 'image', mime: 'image/png' };

  // WebP: "RIFF" .... "WEBP"
  if (startsWith(header, [0x52, 0x49, 0x46, 0x46]) && startsWith(header, [0x57, 0x45, 0x42, 0x50], 8))
    return { category: 'image', mime: 'image/webp' };

  // WebM / Matroska
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return { category: 'video', mime: 'video/webm' };

  const brand = isoBrand(header);
  if (brand) {
    // HEIC/HEIF still images share the ISO-BMFF container with MP4.
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))
      return { category: 'image', mime: 'image/heic' };
    if (brand === 'qt  ') return { category: 'video', mime: 'video/quicktime' };
    // isom, iso2, mp41, mp42, avc1, M4V …
    return { category: 'video', mime: 'video/mp4' };
  }

  return { category: 'unknown', mime: null };
}

export function isAllowedForKind(detected: DetectedType, expectVideo: boolean): boolean {
  if (detected.category === 'unknown' || !detected.mime) return false;
  return expectVideo ? ALLOWED_VIDEO.has(detected.mime) : ALLOWED_IMAGE.has(detected.mime);
}

/** Bytes needed to identify any supported format. */
export const SNIFF_BYTES = 32;
