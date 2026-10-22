import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../models/measurements.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// Measurement explorer (Stage 1 of the AR measurement feature).
///
/// Tap a measurement → its region highlights on the body diagram and the value
/// appears. Every value is labelled "estimated" with the scan's confidence —
/// a measurement is never shown as an authoritative number. Stage 2 replaces
/// the diagram with a live-camera AR overlay on the real person.
class MeasurementsScreen extends StatefulWidget {
  const MeasurementsScreen({super.key});
  @override
  State<MeasurementsScreen> createState() => _MeasurementsScreenState();
}

class _MeasurementsScreenState extends State<MeasurementsScreen> {
  Measurements? _data;
  bool _loading = true;
  String? _error;
  MeasurementRegion? _selected;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final j = await Api.I.get<Map<String, dynamic>>('/me/measurements');
      final m = Measurements.fromJson(j);
      setState(() {
        _data = m;
        _loading = false;
        _selected = m.items.isNotEmpty
            ? m.items.firstWhere((e) => e.key == 'waist', orElse: () => m.items.first)
            : null;
      });
    } on ApiError catch (e) {
      setState(() {
        _error = e.isNotFound ? "You don't have a body model yet." : e.message;
        _loading = false;
      });
    } catch (_) {
      setState(() {
        _error = 'Could not load your measurements.';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Measurements'),
        actions: [
          if (_data != null)
            Padding(
              padding: const EdgeInsets.only(right: T.sm),
              child: TextButton.icon(
                onPressed: () => context.push('/measurements/ar'),
                icon: const Icon(Icons.view_in_ar, color: T.brandBright, size: 20),
                label: const Text('Live AR', style: TextStyle(color: T.brandBright)),
              ),
            ),
        ],
      ),
      body: GlowBackground(
        child: SafeArea(
          top: false,
          child: _loading
              ? const Center(
                  child: CircularProgressIndicator(color: T.brand, strokeWidth: 2.4))
              : _error != null
                  ? _errorView(t)
                  : _content(t),
        ),
      ),
    );
  }

  Widget _errorView(TextTheme t) => Center(
        child: Padding(
          padding: const EdgeInsets.all(T.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center, style: t.bodyLarge),
              const SizedBox(height: T.lg),
              GradientButton('Create your body model',
                  onPressed: () => context.go('/capture')),
            ],
          ),
        ),
      );

  Widget _content(TextTheme t) {
    final data = _data!;
    final sel = _selected;
    return Column(
      children: [
        // Body diagram with the highlighted region.
        Expanded(
          flex: 5,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: T.lg, vertical: T.sm),
            child: LayoutBuilder(
              builder: (_, box) => CustomPaint(
                size: Size(box.maxWidth, box.maxHeight),
                painter: BodyDiagramPainter(sel),
              ),
            ),
          ),
        ),

        // Selected value + honesty labelling.
        if (sel != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: T.lg),
            child: _valueCard(t, sel, data),
          ),

        const SizedBox(height: T.sm),

        // Measurement chips.
        Expanded(
          flex: 3,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(T.lg, T.sm, T.lg, T.lg),
            child: Wrap(
              spacing: T.sm,
              runSpacing: T.sm,
              children: [
                for (final m in data.items)
                  _chip(m, selected: sel?.key == m.key),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _valueCard(TextTheme t, MeasurementRegion sel, Measurements data) {
    final conf = data.confidence ?? 0;
    return AppCard(
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(sel.label, style: t.titleMedium),
              const SizedBox(height: 2),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  ShaderMask(
                    shaderCallback: (r) => T.brandGradientVivid.createShader(r),
                    child: Text(sel.value.toStringAsFixed(1),
                        style: t.displaySmall?.copyWith(color: Colors.white)),
                  ),
                  const SizedBox(width: 4),
                  Text('cm', style: t.bodyMedium),
                ],
              ),
            ],
          ),
          const Spacer(),
          // Uncertainty travels with the number.
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (data.estimated)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: T.sm, vertical: 4),
                  decoration: BoxDecoration(
                    color: T.warning.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(T.rPill),
                  ),
                  child: Text('Estimated',
                      style: t.bodySmall?.copyWith(
                          color: T.warning, fontWeight: FontWeight.w700)),
                ),
              const SizedBox(height: 6),
              ConfidenceBadge(conf),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(MeasurementRegion m, {required bool selected}) {
    final t = Theme.of(context).textTheme;
    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        setState(() => _selected = m);
      },
      child: AnimatedContainer(
        duration: T.fast,
        padding: const EdgeInsets.symmetric(horizontal: T.md, vertical: 10),
        decoration: BoxDecoration(
          gradient: selected ? T.brandGradient : null,
          color: selected ? null : T.surfaceRaised,
          borderRadius: BorderRadius.circular(T.rPill),
          border: Border.all(color: selected ? Colors.transparent : T.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(m.label,
                style: t.labelLarge?.copyWith(
                    color: selected ? Colors.white : T.textSecondary,
                    fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text(m.value.toStringAsFixed(0),
                style: t.labelLarge?.copyWith(
                    color: selected ? Colors.white : T.text,
                    fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }
}

/// Front-view body diagram that highlights one measurement's region.
///
/// The body is drawn from anatomical fractions of stature (0=feet, 1=head), so
/// a girth band, width span, or length arrow lands exactly on the right place
/// regardless of screen size. Girth highlights are clipped to the relevant body
/// part so an arm measurement lights up the arms, not the torso.
class BodyDiagramPainter extends CustomPainter {
  final MeasurementRegion? sel;
  BodyDiagramPainter(this.sel);

  // Landmark heights (fraction of stature from the ground).
  static const _shoulderY = 0.82, _chestY = 0.72, _waistY = 0.63, _hipY = 0.53;
  static const _crotchY = 0.47, _ankleY = 0.05, _neckY = 0.87;
  static const _headCY = 0.935, _headR = 0.066;

  @override
  void paint(Canvas canvas, Size size) {
    // Fit the body (height 1.0) into the available box with margin.
    final h = size.height * 0.94;
    final top = size.height * 0.03;
    final cx = size.width / 2;
    double px(double xFrac) => cx + xFrac * h; // x fractions are also of stature
    double py(double yFrac) => top + (1 - yFrac) * h;

    final bodyPaint = Paint()..color = T.surfaceRaised;
    final edge = Paint()
      ..color = T.borderStrong
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;

    final torso = _torsoPath(px, py);
    final head = Path()..addOval(Rect.fromCircle(center: Offset(px(0), py(_headCY)), radius: _headR * h));
    final legL = _legPath(px, py, -1);
    final legR = _legPath(px, py, 1);
    final armL = _armPath(px, py, -1);
    final armR = _armPath(px, py, 1);

    for (final p in [torso, head, legL, legR, armL, armR]) {
      canvas.drawPath(p, bodyPaint);
    }
    for (final p in [torso, head, legL, legR, armL, armR]) {
      canvas.drawPath(p, edge);
    }

    final s = sel;
    if (s == null) return;

    final hi = Paint()..color = T.brand;
    final glow = Paint()
      ..color = T.brand.withValues(alpha: 0.35)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 8);

    if (s.kind == 'girth' && s.y != null) {
      final y = py(s.y!);
      final band = size.height * 0.026;
      if (s.side == 'arm') {
        for (final side in [-1.0, 1.0]) {
          _clipBand(canvas, side < 0 ? armL : armR, y, band, hi, glow);
        }
      } else if (s.side == 'leg') {
        for (final side in [-1.0, 1.0]) {
          _clipBand(canvas, side < 0 ? legL : legR, y, band, hi, glow);
        }
      } else {
        _clipBand(canvas, torso, y, band, hi, glow);
      }
    } else if (s.kind == 'width' && s.y != null) {
      _dimArrow(canvas, Offset(px(-0.12), py(s.y!)), Offset(px(0.12), py(s.y!)), hi);
    } else if (s.kind == 'length' && s.y0 != null && s.y1 != null) {
      final x = px(s.side == 'full' ? 0.26 : 0.22);
      _dimArrow(canvas, Offset(x, py(s.y0!)), Offset(x, py(s.y1!)), hi);
    }
  }

  void _clipBand(Canvas c, Path part, double y, double band, Paint hi, Paint glow) {
    c.save();
    c.clipPath(part);
    final rect = Rect.fromLTRB(0, y - band / 2, 100000, y + band / 2);
    c.drawRect(rect, glow);
    c.drawRect(rect, hi);
    c.restore();
  }

  void _dimArrow(Canvas c, Offset a, Offset b, Paint hi) {
    final p = Paint()
      ..color = hi.color
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    c.drawLine(a, b, p);
    const cap = 7.0;
    if ((a.dy - b.dy).abs() < 1) {
      c.drawLine(a, a.translate(0, -cap), p);
      c.drawLine(a, a.translate(0, cap), p);
      c.drawLine(b, b.translate(0, -cap), p);
      c.drawLine(b, b.translate(0, cap), p);
    } else {
      c.drawLine(a, a.translate(-cap, 0), p);
      c.drawLine(a, a.translate(cap, 0), p);
      c.drawLine(b, b.translate(-cap, 0), p);
      c.drawLine(b, b.translate(cap, 0), p);
    }
  }

  Path _torsoPath(double Function(double) px, double Function(double) py) {
    // Right-half control widths (fraction of stature) at key heights.
    const pts = [
      [_neckY, 0.035], [_shoulderY, 0.115], [_chestY, 0.10],
      [_waistY, 0.076], [_hipY, 0.098], [_crotchY, 0.085],
    ];
    final path = Path()..moveTo(px(0), py(_neckY + 0.01));
    for (final p in pts) {
      path.lineTo(px(p[1]), py(p[0]));
    }
    path.lineTo(px(0.02), py(_crotchY)); // to centre at crotch
    path.lineTo(px(-0.02), py(_crotchY));
    for (final p in pts.reversed) {
      path.lineTo(px(-p[1]), py(p[0]));
    }
    path.close();
    return path;
  }

  Path _legPath(double Function(double) px, double Function(double) py, double side) {
    // Tapered bar from the crotch line down to the ankle, offset to one side.
    final hipX = 0.045 * side, ankX = 0.038 * side;
    return Path()
      ..moveTo(px(hipX - 0.05), py(_crotchY))
      ..lineTo(px(hipX + 0.05), py(_crotchY))
      ..lineTo(px(ankX + 0.024), py(_ankleY))
      ..lineTo(px(ankX - 0.024), py(_ankleY))
      ..close();
  }

  Path _armPath(double Function(double) px, double Function(double) py, double side) {
    final shX = 0.10 * side, wrX = 0.165 * side;
    final th = 0.028; // arm half-thickness
    return Path()
      ..moveTo(px(shX - th), py(_shoulderY))
      ..lineTo(px(shX + th), py(_shoulderY))
      ..lineTo(px(wrX + th * 0.7), py(0.52))
      ..lineTo(px(wrX - th * 0.7), py(0.52))
      ..close();
  }

  @override
  bool shouldRepaint(BodyDiagramPainter old) => old.sel?.key != sel?.key;
}
