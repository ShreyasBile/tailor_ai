import 'dart:async';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';
import 'package:sensors_plus/sensors_plus.dart';
import '../../state/capture_state.dart';
import '../../theme/tokens.dart';
import '../widgets/widgets.dart';

const _videoSeconds = 25;
const _photoAngles = ['Front', 'Right side', 'Back', 'Left side'];
const _uprightToleranceDeg = 12.0;

class CaptureCameraScreen extends StatefulWidget {
  final String mode;
  const CaptureCameraScreen({super.key, required this.mode});
  @override
  State<CaptureCameraScreen> createState() => _CaptureCameraScreenState();
}

class _CaptureCameraScreenState extends State<CaptureCameraScreen>
    with WidgetsBindingObserver {
  bool get _isVideo => widget.mode == 'VIDEO_360';

  List<CameraDescription> _cameras = [];
  CameraController? _controller;
  bool _permDenied = false;
  bool _initializing = true;

  bool _front = false;
  bool _recording = false;
  double _elapsed = 0;
  int _angleIndex = 0;
  int? _countdown;
  Timer? _timer;

  double _tiltDeg = 0;
  bool get _upright => _tiltDeg <= _uprightToleranceDeg;
  StreamSubscription? _accel;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    context.read<CaptureState>().reset();
    _setup();
    _accel = accelerometerEventStream().listen((e) {
      // Angle of the phone's up-axis from vertical.
      final mag = (e.x * e.x + e.y * e.y + e.z * e.z);
      final norm = mag == 0 ? 1 : (mag).clamp(1e-6, double.infinity);
      final cosTheta = (e.y / (norm == 1 ? 1 : (norm)).toDouble());
      // Simpler robust estimate: tilt from vertical using y component.
      final g = 9.81;
      final ratio = (e.y / g).clamp(-1.0, 1.0);
      final deg = (57.2958 * (1.0 - ratio) * 0.5 * 3.14159).abs();
      // Use a stable approximation: 0 when phone upright (y≈+g).
      final tilt = (57.2958 * (1 - (e.y.abs() / g)).clamp(0.0, 1.0) * 1.5)
          .clamp(0.0, 90.0);
      if (mounted) setState(() => _tiltDeg = tilt.toDouble());
      // ignore unused
      cosTheta;
      deg;
    });
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
    try {
      _cameras = await availableCameras();
      await _openCamera();
    } catch (_) {
      setState(() => _initializing = false);
    }
  }

  Future<void> _openCamera() async {
    final desc = _cameras.firstWhere(
      (c) =>
          c.lensDirection ==
          (_front ? CameraLensDirection.front : CameraLensDirection.back),
      orElse: () => _cameras.first,
    );
    final controller = CameraController(
      desc,
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );
    await controller.initialize();
    if (!mounted) return;
    setState(() {
      _controller = controller;
      _initializing = false;
    });
  }

  Future<void> _flip() async {
    if (_recording || _cameras.length < 2) return;
    HapticFeedback.selectionClick();
    final old = _controller;
    setState(() {
      _controller = null;
      _front = !_front;
    });
    await old?.dispose();
    await _openCamera();
  }

  // ── Video ──
  Future<void> _startRecording() async {
    final c = _controller;
    if (c == null) return;
    await c.startVideoRecording();
    setState(() {
      _recording = true;
      _elapsed = 0;
    });
    _timer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      final next = _elapsed + 0.1;
      final quarter = _videoSeconds / 4;
      if (next ~/ quarter != _elapsed ~/ quarter) {
        HapticFeedback.mediumImpact();
      }
      if (next >= _videoSeconds) {
        _stopRecording();
      } else {
        setState(() => _elapsed = next);
      }
    });
  }

  Future<void> _stopRecording() async {
    _timer?.cancel();
    final c = _controller;
    if (c == null || !_recording) return;
    setState(() => _recording = false);
    try {
      final file = await c.stopVideoRecording();
      if (!mounted) return;
      // Android CameraX saves the front video un-mirrored, so no server flip
      // is needed; the flag is plumbed for platforms that differ.
      context.read<CaptureState>().setVideo(file.path, false);
      context.pushReplacement('/capture/review?mode=VIDEO_360');
    } catch (_) {}
  }

  // ── Photos ──
  void _armCountdown() {
    setState(() => _countdown = 3);
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_countdown == null) return;
      if (_countdown! <= 1) {
        _timer?.cancel();
        _capturePhoto();
      } else {
        HapticFeedback.lightImpact();
        setState(() => _countdown = _countdown! - 1);
      }
    });
  }

  Future<void> _capturePhoto() async {
    final c = _controller;
    if (c == null) return;
    try {
      final file = await c.takePicture();
      HapticFeedback.heavyImpact();
      if (!mounted) return;
      context.read<CaptureState>().addPhoto(file.path);
      final next = _angleIndex + 1;
      if (next >= _photoAngles.length) {
        context.pushReplacement('/capture/review?mode=PHOTO_SET');
      } else {
        setState(() {
          _angleIndex = next;
          _countdown = null;
        });
      }
    } catch (_) {
      setState(() => _countdown = null);
    }
  }

  String get _instruction {
    if (!_upright) return 'Straighten your phone';
    if (_isVideo) {
      return _recording
          ? 'Turn slowly, all the way around'
          : 'Step back until you fill the outline';
    }
    return 'Face ${_photoAngles[_angleIndex].toLowerCase()}';
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return;
    if (state == AppLifecycleState.inactive) {
      c.dispose();
    } else if (state == AppLifecycleState.resumed) {
      _openCamera();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _accel?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_permDenied) return _permissionView();
    if (_initializing || _controller == null) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(
            child: CircularProgressIndicator(color: T.brand, strokeWidth: 2.4)),
      );
    }

    final progress = _isVideo
        ? _elapsed / _videoSeconds
        : _angleIndex / _photoAngles.length;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          // Camera preview, cover-cropped to fill.
          FittedBox(
            fit: BoxFit.cover,
            child: SizedBox(
              width: _controller!.value.previewSize?.height ?? 1080,
              height: _controller!.value.previewSize?.width ?? 1920,
              child: CameraPreview(_controller!),
            ),
          ),

          // Silhouette guide.
          IgnorePointer(
            child: CustomPaint(
              painter: _SilhouettePainter(
                  tint: _upright ? T.success : T.warning),
              child: const SizedBox.expand(),
            ),
          ),

          SafeArea(
            child: Column(
              children: [
                _topBar(progress),
                if (_front)
                  Padding(
                    padding: const EdgeInsets.only(top: T.sm),
                    child: Glass(
                      radius: T.rPill,
                      padding: const EdgeInsets.symmetric(
                          horizontal: T.md, vertical: 6),
                      child: Text('Front camera — easier to frame',
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(color: Colors.white70)),
                    ),
                  ),
                const Spacer(),
                _bottomControls(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _topBar(double progress) {
    return Padding(
      padding: const EdgeInsets.all(T.md),
      child: Row(
        children: [
          _circleButton(Icons.close, () => context.pop()),
          const SizedBox(width: T.md),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(T.rPill),
              child: LinearProgressIndicator(
                value: progress.clamp(0, 1),
                minHeight: 5,
                backgroundColor: Colors.white24,
                valueColor: const AlwaysStoppedAnimation(T.brand),
              ),
            ),
          ),
          const SizedBox(width: T.md),
          _circleButton(
            Icons.cameraswitch_rounded,
            _recording ? null : _flip,
          ),
        ],
      ),
    );
  }

  Widget _bottomControls() {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(T.lg),
      child: Column(
        children: [
          Glass(
            child: Column(
              children: [
                Text(_instruction,
                    textAlign: TextAlign.center,
                    style: t.titleLarge?.copyWith(color: Colors.white)),
                if (!_upright)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('${_tiltDeg.round()}° off vertical',
                        style: t.bodySmall?.copyWith(color: T.warning)),
                  ),
              ],
            ),
          ),
          const SizedBox(height: T.lg),
          if (_isVideo)
            _recording
                ? Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text('${(_videoSeconds - _elapsed).clamp(0, 99).toStringAsFixed(0)}s',
                          style: t.displaySmall
                              ?.copyWith(color: Colors.white)),
                      const SizedBox(width: T.lg),
                      _shutter(recording: true, onTap: _stopRecording),
                    ],
                  )
                : _shutter(recording: false, onTap: _startRecording)
          else if (_countdown != null)
            Text('$_countdown',
                style: t.displayLarge?.copyWith(color: Colors.white, fontSize: 72))
          else
            Column(
              children: [
                _shutter(recording: false, onTap: _armCountdown),
                const SizedBox(height: T.sm),
                Text('${context.watch<CaptureState>().photos.length} of ${_photoAngles.length} captured',
                    style: t.bodySmall?.copyWith(color: Colors.white70)),
              ],
            ),
        ],
      ),
    );
  }

  Widget _shutter({required bool recording, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 78,
        height: 78,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 4),
        ),
        child: Center(
          child: AnimatedContainer(
            duration: T.fast,
            width: recording ? 30 : 62,
            height: recording ? 30 : 62,
            decoration: BoxDecoration(
              color: recording ? T.danger : Colors.white,
              borderRadius:
                  BorderRadius.circular(recording ? 8 : T.rPill),
            ),
          ),
        ),
      ),
    );
  }

  Widget _circleButton(IconData icon, VoidCallback? onTap) {
    return Opacity(
      opacity: onTap == null ? 0.4 : 1,
      child: Glass(
        radius: T.rPill,
        padding: EdgeInsets.zero,
        child: IconButton(
          onPressed: onTap,
          icon: Icon(icon, color: Colors.white, size: 22),
        ),
      ),
    );
  }

  Widget _permissionView() {
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
                const Icon(Icons.no_photography_outlined,
                    color: T.textTertiary, size: 48),
                const SizedBox(height: T.md),
                Text('Camera access needed', style: t.displaySmall),
                const SizedBox(height: T.sm),
                Text(
                  'TailorAI uses your camera to capture the photos used to build your body model.',
                  style: t.bodyMedium,
                ),
                const SizedBox(height: T.lg),
                GradientButton('Open settings',
                    onPressed: () => openAppSettings()),
                const SizedBox(height: T.sm),
                SoftButton('Go back',
                    ghost: true, onPressed: () => context.pop()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A-pose silhouette guide. Framing at capture time is the cheapest accuracy
/// lever there is: if the subject fills the guide they are the right distance,
/// fully in frame, and roughly in the expected pose.
class _SilhouettePainter extends CustomPainter {
  final Color tint;
  _SilhouettePainter({required this.tint});

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final guideH = h * 0.8;
    final top = (h - guideH) / 2;
    final cx = w / 2;

    // Dim outside the framing band.
    final dim = Paint()..color = Colors.black.withValues(alpha: 0.45);
    canvas.drawRect(Rect.fromLTWH(0, 0, w, top), dim);
    canvas.drawRect(Rect.fromLTWH(0, top + guideH, w, h - top - guideH), dim);

    final stroke = Paint()
      ..color = tint
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round;

    final headR = guideH * 0.062;
    final headCy = top + headR * 1.3;
    final shoulderY = top + guideH * 0.2;
    final hipY = top + guideH * 0.52;
    final footY = top + guideH;
    final halfShoulder = guideH * 0.42 * 0.42;
    final halfHip = guideH * 0.42 * 0.34;

    _dashedCircle(canvas, Offset(cx, headCy), headR, stroke);

    final torso = Path()
      ..moveTo(cx - halfShoulder, shoulderY)
      ..cubicTo(cx - halfShoulder, shoulderY + guideH * 0.14,
          cx - halfHip, hipY - guideH * 0.06, cx - halfHip, hipY)
      ..lineTo(cx + halfHip, hipY)
      ..cubicTo(cx + halfShoulder, shoulderY + guideH * 0.14,
          cx + halfShoulder, shoulderY + guideH * 0.05, cx + halfShoulder,
          shoulderY)
      ..close();
    _dashedPath(canvas, torso, stroke);

    // A-pose limbs.
    final arms = guideH * 0.42;
    _dashedPath(
        canvas,
        Path()
          ..moveTo(cx - halfShoulder, shoulderY + guideH * 0.01)
          ..lineTo(cx - arms * 0.86, hipY + guideH * 0.02),
        stroke);
    _dashedPath(
        canvas,
        Path()
          ..moveTo(cx + halfShoulder, shoulderY + guideH * 0.01)
          ..lineTo(cx + arms * 0.86, hipY + guideH * 0.02),
        stroke);
    _dashedPath(
        canvas,
        Path()
          ..moveTo(cx - halfHip * 0.6, hipY)
          ..lineTo(cx - halfHip * 0.82, footY),
        stroke);
    _dashedPath(
        canvas,
        Path()
          ..moveTo(cx + halfHip * 0.6, hipY)
          ..lineTo(cx + halfHip * 0.82, footY),
        stroke);
  }

  void _dashedPath(Canvas canvas, Path path, Paint paint) {
    for (final metric in path.computeMetrics()) {
      double dist = 0;
      while (dist < metric.length) {
        final len = (dist + 7).clamp(0, metric.length).toDouble();
        canvas.drawPath(metric.extractPath(dist, len), paint);
        dist += 13;
      }
    }
  }

  void _dashedCircle(Canvas canvas, Offset c, double r, Paint paint) {
    final path = Path()
      ..addOval(Rect.fromCircle(center: c, radius: r));
    _dashedPath(canvas, path, paint);
  }

  @override
  bool shouldRepaint(_SilhouettePainter old) => old.tint != tint;
}
