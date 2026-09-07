import 'dart:io';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:model_viewer_plus/model_viewer_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import '../../core/api_client.dart';
import '../../models/avatar.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// The avatar viewer. Renders the textured GLB with the model-viewer element, which
/// handles embedded textures natively — the reason this app is Flutter.
class ViewerScreen extends StatefulWidget {
  final String renderId;
  const ViewerScreen({super.key, required this.renderId});
  @override
  State<ViewerScreen> createState() => _ViewerScreenState();
}

class _ViewerScreenState extends State<ViewerScreen> {
  AvatarRender? _avatar;
  bool _loading = true;
  bool _error = false;
  bool _exporting = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final j =
          await Api.I.get<Map<String, dynamic>>('/avatars/${widget.renderId}');
      setState(() {
        _avatar = AvatarRender.fromJson(j);
        _loading = false;
      });
    } catch (_) {
      setState(() {
        _error = true;
        _loading = false;
      });
    }
  }

  Future<void> _download(String format) async {
    setState(() => _exporting = true);
    try {
      final created = await Api.I.post<Map<String, dynamic>>(
          '/avatars/${widget.renderId}/exports',
          body: {'format': format});
      final rec = await Api.I
          .get<Map<String, dynamic>>('/exports/${created['id']}');
      final url = (rec['download'] as Map<String, dynamic>?)?['url'] as String?;
      if (url == null) throw Exception('no url');

      final res = await http.get(Uri.parse(url));
      final dir = await getTemporaryDirectory();
      final ext = format == 'GLB' ? 'glb' : 'zip';
      final file = File('${dir.path}/tailorai-avatar.$ext');
      await file.writeAsBytes(res.bodyBytes);

      await Share.shareXFiles([XFile(file.path)],
          text: 'My TailorAI body model');
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not prepare the download.')),
        );
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  void _showStats() {
    final a = _avatar;
    if (a == null) return;
    final t = Theme.of(context).textTheme;
    showModalBottomSheet(
      context: context,
      backgroundColor: T.surface,
      shape: const RoundedRectangleBorder(
          borderRadius:
              BorderRadius.vertical(top: Radius.circular(T.rLg))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(T.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Model details', style: t.titleLarge),
            const SizedBox(height: T.md),
            _row('Vertices', '${a.stats.vertexCount}'),
            _row('Triangles', '${a.stats.triangleCount}'),
            _row('Texture',
                a.stats.textureRes != null ? '${a.stats.textureRes}px' : 'none'),
            _row('File size',
                '${(a.stats.fileSizeBytes / 1024 / 1024).toStringAsFixed(2)} MB'),
            _row('Renderer', a.rendererVersion),
            const SizedBox(height: T.md),
          ],
        ),
      ),
    );
  }

  Widget _row(String k, String v) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(k, style: t.bodyMedium),
          Text(v, style: t.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;

    if (_loading) {
      return const Scaffold(
        body: Center(
            child: CircularProgressIndicator(color: T.brand, strokeWidth: 2.4)),
      );
    }
    if (_error || _avatar?.glbUrl == null) {
      return Scaffold(
        body: GlowBackground(
          child: SafeArea(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text("Couldn't load this model", style: t.titleLarge),
                  const SizedBox(height: T.lg),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: T.lg),
                    child: GradientButton('Back to home',
                        onPressed: () => context.go('/home')),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    final a = _avatar!;
    final inpainted = a.coverage?.inpaintedFraction ?? 0;

    return Scaffold(
      backgroundColor: T.bg,
      body: Stack(
        children: [
          // The textured 3D model.
          Positioned.fill(
            child: ModelViewer(
              key: ValueKey(a.glbUrl),
              src: a.glbUrl!,
              alt: 'Your 3D body model',
              ar: false,
              autoRotate: true,
              autoRotateDelay: 1200,
              rotationPerSecond: '18deg',
              cameraControls: true,
              disableZoom: false,
              backgroundColor: T.bg,
              interactionPrompt: InteractionPrompt.none,
            ),
          ),

          SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(T.md),
                  child: Row(
                    children: [
                      _iconButton(Icons.close, () => context.go('/home')),
                      const Spacer(),
                      _iconButton(Icons.info_outline, _showStats),
                    ],
                  ),
                ),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.all(T.md),
                  child: Column(
                    children: [
                      // Coverage honesty: name inferred regions rather than
                      // presenting invented geometry as measured.
                      if (inpainted > 0.15)
                        _notice(
                          'Some areas were estimated',
                          "We couldn't see ${(inpainted * 100).round()}% of your surface — usually under the arms and inner legs. A slower full turn improves this.",
                        ),
                      if (a.isDegraded)
                        _notice('Untextured model',
                            "We built your shape but couldn't finish the colour. The geometry is still accurate."),
                      const SizedBox(height: T.sm),
                      Row(
                        children: [
                          Expanded(
                            child: GradientButton(
                              'Download GLB',
                              icon: Icons.download_rounded,
                              loading: _exporting,
                              onPressed: () => _download('GLB'),
                            ),
                          ),
                          const SizedBox(width: T.sm),
                          SizedBox(
                            width: 96,
                            child: SoftButton('OBJ',
                                onPressed: _exporting
                                    ? null
                                    : () => _download('OBJ_ZIP')),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _notice(String title, String body) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: T.sm),
      child: Glass(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style: t.titleMedium?.copyWith(color: Colors.white)),
            const SizedBox(height: 2),
            Text(body,
                style: t.bodySmall?.copyWith(color: Colors.white70)),
          ],
        ),
      ),
    );
  }

  Widget _iconButton(IconData icon, VoidCallback onTap) {
    return Glass(
      radius: T.rPill,
      padding: EdgeInsets.zero,
      child: IconButton(
        onPressed: onTap,
        icon: Icon(icon, color: Colors.white, size: 22),
      ),
    );
  }
}
