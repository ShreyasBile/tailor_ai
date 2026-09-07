import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'tokens.dart';

/// App theme.
///
/// Display type is Sora (geometric, modern) for headings and the brand; body is
/// Inter. Both ship through google_fonts, which is already cached, so no runtime
/// font fetch is needed.
class AppTheme {
  static ThemeData build() {
    final base = ThemeData.dark(useMaterial3: true);
    final textTheme = _textTheme(base.textTheme);

    return base.copyWith(
      scaffoldBackgroundColor: T.bg,
      canvasColor: T.bg,
      colorScheme: const ColorScheme.dark(
        surface: T.surface,
        primary: T.brand,
        secondary: T.cyan,
        error: T.danger,
        onPrimary: Colors.white,
        onSurface: T.text,
      ),
      textTheme: textTheme,
      splashFactory: InkSparkle.splashFactory,
      dividerColor: T.border,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        systemOverlayStyle: SystemUiOverlayStyle.light,
        titleTextStyle: textTheme.titleLarge,
        iconTheme: const IconThemeData(color: T.text),
      ),
    );
  }

  static TextTheme _textTheme(TextTheme b) {
    TextStyle sora(TextStyle? s) => GoogleFonts.sora(textStyle: s);
    TextStyle inter(TextStyle? s) => GoogleFonts.inter(textStyle: s);
    return TextTheme(
      displayLarge: sora(b.displayLarge).copyWith(
          fontWeight: FontWeight.w700, letterSpacing: -1.2, color: T.text, height: 1.05),
      displaySmall: sora(b.displaySmall)
          .copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.8, color: T.text),
      headlineMedium: sora(b.headlineMedium)
          .copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.5, color: T.text),
      titleLarge: sora(b.titleLarge)
          .copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.3, color: T.text),
      titleMedium: inter(b.titleMedium)
          .copyWith(fontWeight: FontWeight.w600, color: T.text),
      bodyLarge: inter(b.bodyLarge).copyWith(color: T.text, height: 1.45),
      bodyMedium: inter(b.bodyMedium).copyWith(color: T.textSecondary, height: 1.45),
      labelLarge: inter(b.labelLarge)
          .copyWith(fontWeight: FontWeight.w600, color: T.text, letterSpacing: 0.2),
      bodySmall: inter(b.bodySmall).copyWith(color: T.textTertiary),
    );
  }
}
