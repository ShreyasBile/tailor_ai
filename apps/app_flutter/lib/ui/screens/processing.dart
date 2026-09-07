import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../../core/job_stream.dart';
import '../../models/enums.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// The waiting screen. Two to three minutes decides whether this feels like
/// progress or abandonment — so the stage label and bar come from the server's
/// real stage feed, never a synthetic timer.
class ProcessingScreen extends StatefulWidget {
  final String jobId;
  const ProcessingScreen({super.key, required this.jobId});
  @override
  State<ProcessingScreen> createState() => _ProcessingScreenState();
}

class _ProcessingScreenState extends State<ProcessingScreen>
    with TickerProviderStateMixin {
  late final JobStream _stream;
  late final AnimationController _pulse = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 2200))
    ..repeat(reverse: true);
  late final AnimationController _spin =
      AnimationController(vsync: this, duration: const Duration(seconds: 8))
        ..repeat();

  double _progress = 0;
  double _shownProgress = 0;
  String _status = 'QUEUED';
  String? _stage;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _stream = JobStream(widget.jobId);
    _stream.stream.listen(_onEvent);
    _stream.start();
  }

  void _onEvent(JobProgress p) {
    if (!mounted) return;
    setState(() {
      _status = p.status;
      _stage = p.stage ?? _stage;
      _progress = p.progress;
    });
    // Ease the bar toward the target so it never jumps.
    _animateBar();
    if (p.status == 'COMPLETED' && p.result != null) {
      HapticFeedback.mediumImpact();
      context.pushReplacement('/viewer/${p.result!['renderId']}');
    } else if (p.status == 'FAILED') {
      HapticFeedback.vibrate();
      setState(() {
        _errorMessage = p.errorMessage;
      });
    }
  }

  void _animateBar() async {
    while (_shownProgress < _progress && mounted) {
      await Future.delayed(const Duration(milliseconds: 16));
      if (!mounted) return;
      setState(() =>
          _shownProgress = (_shownProgress + 0.01).clamp(0.0, _progress));
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    _spin.dispose();
    _stream.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;

    if (_status == 'FAILED') return _failView(t);
    if (_status == 'CANCELLED') return _simpleView(t, 'Scan cancelled');

    final label = _stage != null
        ? (stageLabels[_stage!] ?? 'Working')
        : 'Getting started';

    return Scaffold(
      body: GlowBackground(
        glow1: const Alignment(0, -0.5),
        glow2: const Alignment(0, 1.1),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(T.lg),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _orb(),
                const SizedBox(height: T.xl),
                Text('Building your model', style: t.displaySmall),
                const SizedBox(height: T.sm),
                AnimatedSwitcher(
                  duration: T.med,
                  child: Text(label,
                      key: ValueKey(label),
                      style: t.bodyLarge?.copyWith(color: T.textSecondary)),
                ),
                const SizedBox(height: T.xl),
                ClipRRect(
                  borderRadius: BorderRadius.circular(T.rPill),
                  child: LinearProgressIndicator(
                    value: _shownProgress.clamp(0.02, 1.0),
                    minHeight: 8,
                    backgroundColor: T.surfaceRaised,
                    valueColor: const AlwaysStoppedAnimation(T.brand),
                  ),
                ),
                const SizedBox(height: T.sm),
                Text('${(_shownProgress * 100).round()}%', style: t.bodySmall),
                const SizedBox(height: T.xxl),
                Text(
                  'You can leave this screen — your model keeps building.',
                  textAlign: TextAlign.center,
                  style: t.bodySmall,
                ),
                const SizedBox(height: T.md),
                SoftButton('Back to home',
                    ghost: true, onPressed: () => context.go('/home')),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _orb() {
    return AnimatedBuilder(
      animation: Listenable.merge([_pulse, _spin]),
      builder: (_, __) {
        final scale = 1 + _pulse.value * 0.08;
        return Transform.scale(
          scale: scale,
          child: Transform.rotate(
            angle: _spin.value * 2 * math.pi,
            child: Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: SweepGradient(
                  colors: const [T.brand, T.violet, T.cyan, T.brand],
                  transform: GradientRotation(_spin.value * 2 * math.pi),
                ),
                boxShadow: [
                  BoxShadow(
                      color: T.brand.withValues(alpha: 0.4 + _pulse.value * 0.2),
                      blurRadius: 40,
                      spreadRadius: 4),
                ],
              ),
              child: Container(
                margin: const EdgeInsets.all(6),
                decoration: const BoxDecoration(
                    color: T.bg, shape: BoxShape.circle),
                child: const Icon(Icons.person_outline,
                    color: Colors.white, size: 44),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _failView(TextTheme t) {
    return Scaffold(
      body: GlowBackground(
        glow1: const Alignment(0, -0.4),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(T.lg),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.error_outline, color: T.danger, size: 56),
                const SizedBox(height: T.lg),
                Text("That didn't work", style: t.displaySmall),
                const SizedBox(height: T.sm),
                Text(
                  _errorMessage ?? 'Something went wrong. Please try again.',
                  textAlign: TextAlign.center,
                  style: t.bodyMedium,
                ),
                const SizedBox(height: T.xl),
                GradientButton('Try another scan',
                    onPressed: () => context.go('/capture')),
                const SizedBox(height: T.sm),
                SoftButton('Back to home',
                    ghost: true, onPressed: () => context.go('/home')),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _simpleView(TextTheme t, String title) {
    return Scaffold(
      body: GlowBackground(
        child: SafeArea(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: t.displaySmall),
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
}
