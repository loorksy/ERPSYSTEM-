// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../app_services.dart';
import 'books/home_page.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'payroll_page.dart';
import 'settings_page.dart';
import 'sheet_page.dart';
import 'ui_kit.dart';
import 'workspaces_card.dart';

/// Bottom navigation tabs of LorkERP: the books first, the payroll cycles
/// (the audit of «المدقق») in the middle, and the audit tools, backup and
/// settings under «المزيد».
abstract final class AppTabs {
  static const home = 0;
  static const operations = 1;
  static const sheet = 2;
  static const reports = 3;
  static const more = 4;

  /// Not a tab: «المزيد» with the settings screen open on top.
  static const settings = 40;
}

/// What the screens can ask of the frame: switch tab, open a period's
/// audit, create a period.
class ShellScope extends InheritedWidget {
  const ShellScope({
    super.key,
    required this.goTo,
    required this.openAudit,
    required this.currentTab,
    required super.child,
  });
  final ValueChanged<int> goTo;
  final ValueChanged<int> openAudit;
  final int Function() currentTab;

  static ShellScope? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<ShellScope>();

  @override
  bool updateShouldNotify(ShellScope old) => false;
}

/// The frame of «المدقق» (owner's mockup): each tab keeps its own stack of
/// screens above the bottom navigation, so a period's audit and the field
/// mapping page open with the navigation still visible.
class AppShell extends StatefulWidget {
  const AppShell({super.key, this.initialTab = 0});
  final int initialTab;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  late int _index =
      widget.initialTab == AppTabs.settings ? AppTabs.more : widget.initialTab;
  final _periods = GlobalKey<SheetPageState>();
  final _navs = List.generate(5, (_) => GlobalKey<NavigatorState>());
  late final _observers = List.generate(5, (_) => _StackObserver(_onStack));
  final _depth = List.filled(5, 0);
  bool _hasPeriods = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final services = AppScope.read(context);
      services.resumeAuditJobs();
      services.resumeBackgroundSync();
      services.backup.autoBackupIfDue(services.workspace.name);
      if (widget.initialTab == AppTabs.settings) _openSettings();
    });
  }

  @override
  void dispose() {
    _current.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final services = AppScope.read(context);
    if (state == AppLifecycleState.resumed) {
      services.resumeAuditJobs();
      services.resumeBackgroundSync();
    } else if (state == AppLifecycleState.paused) {
      services.syncWorker.stop();
    }
  }

  void _onStack() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    var changed = false;
    for (var i = 0; i < 5; i++) {
      final d = _observers[i].depth;
      if (_depth[i] != d) {
        _depth[i] = d;
        changed = true;
      }
    }
    if (changed) setState(() {});
  });

  /// «المزيد» ← الإعدادات (from the workspace sheet, the audit screen…).
  void _openSettings() {
    if (_index != AppTabs.more) {
      setState(() => _index = AppTabs.more);
      _current.value = AppTabs.more;
    }
    final nav = _navs[AppTabs.more].currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    nav.push(MaterialPageRoute<void>(builder: (_) => const SettingsPage()));
  }

  void goTo(int index) {
    if (index == AppTabs.settings) {
      _openSettings();
      return;
    }
    if (index == _index) {
      // The current tab again: back to its first screen.
      if (_depth[index] > 1) _navs[index].currentState?.maybePop();
      return;
    }
    setState(() => _index = index);
    _current.value = index;
  }

  /// A period's audit screen, inside the periods tab.
  Future<void> _openAudit(int cycleId) async {
    if (_index != AppTabs.sheet) {
      setState(() => _index = AppTabs.sheet);
      _current.value = AppTabs.sheet;
    }
    final nav = _navs[AppTabs.sheet].currentState;
    if (nav == null) return;
    nav.popUntil((r) => r.isFirst);
    await nav.push(
      MaterialPageRoute<void>(
        builder:
            (_) => PayrollPage(
              cycleId: cycleId,
              onOpenSettings: () => goTo(AppTabs.settings),
            ),
      ),
    );
    await _periods.currentState?.refresh();
  }

  /// The tab shown, for the first page of each tab: the route of that
  /// page is built once, so it follows the tab through this notifier.
  late final _current = ValueNotifier<int>(_index);

  /// A tab: its own navigator whose first page is [page] (told whether
  /// its tab is the one shown).
  Widget _tab(int i, Widget Function(bool active) page) => Navigator(
    key: _navs[i],
    observers: [_observers[i]],
    onGenerateRoute:
        (_) => MaterialPageRoute<void>(
          builder:
              (_) => ColoredBox(
                color: Tw.paper,
                child: ValueListenableBuilder<int>(
                  valueListenable: _current,
                  builder: (_, current, _) => page(current == i),
                ),
              ),
        ),
  );

  static const _labels = [
    'الرئيسية',
    'العمليات',
    'الدورات',
    'التقارير',
    'المزيد',
  ];
  static const _icons = [
    (Icons.space_dashboard_outlined, Icons.space_dashboard),
    (Icons.swap_vert_circle_outlined, Icons.swap_vert_circle),
    (Icons.calendar_today_outlined, Icons.calendar_today),
    (Icons.bar_chart_outlined, Icons.bar_chart),
    (Icons.more_horiz, Icons.more_horiz),
  ];

  @override
  Widget build(BuildContext context) {
    final inStack = _depth[_index] > 1;
    final fab = _index == AppTabs.sheet && !inStack && _hasPeriods;
    return Directionality(
      textDirection: TextDirection.rtl,
      child: ShellScope(
        goTo: goTo,
        openAudit: _openAudit,
        currentTab: () => _index,
        child: PopScope(
          canPop: !inStack,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _navs[_index].currentState?.maybePop();
          },
          child: Scaffold(
            backgroundColor: Tw.paper,
            body: SafeArea(
              bottom: false,
              child: IndexedStack(
                index: _index,
                children: [
                  _tab(AppTabs.home, (_) => const HomePage()),
                  _tab(AppTabs.operations, (_) => const OperationsHub()),
                  _tab(
                    AppTabs.sheet,
                    (_) => SheetPage(
                      key: _periods,
                      onAudit: _openAudit,
                      onCount:
                          (n) =>
                              n > 0 == _hasPeriods
                                  ? null
                                  : setState(() => _hasPeriods = n > 0),
                    ),
                  ),
                  _tab(AppTabs.reports, (_) => const ReportsHub()),
                  _tab(AppTabs.more, (_) => const MoreHub()),
                ],
              ),
            ),
            floatingActionButton:
                fab
                    ? FloatingActionButton.extended(
                      onPressed: () => _periods.currentState?.openCreate(),
                      icon: const Icon(Icons.add, size: 22),
                      label: const Text('دورة جديدة'),
                    )
                    : null,
            bottomNavigationBar: DecoratedBox(
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: Tw.rule)),
              ),
              child: NavigationBar(
                selectedIndex: _index,
                onDestinationSelected: goTo,
                destinations: [
                  for (var i = 0; i < 5; i++)
                    NavigationDestination(
                      icon: Icon(_icons[i].$1),
                      selectedIcon: Icon(_icons[i].$2),
                      label: _labels[i],
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _StackObserver extends NavigatorObserver {
  _StackObserver(this.onChange);
  final VoidCallback onChange;
  int depth = 0;

  bool _page(Route<dynamic> r) => r is PageRoute;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (_page(route)) depth++;
    onChange();
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (_page(route)) depth--;
    onChange();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (_page(route)) depth--;
    onChange();
  }
}

/// `.hdr` of the mockup: the screen title (26/800), the workspace under it
/// when there are several, and the screen's «؟».
class ScreenHeader extends StatelessWidget {
  const ScreenHeader({
    super.key,
    required this.title,
    required this.help,
    this.helpTitle,
    this.actions = const [],
  });
  final String title;
  final List<HelpItem> Function() help;
  final String? helpTitle;

  /// Buttons before the «؟» (e.g. PDF).
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final several = services.host.workspaces.length > 1;
    // A screen opened from a hub (العمليات، التقارير، المزيد) gets «→».
    final back = Navigator.of(context).canPop();
    return Padding(
      padding: EdgeInsetsDirectional.fromSTEB(back ? 6 : 20, 20, 10, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (back)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: IconButton(
                tooltip: 'رجوع',
                onPressed: () => Navigator.of(context).maybePop(),
                icon: Icon(Icons.arrow_forward, color: Tw.ink),
              ),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Ds.screenTitle),
                if (several)
                  InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: () => showWorkspacesSheet(context),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.work_outline, size: 17, color: Tw.ink2),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              services.workspace.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.w500,
                                color: Tw.ink2,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Icon(Icons.expand_more, size: 16, color: Tw.ink3),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          ...actions,
          HelpButton(title: helpTitle ?? title, items: help),
        ],
      ),
    );
  }
}

/// «مساحات العمل» sheet (from under the screen title): switch, add, or
/// manage in Settings.
Future<void> showWorkspacesSheet(BuildContext context) async {
  final services = AppScope.read(context);
  final host = services.host;
  final shell = ShellScope.maybeOf(context);
  final activeId = services.workspace.id;
  final choice = await showAppSheet<int>(
    context,
    (ctx) => AppSheet(
      title: 'مساحات العمل',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final w in host.workspaces)
            ChoiceTile(
              icon: w.id == activeId ? Icons.check : Icons.work_outline,
              label: w.name,
              selected: w.id == activeId,
              tail: w.id == activeId ? const Text('الحالية') : null,
              onTap: () => Navigator.pop(ctx, w.id),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Divider(height: 1, color: Tw.rule),
          ),
          ChoiceTile(
            icon: Icons.add,
            label: 'مساحة عمل جديدة',
            onTap: () => Navigator.pop(ctx, _addWorkspace),
          ),
          ChoiceTile(
            icon: Icons.settings_outlined,
            label: 'إدارة مساحات العمل',
            onTap: () => Navigator.pop(ctx, _manageWorkspaces),
          ),
        ],
      ),
    ),
  );
  if (choice == null || !context.mounted) return;
  if (choice == _manageWorkspaces) {
    shell?.goTo(AppTabs.settings);
    return;
  }
  if (choice == _addWorkspace) {
    final name = await askWorkspaceName(context, 'مساحة عمل جديدة');
    if (name == null || name.trim().isEmpty || !context.mounted) return;
    try {
      final w = await host.create(name);
      await host.switchTo(w.id, tab: shell?.currentTab() ?? 0);
    } catch (e) {
      if (context.mounted) {
        showToast(
          context,
          e is ArgumentError ? '${e.message}' : '$e',
          ToastType.error,
        );
      }
    }
    return;
  }
  if (choice != activeId) {
    await host.switchTo(choice, tab: shell?.currentTab() ?? 0);
  }
}

const _addWorkspace = -1;
const _manageWorkspaces = -2;
