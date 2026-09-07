import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

class CaptureIntroScreen extends StatelessWidget {
  const CaptureIntroScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(),
      body: GlowBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(T.lg),
            children: [
              Reveal(child: Text('How would you\nlike to scan?', style: t.displaySmall)),
              const SizedBox(height: T.sm),
              Reveal(
                delay: const Duration(milliseconds: 120),
                child: Text(
                  'Video gives a noticeably better result — we see you from every side.',
                  style: t.bodyMedium,
                ),
              ),
              const SizedBox(height: T.lg),
              Reveal(
                delay: const Duration(milliseconds: 200),
                child: _ModeCard(
                  icon: Icons.videocam_rounded,
                  title: 'Record a slow turn',
                  detail:
                      'About 25 seconds. Turn slowly all the way around while your phone is propped up.',
                  recommended: true,
                  onTap: () =>
                      context.push('/capture/guide?mode=VIDEO_360'),
                ),
              ),
              const SizedBox(height: T.md),
              Reveal(
                delay: const Duration(milliseconds: 280),
                child: _ModeCard(
                  icon: Icons.photo_camera_rounded,
                  title: 'Take photos',
                  detail:
                      'Four shots: front, right, back, left. Quicker, but slightly less accurate.',
                  onTap: () =>
                      context.push('/capture/guide?mode=PHOTO_SET'),
                ),
              ),
              const SizedBox(height: T.lg),
              Text(
                'Either way, wear fitted clothing and stand against a plain wall with good light.',
                style: t.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ModeCard extends StatelessWidget {
  final IconData icon;
  final String title, detail;
  final bool recommended;
  final VoidCallback onTap;
  const _ModeCard({
    required this.icon,
    required this.title,
    required this.detail,
    required this.onTap,
    this.recommended = false,
  });

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(T.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  gradient: recommended
                      ? T.brandGradient
                      : const LinearGradient(
                          colors: [T.surfaceRaised, T.surfaceRaised]),
                  borderRadius: BorderRadius.circular(T.rMd),
                ),
                child: Icon(icon,
                    color: recommended ? Colors.white : T.textSecondary,
                    size: 24),
              ),
              const SizedBox(width: T.md),
              Expanded(child: Text(title, style: t.titleLarge)),
              if (recommended)
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: T.sm, vertical: 4),
                  decoration: BoxDecoration(
                    color: T.brand.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(T.rPill),
                  ),
                  child: Text('Best',
                      style: t.bodySmall?.copyWith(
                          color: T.brandBright,
                          fontWeight: FontWeight.w700)),
                ),
            ],
          ),
          const SizedBox(height: T.md),
          Text(detail, style: t.bodyMedium),
        ],
      ),
    );
  }
}
