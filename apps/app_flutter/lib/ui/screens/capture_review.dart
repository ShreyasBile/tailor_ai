import 'dart:io';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../core/uploader.dart';
import '../../state/capture_state.dart';
import '../../state/session.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

class CaptureReviewScreen extends StatefulWidget {
  final String mode;
  const CaptureReviewScreen({super.key, required this.mode});
  @override
  State<CaptureReviewScreen> createState() => _CaptureReviewScreenState();
}

class _CaptureReviewScreenState extends State<CaptureReviewScreen> {
  bool get _isVideo => widget.mode == 'VIDEO_360';
  bool _busy = false;
  String? _error;
  String _phase = 'idle';
  double _progress = 0;

  Future<void> _submit() async {
    final cap = context.read<CaptureState>();
    setState(() {
      _busy = true;
      _error = null;
      _phase = 'uploading';
    });
    try {
      final session = await Api.I.post<Map<String, dynamic>>(
        '/capture-sessions',
        body: {'mode': widget.mode, 'qualityHints': {'rejectedFrames': 0}},
      );
      final sid = session['id'] as String;

      if (_isVideo && cap.videoPath != null) {
        await Uploader.uploadFile(
          sessionId: sid,
          file: File(cap.videoPath!),
          fileName: 'capture.mp4',
          mimeType: 'video/mp4',
          kind: 'RAW_VIDEO',
          mirrored: cap.videoMirrored,
          onProgress: (f) => setState(() => _progress = f),
        );
      } else {
        for (var i = 0; i < cap.photos.length; i++) {
          await Uploader.uploadFile(
            sessionId: sid,
            file: File(cap.photos[i]),
            fileName: 'photo_$i.jpg',
            mimeType: 'image/jpeg',
            kind: 'RAW_PHOTO',
            onProgress: (f) =>
                setState(() => _progress = (i + f) / cap.photos.length),
          );
        }
      }

      await Api.I.post('/capture-sessions/$sid/finalise');

      setState(() => _phase = 'starting');
      final job = await Api.I.post<Map<String, dynamic>>(
        '/jobs',
        idempotencyKey: '$sid:reconstruct',
        body: {
          'sessionId': sid,
          'options': {'quality': 'standard', 'textured': true},
        },
      );

      cap.reset();
      if (mounted) context.pushReplacement('/processing/${job['id']}');
    } on ApiError catch (e) {
      setState(() {
        _phase = 'idle';
        _error = e.message;
      });
    } catch (_) {
      setState(() {
        _phase = 'idle';
        _error = 'Upload failed. Check your connection and retry.';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final cap = context.watch<CaptureState>();
    final session = context.watch<Session>();
    final canSubmit = _isVideo ? cap.videoPath != null : cap.photos.isNotEmpty;

    return Scaffold(
      appBar: AppBar(),
      body: GlowBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(T.lg),
            children: [
              Reveal(child: Text('Looks good?', style: t.displaySmall)),
              const SizedBox(height: T.sm),
              Reveal(
                delay: const Duration(milliseconds: 100),
                child: Text(
                  _isVideo
                      ? 'Your recording is ready to upload.'
                      : '${cap.photos.length} photo${cap.photos.length == 1 ? '' : 's'} ready to upload.',
                  style: t.bodyMedium,
                ),
              ),
              const SizedBox(height: T.lg),
              if (_isVideo)
                _VideoTile()
              else
                Wrap(
                  spacing: T.sm,
                  runSpacing: T.sm,
                  children: [
                    for (final p in cap.photos)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(T.rMd),
                        child: Image.file(File(p),
                            width: (MediaQuery.of(context).size.width - T.lg * 2 - T.sm) / 2,
                            height: 200,
                            fit: BoxFit.cover),
                      ),
                  ],
                ),
              const SizedBox(height: T.lg),
              if (session.user?.heightCm == null) ...[
                AppCard(
                  child: Row(
                    children: [
                      const Icon(Icons.lightbulb_outline, color: T.cyan),
                      const SizedBox(width: T.md),
                      Expanded(
                        child: Text(
                          'Adding your height in Profile makes the model real-world accurate. Without it we fall back to an average.',
                          style: t.bodySmall,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: T.md),
              ],
              if (_error != null) ...[
                Text(_error!, style: t.bodySmall?.copyWith(color: T.danger)),
                const SizedBox(height: T.sm),
              ],
              if (_phase == 'uploading') ...[
                ClipRRect(
                  borderRadius: BorderRadius.circular(T.rPill),
                  child: LinearProgressIndicator(
                    value: _progress,
                    minHeight: 6,
                    backgroundColor: T.surfaceRaised,
                    valueColor: const AlwaysStoppedAnimation(T.brand),
                  ),
                ),
                const SizedBox(height: T.sm),
                Text('Uploading… ${(_progress * 100).round()}%',
                    style: t.bodySmall),
                const SizedBox(height: T.md),
              ],
              GradientButton(
                _phase == 'starting' ? 'Starting…' : 'Build my model',
                icon: Icons.auto_awesome,
                loading: _busy,
                onPressed: canSubmit && !_busy ? _submit : null,
              ),
              const SizedBox(height: T.sm),
              SoftButton(
                'Retake',
                ghost: true,
                onPressed: _busy
                    ? null
                    : () {
                        cap.reset();
                        context.pushReplacement(
                            '/capture/camera?mode=${widget.mode}');
                      },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VideoTile extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 200,
      decoration: BoxDecoration(
        color: T.surface,
        borderRadius: BorderRadius.circular(T.rLg),
        border: Border.all(color: T.border),
      ),
      child: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.movie_creation_outlined, color: T.brandBright, size: 40),
            SizedBox(height: T.sm),
            Text('Video captured', style: TextStyle(color: T.textSecondary)),
          ],
        ),
      ),
    );
  }
}
