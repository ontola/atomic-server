import 'package:flutter/material.dart';

/// Dark by default, on purpose: the home screen is a live camera preview, and
/// a light chrome around it flares in a dim kitchen and washes out the frame
/// the user is trying to aim. Light mode still exists for the list screens.
ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: const Color(0xFF3DDC84),
    brightness: brightness,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor:
        brightness == Brightness.dark ? const Color(0xFF101210) : scheme.surface,
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        shape:
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
    ),
  );
}
