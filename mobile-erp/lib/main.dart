// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'app_services.dart';
import 'background/audit_worker.dart';
import 'ui/erp_theme.dart';
import 'ui/shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initAuditWorker();
  runApp(const AuditApplication());
}

class AuditApplication extends StatefulWidget {
  const AuditApplication({super.key});
  @override
  State<AuditApplication> createState() => _AuditApplicationState();
}

class _AuditApplicationState extends State<AuditApplication>
    with WidgetsBindingObserver {
  late final Future<AppHost> _host = AppHost.open();
  bool? _dark;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// «حسب الجهاز» follows the phone when it switches light/dark.
  @override
  void didChangePlatformBrightness() => setState(() {});

  /// Applies the palette of Settings ← المظهر. Every screen reads its
  /// colours from [Tw], so after a change every element is rebuilt once
  /// (without losing the open screens or their state).
  void _applyAppearance(String appearance) {
    final platformDark =
        WidgetsBinding.instance.platformDispatcher.platformBrightness ==
        Brightness.dark;
    final dark =
        appearance == 'dark' || (appearance == 'system' && platformDark);
    if (dark == _dark) return;
    final first = _dark == null;
    _dark = dark;
    Tw.palette = dark ? TwPalette.dark : TwPalette.light;
    SystemChrome.setSystemUIOverlayStyle(
      (dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark).copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Tw.surface,
      ),
    );
    if (first) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      void rebuild(Element e) {
        e.markNeedsBuild();
        e.visitChildren(rebuild);
      }

      if (mounted) (context as Element).visitChildren(rebuild);
    });
  }

  MaterialApp _app(Widget home) => MaterialApp(
    title: 'LorkERP',
    debugShowCheckedModeBanner: false,
    locale: const Locale('ar'),
    supportedLocales: const [Locale('ar')],
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    theme: buildErpTheme(),
    home: home,
  );

  @override
  Widget build(BuildContext context) => FutureBuilder<AppHost>(
    future: _host,
    builder: (context, snap) {
      if (snap.hasError) {
        return _app(
          const Scaffold(
            body: Center(child: Text('تعذر فتح البيانات المحفوظة على الجهاز.')),
          ),
        );
      }
      final host = snap.data;
      if (host == null) {
        return _app(
          const Scaffold(body: Center(child: CircularProgressIndicator())),
        );
      }
      return ListenableBuilder(
        listenable: host,
        builder: (context, _) {
          _applyAppearance(host.appearance);
          final services = host.active;
          // AppScope sits above the Navigator so dialogs and bottom sheets
          // (new routes) can reach the database and the Google connection
          // too. Switching workspace rebuilds the app on the other database.
          return AppScope(
            services: services,
            child: KeyedSubtree(
              key: ValueKey('${services.workspace.id}:${host.epoch}'),
              child: _app(AppShell(initialTab: host.initialTab)),
            ),
          );
        },
      );
    },
  );
}
