import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'api_client.dart';

/// Resumable multipart upload.
///
/// Bytes go straight to object storage via presigned URLs — never through the
/// API. Each part is retried individually with backoff, so a dropped chunk
/// costs seconds rather than the whole transfer. A 60 MB video over a poor
/// connection has to survive.
class Uploader {
  static const _maxPartAttempts = 4;

  /// Uploads one file and returns its assetId. [onProgress] is 0..1.
  static Future<String> uploadFile({
    required String sessionId,
    required File file,
    required String fileName,
    required String mimeType,
    required String kind, // RAW_VIDEO | RAW_PHOTO
    bool mirrored = false,
    void Function(double)? onProgress,
  }) async {
    final sizeBytes = await file.length();
    final partSize = _choosePartSize(sizeBytes);
    final fingerprint = await _fingerprint(file, sizeBytes);

    final created = await Api.I.post<Map<String, dynamic>>(
      '/capture-sessions/$sessionId/uploads',
      body: {
        'kind': kind,
        'fileName': fileName,
        'sizeBytes': sizeBytes,
        'mimeType': mimeType,
        'clientFingerprint': fingerprint,
        'partSizeBytes': partSize,
        if (kind == 'RAW_VIDEO') 'mirrored': mirrored,
      },
    );

    final uploadId = created['uploadId'] as String;
    final parts = (created['parts'] as List).cast<Map<String, dynamic>>();
    final total = parts.length;
    final etags = <Map<String, dynamic>>[];

    final raf = await file.open();
    try {
      for (var i = 0; i < parts.length; i++) {
        final part = parts[i];
        final partNumber = part['partNumber'] as int;
        final offset = (partNumber - 1) * partSize;
        final length = min(partSize, sizeBytes - offset);

        await raf.setPosition(offset);
        final chunk = await raf.read(length);

        final etag = await _putPart(part['url'] as String, chunk, mimeType);
        etags.add({'partNumber': partNumber, 'etag': etag});
        onProgress?.call((i + 1) / total);
      }
    } finally {
      await raf.close();
    }

    final res = await Api.I.post<Map<String, dynamic>>(
      '/uploads/$uploadId/complete',
      body: {'parts': etags},
    );
    return res['assetId'] as String;
  }

  static Future<String> _putPart(String url, List<int> chunk, String mime) async {
    Object? lastErr;
    for (var attempt = 0; attempt < _maxPartAttempts; attempt++) {
      try {
        final res = await http
            .put(Uri.parse(url), body: chunk, headers: {'content-type': mime})
            .timeout(const Duration(seconds: 60));
        if (res.statusCode != 200 && res.statusCode != 204) {
          throw Exception('part ${res.statusCode}');
        }
        final etag = res.headers['etag'];
        if (etag == null) throw Exception('no ETag');
        return etag.replaceAll('"', '');
      } catch (e) {
        lastErr = e;
        await Future.delayed(Duration(milliseconds: min(8000, 500 * (1 << attempt))));
      }
    }
    throw Exception('part upload failed: $lastErr');
  }

  static int _choosePartSize(int size) {
    const mib = 1024 * 1024;
    if (size <= 40 * mib) return 5 * mib;
    if (size <= 200 * mib) return 8 * mib;
    return 16 * mib;
  }

  /// Cheap content fingerprint for dedupe/resume — NOT an integrity control.
  /// Real integrity is enforced server-side (byte length + magic bytes). We hash
  /// the head, tail and size rather than the whole file so a 60 MB video does
  /// not stall the UI.
  static Future<String> _fingerprint(File file, int size) async {
    final raf = await file.open();
    try {
      final headLen = min(65536, size);
      await raf.setPosition(0);
      final head = await raf.read(headLen);
      final tailLen = min(65536, size);
      await raf.setPosition(max(0, size - tailLen));
      final tail = await raf.read(tailLen);
      final digest = sha256.convert([...head, ...tail, ...'$size'.codeUnits]);
      return digest.toString();
    } finally {
      await raf.close();
    }
  }
}
