import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// Capture instructions. Worth a full screen — capture quality dominates final
/// accuracy more than any model choice.
class CaptureGuideScreen extends StatelessWidget {
  final String mode;
  const CaptureGuideScreen({super.key, required this.mode});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final isVideo = mode == 'VIDEO_360';
    final tips = <(IconData, String, String)>[
      (Icons.checkroom, 'Wear fitted clothing',
          'Leggings and a t-shirt work well. Loose clothes hide your shape.'),
      (Icons.wallpaper, 'Find a plain wall',
          'A clear background makes it much easier to find your outline.'),
      (Icons.wb_sunny_outlined, 'Get even light',
          'Face a window if you can. Avoid harsh shadows and backlighting.'),
      (Icons.stay_current_portrait, 'Prop your phone up',
          'Lean it against something at about waist height, roughly 2 m away.'),
      (Icons.accessibility_new, 'Stand in an A-pose',
          'Feet shoulder-width apart, arms slightly out so they are separate.'),
      if (isVideo)
        (Icons.rotate_right, 'Turn slowly',
            'Take about 25 seconds for one full circle. Rushing blurs the frames.'),
    ];

    return Scaffold(
      appBar: AppBar(),
      body: GlowBackground(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(T.lg),
                  children: [
                    Reveal(
                        child: Text('Before you start', style: t.displaySmall)),
                    const SizedBox(height: T.lg),
                    for (var i = 0; i < tips.length; i++)
                      Reveal(
                        delay: Duration(milliseconds: 100 + i * 80),
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: T.sm + 4),
                          child: AppCard(
                            child: Row(
                              children: [
                                Icon(tips[i].$1,
                                    color: T.brandBright, size: 22),
                                const SizedBox(width: T.md),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(tips[i].$2, style: t.titleMedium),
                                      const SizedBox(height: 2),
                                      Text(tips[i].$3, style: t.bodyMedium),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(T.lg, 0, T.lg, T.md),
                child: Column(
                  children: [
                    GradientButton(
                      isVideo ? "I'm ready to record" : "I'm ready to shoot",
                      icon: Icons.camera_alt_rounded,
                      onPressed: () =>
                          context.push('/capture/camera?mode=$mode'),
                    ),
                    const SizedBox(height: T.sm),
                    Text(
                      'You can retake before anything is uploaded.',
                      style: t.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
