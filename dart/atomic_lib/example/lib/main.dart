import 'package:atomic_lib/atomic_lib.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Atomic.init();
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'atomic_lib example',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1976D2)),
        useMaterial3: true,
      ),
      home: LoginScreen(
        appName: 'atomic_lib',
        appIcon: Icons.hub_outlined,
        continueLabel: 'Continue',
        onLoggedIn: () {},
      ),
    );
  }
}
