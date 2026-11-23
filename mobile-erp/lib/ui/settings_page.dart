// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../app_services.dart';
import '../services/user_sheet_tools.dart';
import '../version.dart';
import 'erp_theme.dart';
import 'columns_card.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'shell.dart';
import 'ui_kit.dart';
import 'workspaces_card.dart';

/// Settings → Google Sheets connection (the account is linked on the phone).
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _busy = false;
  bool? _syncEnabled;
  RoundingMode? _rounding;

  /// Second adjustments system (3.3.0); null while loading.
  bool? _columnSystem;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final services = AppScope.read(context);
      final enabled = await services.syncWorker.isEnabled();
      final rounding = await services.userTools.defaultMode();
      final column = await services.adjustments.columnSystem();
      if (mounted) {
        setState(() {
          _syncEnabled = enabled;
          _rounding = rounding;
          _columnSystem = column;
        });
      }
    });
  }

  /// ERP `POST /sheets/toggle-sync`.
  Future<void> _toggleSync(bool _) async {
    final services = AppScope.read(context);
    if (!services.auth.isConnected) {
      showToast(context, 'يرجى إعداد Google Sheets أولاً', ToastType.error);
      return;
    }
    final next = !(_syncEnabled ?? false);
    await services.syncWorker.setEnabled(next);
    if (!mounted) return;
    setState(() => _syncEnabled = next);
    showToast(
      context,
      next ? 'تم تفعيل المزامنة' : 'تم إيقاف المزامنة',
      ToastType.success,
    );
  }

  Future<void> _connect() async {
    setState(() => _busy = true);
    try {
      final ok = await AppScope.read(context).auth.connect();
      if (!mounted) return;
      showToast(
        context,
        ok ? 'تم ربط حساب Google' : 'لم يكتمل ربط حساب Google',
        ok ? ToastType.success : ToastType.warning,
      );
    } catch (e) {
      if (mounted) showToast(context, 'تعذر ربط Google: $e', ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disconnect() async {
    // The mockup asks before disconnecting.
    final ok = await confirmDialog(
      context,
      icon: Icons.link_off,
      title: 'فصل حساب Google؟',
      body:
          'يتوقف التدقيق على Google والمزامنة حتى تربط الحساب من جديد. تبقى الدورات ونتائجها على الهاتف.',
      confirmLabel: 'فصل',
      confirmKind: ErpButtonKind.danger,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    await AppScope.read(context).auth.disconnect();
    if (!mounted) return;
    setState(() => _busy = false);
    showToast(context, 'تم فصل حساب Google', ToastType.success);
  }

  Future<void> _openMapping() => Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => const ColumnsPage()));

  /// The default rounding of «فرز ← جبر الرواتب».
  Future<void> _pickRounding() async {
    final services = AppScope.read(context);
    final current = _rounding ?? RoundingMode.floor;
    final picked = await showAppSheet<RoundingMode>(
      context,
      (ctx) => AppSheet(
        title: 'طريقة جبر الرواتب الافتراضية',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final m in RoundingMode.values)
              ChoiceTile(
                icon: m == current ? Icons.check : Icons.calculate_outlined,
                label: '${m.label} — ${m.example}',
                selected: m == current,
                onTap: () => Navigator.pop(ctx, m),
              ),
            const Caption(
              'تُستخدم في «فرز ← جبر الرواتب»، ويمكن اختيار غيرها هناك لعملية واحدة.',
            ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    await services.userTools.setDefaultMode(picked);
    if (!mounted) return;
    setState(() => _rounding = picked);
    showToast(context, 'الجبر الافتراضي: ${picked.label}', ToastType.success);
  }

  /// Owner's request (3.3.0): the second adjustments system is hidden until
  /// it is chosen here, and then it replaces the first one.
  Future<void> _pickAdjustmentsSystem() async {
    final services = AppScope.read(context);
    final current = _columnSystem ?? false;
    final picked = await showAppSheet<bool>(
      context,
      (ctx) => AppSheet(
        title: 'نظام التسويات',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ChoiceTile(
              icon: !current ? Icons.check : Icons.edit_note_outlined,
              label: 'تعديل عمود الراتب',
              selected: !current,
              onTap: () => Navigator.pop(ctx, false),
            ),
            ChoiceTile(
              icon: current ? Icons.check : Icons.view_week_outlined,
              label: 'الراتب بعد التسوية في عمود منفصل',
              selected: current,
              onTap: () => Navigator.pop(ctx, true),
            ),
            const Caption(
              'نظام واحد فقط يظهر في «التسويات». الأول يكتب الراتب الجديد في عمود الراتب و«تم خصم / تم اضافة» في عمود الحالة. الثاني لا يغيّر عمود الراتب: يكتب الراتب بعد التسوية ملوّنًا في عمود تختاره، وبعده «الحالة» و«حالة المستخدم» و«العملية الحسابية».',
            ),
          ],
        ),
      ),
    );
    if (picked == null || picked == current || !mounted) return;
    await services.adjustments.setColumnSystem(picked);
    if (!mounted) return;
    setState(() => _columnSystem = picked);
    showToast(
      context,
      picked
          ? 'التسويات: الراتب بعد التسوية في عمود منفصل'
          : 'التسويات: تعديل عمود الراتب',
      ToastType.success,
    );
  }

  /// `aboutSheet`.
  void _about() => showAppSheet<void>(
    context,
    (ctx) => AppSheet(
      title: 'حول LorkERP',
      child: Padding(
        padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
        child: Column(
          children: [
            Image.asset('assets/brand/logo.png', width: 76, height: 76),
            const SizedBox(height: 12),
            Text(
              'LorkERP',
              style: TextStyle(
                fontSize: 21,
                fontWeight: FontWeight.w800,
                color: Tw.ink,
              ),
            ),
            Text(
              'الإصدار $appVersion',
              style: TextStyle(fontSize: 15, color: Tw.ink2),
            ),
            const SizedBox(height: 6),
            Text(
              'نظام محاسبي متكامل على الهاتف: شجرة حسابات وقيد مزدوج، صناديق وسندات قبض وصرف وتحويل، مصاريف، أرصدة افتتاحية، ميزان مراجعة وكشوف حسابات وقائمة دخل وميزانية عمومية. ومعه تدقيق كشوف الرواتب كما في «المدقق»: يطابق كل مستخدم برقمه بين بيانات المستخدمين وجدولي الإدارة والوكيل، ويكتب النتائج والألوان في Google Sheets أو يصدّرها إلى Excel، مع تسويات الرواتب.\n\nالحساب كله على الهاتف، دون خادم، وتُحفظ البيانات في قاعدة على الجهاز مع نسخ احتياطي إلى ملف أو Google Drive.\n\nالتقارير محاسبة تشغيلية لإدارة عملك، وليست تدقيقًا ماليًا معتمدًا.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 15, height: 1.75, color: Tw.ink2),
            ),
          ],
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final auth = services.auth;
    final connected = auth.isConnected;
    Widget section(String title, Widget child) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [SectionLabel(title), child],
      ),
    );
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        ScreenHeader(title: 'الإعدادات', help: () => settingsHelp),
        section(
          'الربط والمزامنة',
          GroupList(
            children: [
              ListRow(
                title: 'حساب Google',
                leading: IconChip(Icons.cloud_outlined),
                subtitle: Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: connected ? Tw.accent : Tw.ink3,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        connected
                            ? 'متصل، ${ltr(auth.email ?? '')}'
                            : 'غير متصل',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                trailing: ErpButton(
                  label:
                      _busy
                          ? 'جاري الربط…'
                          : connected
                          ? 'فصل'
                          : 'ربط',
                  kind:
                      connected
                          ? ErpButtonKind.outline
                          : ErpButtonKind.indigoSoft,
                  height: 40,
                  expand: false,
                  onPressed:
                      _busy
                          ? null
                          : connected
                          ? _disconnect
                          : _connect,
                ),
              ),
              ListRow(
                title: 'المزامنة التلقائية',
                leading: IconChip(Icons.sync),
                subtitle: const Text('كل دقيقتين أثناء فتح التطبيق'),
                trailing: Switch(
                  value: _syncEnabled ?? false,
                  onChanged: _syncEnabled == null ? null : _toggleSync,
                ),
              ),
            ],
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: WorkspacesCard(),
        ),
        section(
          'البيانات',
          GroupList(
            children: [
              ListRow(
                title: 'ربط حقول البيانات',
                leading: IconChip(Icons.view_column_outlined),
                subtitle: const Text(
                  'أعمدة الإدارة والوكيل وبيانات المستخدمين وغير المذكورين',
                ),
                trailing: const RowChevron(),
                onTap: _openMapping,
              ),
              ListRow(
                title: 'طريقة جبر الرواتب',
                leading: IconChip(Icons.calculate_outlined),
                subtitle: Text(
                  _rounding == null
                      ? '…'
                      : '${_rounding!.label} (${_rounding!.term})',
                ),
                trailing: const RowChevron(),
                onTap: _rounding == null ? null : _pickRounding,
              ),
              ListRow(
                title: 'نظام التسويات',
                leading: IconChip(Icons.swap_vert),
                subtitle: Text(
                  _columnSystem == null
                      ? '…'
                      : _columnSystem!
                      ? 'الراتب بعد التسوية في عمود منفصل'
                      : 'تعديل عمود الراتب',
                ),
                trailing: const RowChevron(),
                onTap: _columnSystem == null ? null : _pickAdjustmentsSystem,
              ),
            ],
          ),
        ),
        section(
          'المظهر',
          SegmentedChoice(
            options: const ['فاتح', 'داكن', 'حسب الجهاز'],
            selected: const [
              'light',
              'dark',
              'system',
            ].indexOf(services.host.appearance),
            onChanged:
                (i) => services.host.setAppearance(
                  const ['light', 'dark', 'system'][i],
                ),
          ),
        ),
        section(
          'التطبيق',
          GroupList(
            children: [
              ListRow(
                title: 'حول LorkERP',
                leading: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.asset(
                    'assets/brand/logo.png',
                    width: 38,
                    height: 38,
                  ),
                ),
                subtitle: const Text('الإصدار $appVersion'),
                trailing: const RowChevron(),
                onTap: _about,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
