import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/api_error.dart';
import '../../state/session.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  String? _error;
  bool get _valid => _email.text.contains('@');

  Future<void> _submit() async {
    setState(() => _error = null);
    try {
      await context.read<Session>().signIn(_email.text);
      // Router redirect takes it from here.
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not sign in. Please try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final busy = context.watch<Session>().busy;
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: GlowBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(T.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Spacer(flex: 2),
                const Reveal(child: BrandMark(size: 40)),
                const SizedBox(height: T.lg),
                Reveal(
                  delay: const Duration(milliseconds: 120),
                  child: Text('A 3D model of you,\nfrom your phone.',
                      style: t.displaySmall),
                ),
                const SizedBox(height: T.md),
                Reveal(
                  delay: const Duration(milliseconds: 220),
                  child: Text(
                    'Capture once. Keep a permanent, private Digital Body Profile you can measure, view and export.',
                    style: t.bodyMedium,
                  ),
                ),
                const Spacer(flex: 3),
                Reveal(
                  delay: const Duration(milliseconds: 320),
                  child: Container(
                    decoration: BoxDecoration(
                      color: T.surface,
                      borderRadius: BorderRadius.circular(T.rMd),
                      border: Border.all(color: T.border),
                    ),
                    child: TextField(
                      controller: _email,
                      onChanged: (_) => setState(() {}),
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      style: t.bodyLarge,
                      decoration: const InputDecoration(
                        hintText: 'you@example.com',
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.symmetric(
                            horizontal: T.md, vertical: 18),
                        prefixIcon:
                            Icon(Icons.alternate_email, color: T.textTertiary),
                      ),
                    ),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: T.sm),
                  Text(_error!, style: t.bodySmall?.copyWith(color: T.danger)),
                ],
                const SizedBox(height: T.md),
                Reveal(
                  delay: const Duration(milliseconds: 380),
                  child: GradientButton(
                    'Continue',
                    loading: busy,
                    onPressed: _valid ? _submit : null,
                    icon: Icons.arrow_forward_rounded,
                  ),
                ),
                const SizedBox(height: T.md),
                Center(
                  child: Text(
                    'You must be 18 or over. We only use your email to identify your account.',
                    textAlign: TextAlign.center,
                    style: t.bodySmall,
                  ),
                ),
                const SizedBox(height: T.md),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
