import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../models/avatar.dart';
import '../../state/session.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  AvatarRender? _avatar;
  BodyCore? _core;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final a = await Api.I.get<Map<String, dynamic>>('/me/avatar');
      _avatar = AvatarRender.fromJson(a);
    } on ApiError catch (e) {
      if (!e.isNotFound) rethrow;
      _avatar = null;
    } catch (_) {}
    try {
      final c = await Api.I.get<Map<String, dynamic>>('/me/body-core');
      _core = BodyCore.fromJson(c);
    } on ApiError {
      _core = null;
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final session = context.watch<Session>();
    final hasAvatar = _avatar != null;
    final needsHeight = session.user?.heightCm == null;

    return Scaffold(
      body: GlowBackground(
        child: SafeArea(
          child: RefreshIndicator(
            color: T.brand,
            backgroundColor: T.surface,
            onRefresh: _load,
            child: ListView(
              padding: const EdgeInsets.all(T.lg),
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const BrandMark(size: 24),
                    IconButton(
                      onPressed: () => context.push('/profile'),
                      icon: const Icon(Icons.person_outline, color: T.text),
                      style: IconButton.styleFrom(
                          backgroundColor: T.surfaceRaised),
                    ),
                  ],
                ),
                const SizedBox(height: T.lg),
                Reveal(child: Text(_greeting(), style: t.displaySmall)),
                const SizedBox(height: T.lg),

                if (_loading)
                  const _HeroSkeleton()
                else if (hasAvatar)
                  Reveal(child: _AvatarHero(avatar: _avatar!, core: _core))
                else
                  const Reveal(child: _EmptyHero()),

                const SizedBox(height: T.lg),

                if (needsHeight) ...[
                  Reveal(
                    delay: const Duration(milliseconds: 120),
                    child: AppCard(
                      onTap: () => context.push('/profile'),
                      child: Row(
                        children: [
                          const Icon(Icons.straighten,
                              color: T.cyan, size: 22),
                          const SizedBox(width: T.md),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Add your height', style: t.titleMedium),
                                const SizedBox(height: 2),
                                Text(
                                  'It’s what makes your model real-world accurate.',
                                  style: t.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.chevron_right,
                              color: T.textTertiary),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: T.md),
                ],

                Reveal(
                  delay: const Duration(milliseconds: 200),
                  child: GradientButton(
                    hasAvatar ? 'New scan' : 'Create your body model',
                    icon: Icons.auto_awesome,
                    onPressed: () => context.push('/capture'),
                  ),
                ),
                const SizedBox(height: T.md),
                Center(
                  child: Text(
                    'Scans take about two to three minutes.\nYour photos are deleted after 30 days.',
                    textAlign: TextAlign.center,
                    style: t.bodySmall,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AvatarHero extends StatelessWidget {
  final AvatarRender avatar;
  final BodyCore? core;
  const _AvatarHero({required this.avatar, this.core});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return GestureDetector(
      onTap: () => context.push('/viewer/${avatar.id}'),
      child: Container(
        height: 300,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(T.rLg),
          border: Border.all(color: T.border),
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [T.surfaceRaised, T.surface],
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Align(
              alignment: Alignment.topCenter,
              child: DecoratedBox(
                decoration:
                    BoxDecoration(gradient: T.heroGlow(T.brand)),
                child: const SizedBox(width: 320, height: 260),
              ),
            ),
            if (avatar.thumbnailUrl != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: T.md),
                child: Image.network(avatar.thumbnailUrl!,
                    fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) =>
                        const Icon(Icons.person, size: 90, color: T.textTertiary)),
              )
            else
              const Center(
                  child:
                      Icon(Icons.person, size: 90, color: T.textTertiary)),
            Positioned(
              left: T.md,
              right: T.md,
              bottom: T.md,
              child: Glass(
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Your body model',
                              style: t.titleMedium
                                  ?.copyWith(color: Colors.white)),
                          const SizedBox(height: 2),
                          Text(
                            '${core?.heightCm != null ? '${core!.heightCm!.round()} cm · ' : ''}${avatar.stats.triangleCount} triangles',
                            style: t.bodySmall
                                ?.copyWith(color: Colors.white70),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: const BoxDecoration(
                          gradient: T.brandGradient,
                          shape: BoxShape.circle),
                      child: const Icon(Icons.threed_rotation,
                          color: Colors.white, size: 22),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyHero extends StatelessWidget {
  const _EmptyHero();
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      height: 260,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(T.rLg),
        border: Border.all(color: T.border),
        color: T.surface.withValues(alpha: 0.5),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          ShaderMask(
            shaderCallback: (r) => T.brandGradientVivid.createShader(r),
            child: const Icon(Icons.accessibility_new,
                size: 72, color: Colors.white),
          ),
          const SizedBox(height: T.md),
          Text('No body model yet', style: t.titleLarge),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: T.xl),
            child: Text(
              'Capture yourself once and we’ll build a 3D model you can keep.',
              textAlign: TextAlign.center,
              style: t.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}

class _HeroSkeleton extends StatelessWidget {
  const _HeroSkeleton();
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 260,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(T.rLg),
        color: T.surface.withValues(alpha: 0.5),
      ),
      child: const Center(
          child: CircularProgressIndicator(color: T.brand, strokeWidth: 2.4)),
    );
  }
}
