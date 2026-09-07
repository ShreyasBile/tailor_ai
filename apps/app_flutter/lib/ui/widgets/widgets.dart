import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../theme/tokens.dart';

/// Primary call to action — the brand gradient, the only place it appears as a
/// fill. Scarcity is what keeps it meaningful.
class GradientButton extends StatefulWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;
  const GradientButton(this.label,
      {super.key, this.onPressed, this.loading = false, this.icon});

  @override
  State<GradientButton> createState() => _GradientButtonState();
}

class _GradientButtonState extends State<GradientButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null && !widget.loading;
    return GestureDetector(
      onTapDown: enabled ? (_) => setState(() => _down = true) : null,
      onTapCancel: () => setState(() => _down = false),
      onTapUp: enabled
          ? (_) {
              setState(() => _down = false);
              HapticFeedback.lightImpact();
              widget.onPressed!.call();
            }
          : null,
      child: AnimatedScale(
        scale: _down ? 0.97 : 1.0,
        duration: T.fast,
        child: AnimatedOpacity(
          opacity: enabled ? 1 : 0.45,
          duration: T.fast,
          child: Container(
            height: 56,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: T.brandGradient,
              borderRadius: BorderRadius.circular(T.rMd),
              boxShadow: [
                BoxShadow(
                    color: T.brand.withValues(alpha: enabled ? 0.4 : 0),
                    blurRadius: 24,
                    offset: const Offset(0, 8)),
              ],
            ),
            child: widget.loading
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                        strokeWidth: 2.4, color: Colors.white))
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (widget.icon != null) ...[
                        Icon(widget.icon, size: 20, color: Colors.white),
                        const SizedBox(width: T.sm),
                      ],
                      Text(widget.label,
                          style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w600,
                              fontSize: 16)),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// Secondary / ghost button.
class SoftButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool ghost;
  final IconData? icon;
  final Color? tint;
  const SoftButton(this.label,
      {super.key, this.onPressed, this.ghost = false, this.icon, this.tint});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: ghost ? Colors.transparent : T.surfaceRaised,
      borderRadius: BorderRadius.circular(T.rMd),
      child: InkWell(
        borderRadius: BorderRadius.circular(T.rMd),
        onTap: onPressed == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onPressed!.call();
              },
        child: Container(
          height: 54,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(T.rMd),
            border: ghost ? Border.all(color: T.border) : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 19, color: tint ?? T.textSecondary),
                const SizedBox(width: T.sm),
              ],
              Text(label,
                  style: TextStyle(
                      color: tint ?? (ghost ? T.textSecondary : T.text),
                      fontWeight: FontWeight.w600,
                      fontSize: 15)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Ambient background: a deep canvas with two soft brand glows. Gives every
/// screen depth without a single image asset.
class GlowBackground extends StatelessWidget {
  final Widget child;
  final Alignment glow1;
  final Alignment glow2;
  const GlowBackground(
      {super.key,
      required this.child,
      this.glow1 = const Alignment(-0.8, -0.9),
      this.glow2 = const Alignment(1.1, 0.4)});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: T.bg,
      child: Stack(
        children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: glow1,
                  radius: 1.1,
                  colors: [
                    T.brand.withValues(alpha: 0.20),
                    T.bg.withValues(alpha: 0)
                  ],
                ),
              ),
            ),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: glow2,
                  radius: 1.0,
                  colors: [
                    T.cyan.withValues(alpha: 0.10),
                    T.bg.withValues(alpha: 0)
                  ],
                ),
              ),
            ),
          ),
          child,
        ],
      ),
    );
  }
}

class AppCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets? padding;
  final VoidCallback? onTap;
  const AppCard({super.key, required this.child, this.padding, this.onTap});

  @override
  Widget build(BuildContext context) {
    final content = Container(
      padding: padding ?? const EdgeInsets.all(T.md),
      decoration: BoxDecoration(
        color: T.surface.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(T.rLg),
        border: Border.all(color: T.border),
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(T.rLg),
        onTap: () {
          HapticFeedback.selectionClick();
          onTap!.call();
        },
        child: content,
      ),
    );
  }
}

/// Frosted glass surface, for overlays on top of camera / 3D content.
class Glass extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  final double radius;
  const Glass(
      {super.key,
      required this.child,
      this.padding = const EdgeInsets.all(T.md),
      this.radius = T.rMd});

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.45),
            borderRadius: BorderRadius.circular(radius),
            border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
          ),
          child: child,
        ),
      ),
    );
  }
}

/// The wordmark. A gradient-filled "tailor" + softer "ai".
class BrandMark extends StatelessWidget {
  final double size;
  const BrandMark({super.key, this.size = 30});

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (r) => T.brandGradientVivid.createShader(r),
      child: Text.rich(
        TextSpan(children: [
          const TextSpan(text: 'tailor'),
          TextSpan(
              text: 'ai',
              style:
                  TextStyle(color: Colors.white.withValues(alpha: 0.85))),
        ]),
        style: TextStyle(
            color: Colors.white,
            fontSize: size,
            fontWeight: FontWeight.w800,
            letterSpacing: -1.0,
            height: 1),
      ),
    );
  }
}

/// Entrance animation: fade + rise. Wrap content and stagger with [delay].
class Reveal extends StatefulWidget {
  final Widget child;
  final Duration delay;
  final double offsetY;
  const Reveal(
      {super.key,
      required this.child,
      this.delay = Duration.zero,
      this.offsetY = 22});

  @override
  State<Reveal> createState() => _RevealState();
}

class _RevealState extends State<Reveal> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: T.slow);
  late final Animation<double> _a =
      CurvedAnimation(parent: _c, curve: T.curve);

  @override
  void initState() {
    super.initState();
    Future.delayed(widget.delay, () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _a,
      builder: (_, child) => Opacity(
        opacity: _a.value.clamp(0.0, 1.0),
        child: Transform.translate(
            offset: Offset(0, (1 - _a.value) * widget.offsetY), child: child),
      ),
      child: widget.child,
    );
  }
}

/// Quality / confidence chip. Uncertainty made visible, never hidden.
class ConfidenceBadge extends StatelessWidget {
  final double value;
  const ConfidenceBadge(this.value, {super.key});

  @override
  Widget build(BuildContext context) {
    final (label, tint) = value >= 0.75
        ? ('High confidence', T.success)
        : value >= 0.5
            ? ('Moderate confidence', T.warning)
            : ('Low confidence', T.danger);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: T.sm + 2, vertical: 5),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(T.rPill),
        border: Border.all(color: tint.withValues(alpha: 0.5)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
            width: 7,
            height: 7,
            decoration:
                BoxDecoration(color: tint, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(label,
            style: TextStyle(
                color: tint, fontSize: 12.5, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}
