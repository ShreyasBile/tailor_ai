import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../models/avatar.dart';
import '../../models/enums.dart';
import '../../state/session.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _height = TextEditingController();
  bool _saving = false;
  String? _error;
  List<BodyCore> _history = [];

  @override
  void initState() {
    super.initState();
    final h = context.read<Session>().user?.heightCm;
    if (h != null) _height.text = h.round().toString();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    try {
      final list =
          await Api.I.get<List<dynamic>>('/me/body-core/history');
      setState(() => _history =
          list.cast<Map<String, dynamic>>().map(BodyCore.fromJson).toList());
    } on ApiError {
      // no cores yet
    } catch (_) {}
  }

  Future<void> _saveHeight() async {
    final v = double.tryParse(_height.text);
    if (v == null || v < 50 || v > 260) {
      setState(() => _error = 'Please enter a height between 50 and 260 cm.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await context.read<Session>().updateHeight(v);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Height saved.')));
      }
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _confirmDelete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: T.surface,
        title: const Text('Delete everything?'),
        content: const Text(
            'This permanently removes your body model, all scans, and your account. It cannot be undone.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Delete',
                  style: TextStyle(color: T.danger))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final router = GoRouter.of(context);
    final session = context.read<Session>();
    await session.deleteAccount();
    router.go('/sign-in');
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final session = context.watch<Session>();
    final current = _history.where((c) => c.isCurrent).firstOrNull;

    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: GlowBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(T.lg),
            children: [
              // Height first: the single largest accuracy lever.
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      const Icon(Icons.straighten, color: T.cyan, size: 20),
                      const SizedBox(width: T.sm),
                      Text('Your height', style: t.titleLarge),
                    ]),
                    const SizedBox(height: T.sm),
                    Text(
                      'A photo can’t tell how tall you are. This one number makes your model real-world accurate.',
                      style: t.bodyMedium,
                    ),
                    const SizedBox(height: T.md),
                    Row(
                      children: [
                        Expanded(
                          child: Container(
                            decoration: BoxDecoration(
                              color: T.surfaceRaised,
                              borderRadius: BorderRadius.circular(T.rMd),
                            ),
                            child: TextField(
                              controller: _height,
                              keyboardType: TextInputType.number,
                              style: t.bodyLarge,
                              decoration: const InputDecoration(
                                hintText: '178',
                                suffixText: 'cm',
                                border: InputBorder.none,
                                contentPadding: EdgeInsets.symmetric(
                                    horizontal: T.md, vertical: 16),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: T.sm),
                        SizedBox(
                          width: 110,
                          height: 54,
                          child: GradientButton('Save',
                              loading: _saving, onPressed: _saveHeight),
                        ),
                      ],
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: T.sm),
                      Text(_error!,
                          style: t.bodySmall?.copyWith(color: T.danger)),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: T.md),

              if (current != null) ...[
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Current body model', style: t.titleLarge),
                      const SizedBox(height: T.sm),
                      if (current.overallQuality != null)
                        ConfidenceBadge(current.overallQuality!),
                      const SizedBox(height: T.sm),
                      Text(
                        'Version ${current.version} · ${current.frameCount} frames · ${current.captureMode == 'VIDEO_360' ? 'video' : 'photos'}',
                        style: t.bodySmall,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        scaleExplanation[current.scaleSource] ??
                            current.scaleSource,
                        style: t.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: T.md),
              ],

              if (_history.length > 1) ...[
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Scan history', style: t.titleLarge),
                      const SizedBox(height: T.sm),
                      for (final c in _history)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Row(
                            children: [
                              Text('v${c.version}',
                                  style: t.bodyLarge?.copyWith(
                                      fontWeight: FontWeight.w700)),
                              const SizedBox(width: T.md),
                              Text(c.createdAt.split('T').first,
                                  style: t.bodySmall),
                              const Spacer(),
                              Text(
                                  c.heightCm != null
                                      ? '${c.heightCm!.round()} cm'
                                      : '—',
                                  style: t.bodySmall),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: T.md),
              ],

              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Your data', style: t.titleLarge),
                    const SizedBox(height: T.sm),
                    Text(
                      'Photos and video are deleted after 30 days. Your body model is kept until you delete it.',
                      style: t.bodyMedium,
                    ),
                    const SizedBox(height: T.md),
                    SoftButton('Delete everything',
                        icon: Icons.delete_outline,
                        tint: T.danger,
                        onPressed: _confirmDelete),
                  ],
                ),
              ),
              const SizedBox(height: T.md),
              SoftButton('Sign out',
                  ghost: true,
                  onPressed: () async {
                    final router = GoRouter.of(context);
                    await context.read<Session>().signOut();
                    router.go('/sign-in');
                  }),
              const SizedBox(height: T.md),
              Center(
                  child: Text(session.user?.email ?? '', style: t.bodySmall)),
            ],
          ),
        ),
      ),
    );
  }
}
