import 'package:flutter/material.dart';

/// Design tokens — the single source of the brand.
///
/// Dark-first and near-black, so the 3D avatar and the brand gradient are the
/// brightest things on screen. One signature gradient, used sparingly, is what
/// makes the product read as a considered startup rather than a template.
class T {
  T._();

  // ── Canvas & surfaces (ascending elevation) ──
  static const bg = Color(0xFF08080C);
  static const bgElevated = Color(0xFF0E0E15);
  static const surface = Color(0xFF14141D);
  static const surfaceRaised = Color(0xFF1C1C28);
  static const surfaceOverlay = Color(0xF01A1A24);

  static const border = Color(0xFF262633);
  static const borderStrong = Color(0xFF34344A);

  // ── Text ──
  static const text = Color(0xFFF4F4F8);
  static const textSecondary = Color(0xFF9A9AAC);
  static const textTertiary = Color(0xFF5C5C6E);

  // ── Brand ──
  // A confident indigo→violet, with a cyan spark for highlights and data.
  static const brand = Color(0xFF7C6CF6);
  static const brandBright = Color(0xFF9B7CFF);
  static const violet = Color(0xFFB162FF);
  static const cyan = Color(0xFF34E3E3);

  static const success = Color(0xFF3DD68C);
  static const warning = Color(0xFFFBBF24);
  static const danger = Color(0xFFFB6B6B);

  static const brandGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [brand, violet],
  );

  static const brandGradientVivid = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF6D5EF6), Color(0xFFB162FF), Color(0xFF34E3E3)],
    stops: [0.0, 0.6, 1.0],
  );

  // A soft glow behind hero elements.
  static RadialGradient heroGlow(Color c) => RadialGradient(
        colors: [c.withValues(alpha: 0.22), c.withValues(alpha: 0.0)],
        radius: 0.9,
      );

  // ── Spacing ──
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 32.0;
  static const xxl = 48.0;

  // ── Radii ──
  static const rSm = 10.0;
  static const rMd = 16.0;
  static const rLg = 24.0;
  static const rPill = 999.0;

  // ── Motion ──
  static const fast = Duration(milliseconds: 180);
  static const med = Duration(milliseconds: 320);
  static const slow = Duration(milliseconds: 620);
  static const curve = Curves.easeOutCubic;
}
