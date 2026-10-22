import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'state/session.dart';
import 'theme/theme.dart';
import 'ui/screens/splash.dart';
import 'ui/screens/sign_in.dart';
import 'ui/screens/consent.dart';
import 'ui/screens/home.dart';
import 'ui/screens/capture_intro.dart';
import 'ui/screens/capture_guide.dart';
import 'ui/screens/capture_camera.dart';
import 'ui/screens/capture_review.dart';
import 'ui/screens/processing.dart';
import 'ui/screens/viewer.dart';
import 'ui/screens/profile.dart';
import 'ui/screens/measurements.dart';
import 'ui/screens/ar_measure.dart';

class TailorApp extends StatelessWidget {
  const TailorApp({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.read<Session>();
    final router = _router(session);
    return MaterialApp.router(
      title: 'TailorAI',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.build(),
      routerConfig: router,
    );
  }

  GoRouter _router(Session session) {
    return GoRouter(
      initialLocation: '/',
      // Rebuild redirects whenever session state changes (sign-in, consent).
      refreshListenable: session,
      redirect: (context, state) {
        final loc = state.matchedLocation;

        // Still hydrating → hold on the splash ('/').
        if (!session.hydrated) return loc == '/' ? null : '/';

        // Not signed in → sign-in (the splash '/' must leave here too).
        if (!session.isAuthed) return loc == '/sign-in' ? null : '/sign-in';

        // Consent is a hard gate — the API refuses jobs without it.
        if (session.needsConsent) return loc == '/consent' ? null : '/consent';

        // Signed in and consented: bounce out of splash / auth screens.
        if (loc == '/' || loc == '/sign-in' || loc == '/consent') return '/home';
        return null;
      },
      routes: [
        GoRoute(path: '/', builder: (_, __) => const SplashScreen()),
        GoRoute(path: '/sign-in', builder: (_, __) => const SignInScreen()),
        GoRoute(path: '/consent', builder: (_, __) => const ConsentScreen()),
        GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
        GoRoute(path: '/measurements', builder: (_, __) => const MeasurementsScreen()),
        GoRoute(path: '/measurements/ar', builder: (_, __) => const ArMeasureScreen()),
        GoRoute(
            path: '/capture', builder: (_, __) => const CaptureIntroScreen()),
        GoRoute(
            path: '/capture/guide',
            builder: (_, s) => CaptureGuideScreen(
                mode: s.uri.queryParameters['mode'] ?? 'VIDEO_360')),
        GoRoute(
            path: '/capture/camera',
            builder: (_, s) => CaptureCameraScreen(
                mode: s.uri.queryParameters['mode'] ?? 'VIDEO_360')),
        GoRoute(
            path: '/capture/review',
            builder: (_, s) => CaptureReviewScreen(
                mode: s.uri.queryParameters['mode'] ?? 'VIDEO_360')),
        GoRoute(
            path: '/processing/:id',
            builder: (_, s) => ProcessingScreen(jobId: s.pathParameters['id']!)),
        GoRoute(
            path: '/viewer/:id',
            builder: (_, s) => ViewerScreen(renderId: s.pathParameters['id']!)),
      ],
    );
  }
}
