import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../state/session.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// Biometric consent — a legal control, not a formality. BIPA requires informed
/// consent before collection with a stated retention schedule, so this says
/// plainly what we collect, keep, and never do, in language a person can read.
class ConsentScreen extends StatefulWidget {
  const ConsentScreen({super.key});
  @override
  State<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<ConsentScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _accept() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().grantBiometricConsent();
    } catch (_) {
      setState(() => _error = 'Could not save your choice. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    const items = [
      (
        Icons.photo_camera_outlined,
        'What we collect',
        'The photos or video you capture, and the body measurements derived from them.'
      ),
      (
        Icons.schedule_outlined,
        'What we keep, and for how long',
        'Your photos and video are deleted after 30 days. Your body model — a small set of numbers — is kept until you delete it.'
      ),
      (
        Icons.block_outlined,
        'What we never do',
        'We never sell your data, share it with advertisers, or use it to train models without asking you separately.'
      ),
      (
        Icons.download_done_outlined,
        'Your control',
        'Download everything we hold, or delete your account and all its data, at any time from Settings.'
      ),
    ];

    return Scaffold(
      body: GlowBackground(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(T.lg),
                  children: [
                    const Reveal(child: BrandMark(size: 26)),
                    const SizedBox(height: T.lg),
                    Reveal(
                      delay: const Duration(milliseconds: 80),
                      child: Text('Before we begin', style: t.displaySmall),
                    ),
                    const SizedBox(height: T.sm),
                    Reveal(
                      delay: const Duration(milliseconds: 160),
                      child: Text(
                        'Building a 3D model of your body means processing biometric data. Here is exactly what that involves.',
                        style: t.bodyMedium,
                      ),
                    ),
                    const SizedBox(height: T.lg),
                    for (var i = 0; i < items.length; i++)
                      Reveal(
                        delay: Duration(milliseconds: 220 + i * 90),
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: T.sm + 4),
                          child: AppCard(
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(9),
                                  decoration: BoxDecoration(
                                    color: T.brand.withValues(alpha: 0.14),
                                    borderRadius:
                                        BorderRadius.circular(T.rSm),
                                  ),
                                  child: Icon(items[i].$1,
                                      color: T.brandBright, size: 20),
                                ),
                                const SizedBox(width: T.md),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(items[i].$2,
                                          style: t.titleMedium),
                                      const SizedBox(height: 3),
                                      Text(items[i].$3, style: t.bodyMedium),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    const SizedBox(height: T.sm),
                    Text(
                      'Please wear fitted clothing, like leggings and a t-shirt. It gives a better result and keeps things comfortable.',
                      style: t.bodySmall,
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(T.lg, 0, T.lg, T.md),
                child: Column(
                  children: [
                    if (_error != null) ...[
                      Text(_error!,
                          style: t.bodySmall?.copyWith(color: T.danger)),
                      const SizedBox(height: T.sm),
                    ],
                    GradientButton('I agree — process my body scans',
                        loading: _busy, onPressed: _accept),
                    const SizedBox(height: T.sm),
                    SoftButton('Not now',
                        ghost: true,
                        onPressed: () => context.read<Session>().signOut()),
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
