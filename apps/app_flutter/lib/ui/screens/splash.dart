import 'package:flutter/material.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// Shown while the session hydrates. The router redirects away the moment
/// `session.hydrated` flips, so this is purely a branded loading moment.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 2))
        ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: GlowBackground(
        glow1: const Alignment(0, -0.3),
        glow2: const Alignment(0, 1.2),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Reveal(child: BrandMark(size: 44)),
              const SizedBox(height: T.md),
              Reveal(
                delay: const Duration(milliseconds: 200),
                child: Text('Your body, measured once.',
                    style: Theme.of(context).textTheme.bodyMedium),
              ),
              const SizedBox(height: T.xl),
              SizedBox(
                width: 32,
                height: 32,
                child: RotationTransition(
                  turns: _c,
                  child: ShaderMask(
                    shaderCallback: (r) => T.brandGradient.createShader(r),
                    child: const Icon(Icons.blur_circular,
                        color: Colors.white, size: 32),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
