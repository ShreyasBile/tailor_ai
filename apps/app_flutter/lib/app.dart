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
        if (!session.hydrated) return state.matchedLocation == '/' ? null : '/';
        final loc = state.matchedLocation;
        final authArea = loc == '/sign-in' || loc == '/consent' || loc == '/';

        if (!session.isAuthed) return authArea && loc != '/consent' ? null : '/sign-in';

        // Consent is a hard gate — the API refuses jobs without it.
        if (session.needsConsent) return loc == '/consent' ? null : '/consent';

        // Signed in and consented: bounce out of the auth area.
        if (loc == '/sign-in' || loc == '/consent' || loc == '/') return '/home';
        return null;
      },
      routes: [
        GoRoute(path: '/', builder: (_, __) => const SplashScreen()),
        GoRoute(path: '/sign-in', builder: (_, __) => const SignInScreen()),
        GoRoute(path: '/consent', builder: (_, __) => const ConsentScreen()),
        GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
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
