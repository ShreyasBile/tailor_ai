import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:google_mlkit_pose_detection/google_mlkit_pose_detection.dart';
import 'package:permission_handler/permission_handler.dart';
import '../../core/api_client.dart';
import '../../models/measurements.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

/// Stage 2 — live AR measurement overlay.
///
/// Point the camera at the person (full body in frame). ML Kit tracks their
/// pose; tapping a measurement draws its band/line on the tracked body and
/// shows the value FROM THE SCAN. AR shows *where* the measurement is on the
/// real body and the scanned number — it does not measure live, and the value
/// stays labelled "estimated". Verify on a physical device: the emulator has
/// no real body to track.
class ArMeasureScreen extends StatefulWidget {
  const ArMeasureScreen({super.key});
  @override
  State<ArMeasureScreen> createState() => _ArMeasureScreenState();
}

class _ArMeasureScreenState extends State<ArMeasureScreen> with WidgetsBindingObserver {
  CameraController? _cam;
  final _detector = PoseDetector(options: PoseDetectorOptions());
  bool _permDenied = false;
  bool _initializing = true;
  bool _busy = false;
  int _frame = 0;

  Pose? _pose;
  Size _imageSize = Size.zero;
  InputImageRotation _rotation = InputImageRotation.rotation0deg;
  CameraLensDirection _lens = CameraLensDirection.back;

  Measurements? _data;
  MeasurementRegion? _selected;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadMeasurements();
    _setup();
  }

  Future<void> _loadMeasurements() async {
    try {
      final j = await Api.I.get<Map<String, dynamic>>('/me/measurements');
      final m = Measurements.fromJson(j);
      if (mounted) {
        setState(() {
          _data = m;
          _selected = m.items.isNotEmpty
              ? m.items.firstWhere((e) => e.key == 'waist', orElse: () => m.items.first)
              : null;
        });
      }
    } catch (_) {/* AR still useful for framing without values */}
  }

  Future<void> _setup() async {
    final status = await Permission.camera.request();
    if (!status.isGranted) {
      setState(() {
        _permDenied = true;
        _initializing = false;
      });
      return;
    }
    final cams = await availableCameras();
    final desc = cams.firstWhere(
      (c) => c.lensDirection == CameraLensDirection.back,
      orElse: () => cams.first,
    );
    _lens = desc.lensDirection;
    final controller = CameraController(
      desc,
      ResolutionPreset.high,
      enableAudio: false,
      // ML Kit wants NV21 on Android, BGRA on iOS.
      imageFormatGroup:
          Platform.isAndroid ? ImageFormatGroup.nv21 : ImageFormatGroup.bgra8888,
    );
    await controller.initialize();
    if (!mounted) return;
    await controller.startImageStream(_onFrame);
    setState(() {
      _cam = controller;
      _initializing = false;
    });
  }

  // Process ~every 3rd frame; skip while a detection is in flight.
  Future<void> _onFrame(CameraImage image) async {
    _frame++;
    if (_busy || _frame % 3 != 0) return;
    _busy = true;
    try {
      final input = _toInputImage(image);
      if (input == null) return;
      final poses = await _detector.processImage(input);
      if (!mounted) return;
      setState(() {
        _pose = poses.isNotEmpty ? poses.first : null;
        _imageSize = Size(image.width.toDouble(), image.height.toDouble());
      });
    } catch (_) {
      // transient frame errors are fine
    } finally {
      _busy = false;
    }
  }

  InputImage? _toInputImage(CameraImage image) {
    final cam = _cam;
    if (cam == null) return null;
    final sensor = cam.description.sensorOrientation;
    final rotation = InputImageRotationValue.fromRawValue(sensor) ??
        InputImageRotation.rotation0deg;
    _rotation = rotation;

    final format = InputImageFormatValue.fromRawValue(image.format.raw);
    if (image.planes.isEmpty) return null;
    final plane = image.planes.first;
    return InputImage.fromBytes(
      bytes: plane.bytes,
      metadata: InputImageMetadata(
        size: Size(image.width.toDouble(), image.height.toDouble()),
        rotation: rotation,
        format: format ?? InputImageFormat.nv21,
        bytesPerRow: plane.bytesPerRow,
      ),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final cam = _cam;
    if (cam == null || !cam.value.isInitialized) return;
    if (state == AppLifecycleState.inactive) {
      cam.dispose();
    } else if (state == AppLifecycleState.resumed) {
      _setup();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _cam?.dispose();
    _detector.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_permDenied) return _permView();
    if (_initializing || _cam == null || !_cam!.value.isInitialized) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator(color: T.brand, strokeWidth: 2.4)),
      );
    }

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          CameraPreview(_cam!),
          // Pose + measurement overlay.
          CustomPaint(
            painter: _ArPainter(
              pose: _pose,
              imageSize: _imageSize,
              rotation: _rotation,
              lens: _lens,
              selected: _selected,
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                _topBar(),
                const Spacer(),
                if (_pose == null) _hint(),
                _chips(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _topBar() {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(T.md),
      child: Row(
        children: [
          Glass(
            radius: T.rPill,
            padding: EdgeInsets.zero,
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white),
              onPressed: () => context.pop(),
            ),
          ),
          const SizedBox(width: T.sm),
          if (_selected != null && _data != null)
            Glass(
              radius: T.rPill,
              padding: const EdgeInsets.symmetric(horizontal: T.md, vertical: 8),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text('${_selected!.label}  ',
                    style: t.labelLarge?.copyWith(color: Colors.white70)),
                Text('${_selected!.value.toStringAsFixed(1)} cm',
                    style: t.labelLarge?.copyWith(
                        color: Colors.white, fontWeight: FontWeight.w800)),
                const SizedBox(width: 6),
                if (_data!.estimated)
                  const Text('· est', style: TextStyle(color: T.warning, fontSize: 12)),
              ]),
            ),
        ],
      ),
    );
  }

  Widget _hint() => Padding(
        padding: const EdgeInsets.only(bottom: T.sm),
        child: Glass(
          child: Text(
            'Point the camera at a person, head to toe.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white),
          ),
        ),
      );

  Widget _chips() {
    final data = _data;
    if (data == null) return const SizedBox(height: T.lg);
    return Container(
      height: 92,
      padding: const EdgeInsets.symmetric(vertical: T.sm),
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: T.md),
        children: [
          for (final m in data.items)
            Padding(
              padding: const EdgeInsets.only(right: T.sm),
              child: GestureDetector(
                onTap: () {
                  HapticFeedback.selectionClick();
                  setState(() => _selected = m);
                },
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: T.md, vertical: 10),
                    decoration: BoxDecoration(
                      gradient: _selected?.key == m.key ? T.brandGradient : null,
                      color: _selected?.key == m.key ? null : Colors.black.withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(T.rPill),
                      border: Border.all(color: Colors.white.withValues(alpha: 0.15)),
                    ),
                    child: Text('${m.label}  ${m.value.toStringAsFixed(0)}',
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _permView() {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: GlowBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(T.lg),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.no_photography_outlined, color: T.textTertiary, size: 48),
                const SizedBox(height: T.md),
                Text('Camera access needed', style: t.displaySmall),
                const SizedBox(height: T.sm),
                Text('AR measurements need the camera to see the person.', style: t.bodyMedium),
                const SizedBox(height: T.lg),
                GradientButton('Open settings', onPressed: () => openAppSettings()),
                const SizedBox(height: T.sm),
                SoftButton('Go back', ghost: true, onPressed: () => context.pop()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Draws the skeleton (faint) and the selected measurement's highlight, mapped
/// from ML Kit image coordinates into the preview's canvas coordinates.
class _ArPainter extends CustomPainter {
  final Pose? pose;
  final Size imageSize;
  final InputImageRotation rotation;
  final CameraLensDirection lens;
  final MeasurementRegion? selected;

  _ArPainter({
    required this.pose,
    required this.imageSize,
    required this.rotation,
    required this.lens,
    required this.selected,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final p = pose;
    if (p == null || imageSize == Size.zero) return;

    Offset? at(PoseLandmarkType type) {
      final lm = p.landmarks[type];
      if (lm == null || lm.likelihood < 0.4) return null;
      return Offset(
        _tx(lm.x, size, imageSize, rotation, lens),
        _ty(lm.y, size, imageSize, rotation, lens),
      );
    }

    // Faint skeleton for feedback.
    final bone = Paint()
      ..color = Colors.white.withValues(alpha: 0.35)
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    void line(PoseLandmarkType a, PoseLandmarkType b) {
      final pa = at(a), pb = at(b);
      if (pa != null && pb != null) canvas.drawLine(pa, pb, bone);
    }
    line(PoseLandmarkType.leftShoulder, PoseLandmarkType.rightShoulder);
    line(PoseLandmarkType.leftShoulder, PoseLandmarkType.leftHip);
    line(PoseLandmarkType.rightShoulder, PoseLandmarkType.rightHip);
    line(PoseLandmarkType.leftHip, PoseLandmarkType.rightHip);
    line(PoseLandmarkType.leftShoulder, PoseLandmarkType.leftElbow);
    line(PoseLandmarkType.leftElbow, PoseLandmarkType.leftWrist);
    line(PoseLandmarkType.rightShoulder, PoseLandmarkType.rightElbow);
    line(PoseLandmarkType.rightElbow, PoseLandmarkType.rightWrist);
    line(PoseLandmarkType.leftHip, PoseLandmarkType.leftKnee);
    line(PoseLandmarkType.leftKnee, PoseLandmarkType.leftAnkle);
    line(PoseLandmarkType.rightHip, PoseLandmarkType.rightKnee);
    line(PoseLandmarkType.rightKnee, PoseLandmarkType.rightAnkle);

    final s = selected;
    if (s == null) return;
    _drawMeasurement(canvas, s, at);
  }

  Offset? _mid(Offset? a, Offset? b) =>
      (a != null && b != null) ? Offset((a.dx + b.dx) / 2, (a.dy + b.dy) / 2) : null;
  Offset? _lerp(Offset? a, Offset? b, double t) =>
      (a != null && b != null) ? Offset.lerp(a, b, t) : null;

  void _drawMeasurement(Canvas c, MeasurementRegion s, Offset? Function(PoseLandmarkType) at) {
    final hi = Paint()
      ..color = T.brand
      ..strokeWidth = 6
      ..strokeCap = StrokeCap.round;
    final glow = Paint()
      ..color = T.brand.withValues(alpha: 0.4)
      ..strokeWidth = 14
      ..strokeCap = StrokeCap.round
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6);

    final lSh = at(PoseLandmarkType.leftShoulder), rSh = at(PoseLandmarkType.rightShoulder);
    final lHip = at(PoseLandmarkType.leftHip), rHip = at(PoseLandmarkType.rightHip);
    final shMid = _mid(lSh, rSh), hipMid = _mid(lHip, rHip);

    void band(Offset? left, Offset? right, double extend) {
      if (left == null || right == null) return;
      final dir = (right - left);
      final a = left - dir * extend;
      final b = right + dir * extend;
      c.drawLine(a, b, glow);
      c.drawLine(a, b, hi);
    }

    switch (s.key) {
      case 'shoulder_breadth':
        band(lSh, rSh, 0.05);
        break;
      case 'chest':
        band(_lerp(lSh, lHip, 0.28), _lerp(rSh, rHip, 0.28), 0.15);
        break;
      case 'waist':
        band(_lerp(lSh, lHip, 0.60), _lerp(rSh, rHip, 0.60), 0.05);
        break;
      case 'hip':
        band(lHip, rHip, 0.12);
        break;
      case 'thigh':
        _limbBand(c, hi, glow, at(PoseLandmarkType.leftHip), at(PoseLandmarkType.leftKnee), 0.3);
        _limbBand(c, hi, glow, at(PoseLandmarkType.rightHip), at(PoseLandmarkType.rightKnee), 0.3);
        break;
      case 'calf':
        _limbBand(c, hi, glow, at(PoseLandmarkType.leftKnee), at(PoseLandmarkType.leftAnkle), 0.45);
        _limbBand(c, hi, glow, at(PoseLandmarkType.rightKnee), at(PoseLandmarkType.rightAnkle), 0.45);
        break;
      case 'ankle':
        _dot(c, hi, glow, at(PoseLandmarkType.leftAnkle));
        _dot(c, hi, glow, at(PoseLandmarkType.rightAnkle));
        break;
      case 'bicep':
        _limbBand(c, hi, glow, at(PoseLandmarkType.leftShoulder), at(PoseLandmarkType.leftElbow), 0.5);
        _limbBand(c, hi, glow, at(PoseLandmarkType.rightShoulder), at(PoseLandmarkType.rightElbow), 0.5);
        break;
      case 'forearm':
        _limbBand(c, hi, glow, at(PoseLandmarkType.leftElbow), at(PoseLandmarkType.leftWrist), 0.5);
        _limbBand(c, hi, glow, at(PoseLandmarkType.rightElbow), at(PoseLandmarkType.rightWrist), 0.5);
        break;
      case 'wrist':
        _dot(c, hi, glow, at(PoseLandmarkType.leftWrist));
        _dot(c, hi, glow, at(PoseLandmarkType.rightWrist));
        break;
      case 'arm_length':
        _seg(c, hi, glow, at(PoseLandmarkType.leftShoulder), at(PoseLandmarkType.leftElbow));
        _seg(c, hi, glow, at(PoseLandmarkType.leftElbow), at(PoseLandmarkType.leftWrist));
        break;
      case 'leg_length':
        _seg(c, hi, glow, at(PoseLandmarkType.leftHip), at(PoseLandmarkType.leftKnee));
        _seg(c, hi, glow, at(PoseLandmarkType.leftKnee), at(PoseLandmarkType.leftAnkle));
        break;
      case 'shoulder_to_crotch':
        _seg(c, hi, glow, shMid, hipMid);
        break;
      case 'height':
        final nose = at(PoseLandmarkType.nose);
        final ankle = _mid(at(PoseLandmarkType.leftAnkle), at(PoseLandmarkType.rightAnkle));
        _seg(c, hi, glow, nose, ankle);
        break;
    }
  }

  // A short band perpendicular to a limb axis at fraction t along it.
  void _limbBand(Canvas c, Paint hi, Paint glow, Offset? a, Offset? b, double t) {
    if (a == null || b == null) return;
    final p = Offset.lerp(a, b, t)!;
    final axis = (b - a);
    final len = axis.distance;
    if (len < 1) return;
    final perp = Offset(-axis.dy, axis.dx) / len * (len * 0.22);
    c.drawLine(p - perp, p + perp, glow);
    c.drawLine(p - perp, p + perp, hi);
  }

  void _seg(Canvas c, Paint hi, Paint glow, Offset? a, Offset? b) {
    if (a == null || b == null) return;
    c.drawLine(a, b, glow);
    c.drawLine(a, b, hi);
  }

  void _dot(Canvas c, Paint hi, Paint glow, Offset? p) {
    if (p == null) return;
    c.drawCircle(p, 12, glow);
    c.drawCircle(p, 7, hi);
  }

  @override
  bool shouldRepaint(_ArPainter old) =>
      old.pose != pose || old.selected?.key != selected?.key;
}

// Canonical ML Kit → canvas coordinate translation (google_mlkit example).
double _tx(double x, Size canvas, Size image, InputImageRotation rot, CameraLensDirection lens) {
  switch (rot) {
    case InputImageRotation.rotation90deg:
      return x * canvas.width / (Platform.isIOS ? image.width : image.height);
    case InputImageRotation.rotation270deg:
      return canvas.width - x * canvas.width / (Platform.isIOS ? image.width : image.height);
    case InputImageRotation.rotation0deg:
    case InputImageRotation.rotation180deg:
      final sx = canvas.width / image.width;
      return lens == CameraLensDirection.back ? x * sx : canvas.width - x * sx;
  }
}

double _ty(double y, Size canvas, Size image, InputImageRotation rot, CameraLensDirection lens) {
  switch (rot) {
    case InputImageRotation.rotation90deg:
    case InputImageRotation.rotation270deg:
      return y * canvas.height / (Platform.isIOS ? image.height : image.width);
    case InputImageRotation.rotation0deg:
    case InputImageRotation.rotation180deg:
      return y * canvas.height / image.height;
  }
}
