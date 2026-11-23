// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../app_services.dart';
import '../../services/pdf_reports.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../shell.dart';
import '../ui_kit.dart';

/// Shared pieces of the accounting screens (LorkERP): amounts, dates,
/// account pickers, the entry details sheet and the page frame.

const arabicMonths = [
  'كانون الثاني',
  'شباط',
  'آذار',
  'نيسان',
  'أيار',
  'حزيران',
  'تموز',
  'آب',
  'أيلول',
  'تشرين الأول',
  'تشرين الثاني',
  'كانون الأول',
];

String isoDate(DateTime d) =>
    '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

DateTime? parseIso(String s) => DateTime.tryParse(s);

/// «23 تشرين الثاني 2026».
String dateLabel(String iso, {bool year = true}) {
  final d = parseIso(iso);
  if (d == null) return iso;
  return '${d.day} ${arabicMonths[d.month - 1]}${year ? ' ${d.year}' : ''}';
}

/// An amount in cents, left-to-right, coloured by sign when asked.
class Money extends StatelessWidget {
  const Money(
    this.cents, {
    super.key,
    this.size = 15,
    this.weight = FontWeight.w700,
    this.color,
    this.signColor = false,
  });
  final int cents;
  final double size;
  final FontWeight weight;
  final Color? color;
  final bool signColor;

  @override
  Widget build(BuildContext context) => Text(
    formatCents(cents),
    textDirection: TextDirection.ltr,
    style: TextStyle(
      fontSize: size,
      fontWeight: weight,
      color:
          color ??
          (signColor
              ? (cents < 0 ? Tw.danger : (cents > 0 ? Tw.accentInk : Tw.ink2))
              : Tw.ink),
      fontFeatures: const [FontFeature.tabularFigures()],
    ),
  );
}

/// A numeric field for an amount; read it with [AmountField.cents].
class AmountField extends StatelessWidget {
  const AmountField({
    super.key,
    required this.controller,
    this.hint = '0.00',
    this.onChanged,
    this.autofocus = false,
  });
  final TextEditingController controller;
  final String hint;
  final ValueChanged<String>? onChanged;
  final bool autofocus;

  static int? cents(TextEditingController c) => parseCents(c.text);

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(13);
    const side = BorderSide(color: Colors.transparent, width: 1.5);
    return TextField(
      controller: controller,
      autofocus: autofocus,
      onChanged: onChanged,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      textDirection: TextDirection.ltr,
      textAlign: TextAlign.end,
      style: TextStyle(
        fontSize: 20,
        fontWeight: FontWeight.w800,
        color: Tw.ink,
        fontFamily: erpFont,
      ),
      decoration: InputDecoration(
        hintText: hint,
        filled: true,
        fillColor: Tw.surface2,
        border: OutlineInputBorder(borderRadius: radius, borderSide: side),
        enabledBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: side,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: BorderSide(color: Tw.accent, width: 1.5),
        ),
      ),
    );
  }
}

/// A plain text field on a form block.
class MemoField extends StatelessWidget {
  const MemoField({super.key, required this.controller, this.hint = 'البيان'});
  final TextEditingController controller;
  final String hint;

  @override
  Widget build(BuildContext context) =>
      ErpTextField(controller: controller, hint: hint);
}

/// The control of a form row that opens a picker: the value and a «⌄».
class PickerValue extends StatelessWidget {
  const PickerValue({
    super.key,
    required this.text,
    required this.onTap,
    this.placeholder = false,
  });
  final String text;
  final VoidCallback? onTap;
  final bool placeholder;

  @override
  Widget build(BuildContext context) => InkWell(
    borderRadius: BorderRadius.circular(10),
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 210),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: placeholder ? Tw.ink3 : Tw.accentInk,
                ),
              ),
            ),
            const SizedBox(width: 4),
            Icon(Icons.expand_more, size: 18, color: Tw.ink3),
          ],
        ),
      ),
    ),
  );
}

/// The date control of a form row.
class DateValue extends StatelessWidget {
  const DateValue({super.key, required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => PickerValue(
    text: dateLabel(value),
    onTap: () async {
      final now = DateTime.now();
      final picked = await showDatePicker(
        context: context,
        initialDate: parseIso(value) ?? now,
        firstDate: DateTime(2000),
        lastDate: DateTime(now.year + 5, 12, 31),
        locale: const Locale('ar'),
      );
      if (picked != null) onChanged(isoDate(picked));
    },
  );
}

/// The accounts a picker offers: postable, not archived, passing [where].
Future<Account?> pickAccount(
  BuildContext context, {
  required String title,
  bool Function(Account a)? where,
  int? selectedId,
  bool groups = false,
}) async {
  final services = AppScope.read(context);
  final all = await services.ledger.accounts();
  final list = [
    for (final a in all)
      if ((groups ? a.isGroup : !a.isGroup) && (where?.call(a) ?? true)) a,
  ];
  if (!context.mounted) return null;
  return showAppSheet<Account>(
    context,
    (ctx) => _AccountPickerSheet(
      title: title,
      accounts: list,
      selectedId: selectedId,
    ),
  );
}

class _AccountPickerSheet extends StatefulWidget {
  const _AccountPickerSheet({
    required this.title,
    required this.accounts,
    this.selectedId,
  });
  final String title;
  final List<Account> accounts;
  final int? selectedId;
  @override
  State<_AccountPickerSheet> createState() => _AccountPickerSheetState();
}

class _AccountPickerSheetState extends State<_AccountPickerSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.trim();
    final shown = [
      for (final a in widget.accounts)
        if (q.isEmpty || a.name.contains(q) || a.code.startsWith(q)) a,
    ];
    return AppSheet(
      title: widget.title,
      scroll: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.accounts.length > 6) ...[
            SheetSearch(
              hint: 'ابحث بالاسم أو الرمز',
              onChanged: (v) => setState(() => _q = v),
            ),
            const SizedBox(height: 8),
          ],
          Flexible(
            child:
                shown.isEmpty
                    ? Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'لا توجد حسابات',
                        textAlign: TextAlign.center,
                        style: Ds.caption,
                      ),
                    )
                    : ListView.builder(
                      shrinkWrap: true,
                      itemCount: shown.length,
                      itemBuilder: (_, i) {
                        final a = shown[i];
                        return ChoiceTile(
                          icon:
                              a.id == widget.selectedId
                                  ? Icons.check
                                  : _iconOf(a),
                          label: a.name,
                          selected: a.id == widget.selectedId,
                          tail: Text(a.code, textDirection: TextDirection.ltr),
                          onTap: () => Navigator.pop(context, a),
                        );
                      },
                    ),
          ),
        ],
      ),
    );
  }
}

IconData _iconOf(Account a) => switch (a.type) {
  AccountType.asset => Icons.account_balance_wallet_outlined,
  AccountType.liability => Icons.call_made,
  AccountType.equity => Icons.pie_chart_outline,
  AccountType.revenue => Icons.trending_up,
  AccountType.expense => Icons.trending_down,
};

IconData accountIcon(Account a) => _iconOf(a);

/// A page opened from a hub or a tab: the screen header and a scrolling
/// body that reloads after every posting ([AppServices.booksRevision]).
class BooksPage extends StatefulWidget {
  const BooksPage({
    super.key,
    required this.title,
    required this.help,
    required this.load,
    required this.build,
    this.fab,
    this.actions,
  });
  final String title;
  final List<HelpItem> help;
  final Future<Object?> Function(AppServices s) load;
  final List<Widget> Function(
    BuildContext context,
    Object? data,
    VoidCallback reload,
  )
  build;
  final Widget? Function(BuildContext context, VoidCallback reload)? fab;

  /// Header buttons (before «؟»), given the loaded data.
  final List<Widget> Function(BuildContext context, Object? data)? actions;

  @override
  State<BooksPage> createState() => _BooksPageState();
}

class _BooksPageState extends State<BooksPage> {
  Object? _data;
  Object? _error;
  bool _loading = true;
  int _revision = -1;

  Future<void> _reload() async {
    final s = AppScope.read(context);
    try {
      final d = await widget.load(s);
      if (!mounted) return;
      setState(() {
        _data = d;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final rev = AppScope.of(context).booksRevision;
    if (rev != _revision) {
      _revision = rev;
      _reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = <Widget>[
      ScreenHeader(
        title: widget.title,
        help: () => widget.help,
        actions:
            _loading || _error != null
                ? const []
                : (widget.actions?.call(context, _data) ?? const []),
      ),
      if (_loading)
        const Padding(
          padding: EdgeInsets.all(48),
          child: Center(child: CircularProgressIndicator()),
        )
      else if (_error != null)
        Padding(
          padding: Ds.pagePadding,
          child: NoticeBox(
            bg: Tw.dangerSoft,
            child: Text('$_error', style: TextStyle(color: Tw.danger)),
          ),
        )
      else
        Padding(
          padding: Ds.pagePadding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: widget.build(context, _data, _reload),
          ),
        ),
    ];
    return Scaffold(
      backgroundColor: Tw.paper,
      floatingActionButton:
          _loading ? null : widget.fab?.call(context, _reload),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 90),
            children: body,
          ),
        ),
      ),
    );
  }
}

/// Opens [page] in the current tab (above the bottom navigation).
Future<void> openPage(BuildContext context, Widget page) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

/// Runs a posting: shows its error as a toast, tells the screens to reload
/// on success and returns whether it worked.
Future<bool> runPosting(
  BuildContext context,
  Future<void> Function(AppServices s) op, {
  String? done,
}) async {
  final s = AppScope.read(context);
  try {
    await op(s);
    s.booksChanged();
    if (context.mounted && done != null) {
      showToast(context, done, ToastType.success);
    }
    return true;
  } on LedgerException catch (e) {
    if (context.mounted) showToast(context, e.message, ToastType.error);
  } catch (e) {
    if (context.mounted) showToast(context, '$e', ToastType.error);
  }
  return false;
}

/// One entry in a list: memo, kind and date, and its amount.
class EntryRow extends StatelessWidget {
  const EntryRow({super.key, required this.entry, this.amount, this.onTap});
  final JournalEntry entry;

  /// The amount to show (e.g. the signed movement of one account); the
  /// entry total by default.
  final int? amount;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final strike = e.reversed || e.isReversal;
    return ListRow(
      title: e.memo,
      titleColor: strike ? Tw.ink3 : null,
      leading: IconChip(
        _kindIcon(e.kind),
        color: strike ? Tw.ink3 : Tw.accentInk,
        bg: strike ? Tw.surface2 : Tw.accentSoft,
      ),
      subtitle: Text(
        '${EntryKind.label(e.kind)} · ${dateLabel(e.date)} · #${e.number}${e.reversed ? ' · مُلغى' : ''}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Money(
        amount ?? e.total,
        signColor: amount != null,
        color: strike ? Tw.ink3 : null,
      ),
      onTap: onTap ?? () => showEntrySheet(context, e.id),
    );
  }
}

IconData _kindIcon(String kind) => switch (kind) {
  EntryKind.receipt => Icons.south_west,
  EntryKind.payment => Icons.north_east,
  EntryKind.expense => Icons.receipt_long_outlined,
  EntryKind.transfer => Icons.swap_horiz,
  EntryKind.opening => Icons.flag_outlined,
  EntryKind.reversal => Icons.undo,
  EntryKind.debtToUs => Icons.call_made,
  EntryKind.debtToThem => Icons.call_received,
  EntryKind.partyTransfer => Icons.swap_horiz,
  EntryKind.settlement => Icons.task_alt,
  EntryKind.brokerage => Icons.handshake_outlined,
  EntryKind.reward => Icons.card_giftcard_outlined,
  EntryKind.share => Icons.pie_chart_outline,
  EntryKind.returned => Icons.undo,
  EntryKind.sale => Icons.sell_outlined,
  EntryKind.purchase => Icons.add_shopping_cart,
  EntryKind.fx => Icons.currency_exchange,
  EntryKind.salarySwap => Icons.currency_exchange,
  EntryKind.cycle => Icons.calendar_today_outlined,
  _ => Icons.edit_note,
};

/// The details of an entry with its lines, and «إلغاء القيد».
Future<void> showEntrySheet(BuildContext context, int entryId) async {
  final s = AppScope.read(context);
  final e = await s.ledger.entry(entryId);
  if (e == null || !context.mounted) return;
  final accounts = {
    for (final a in await s.ledger.accounts(archived: true)) a.id: a,
  };
  final other = e.reversesId ?? e.reversedById;
  final otherEntry = other == null ? null : await s.ledger.entry(other);
  if (!context.mounted) return;
  await showAppSheet<void>(
    context,
    (ctx) => AppSheet(
      title: 'القيد رقم ${e.number}',
      footer:
          e.reversed || e.isReversal
              ? null
              : ErpButton(
                label: 'إلغاء القيد (قيد عكسي)',
                icon: Icons.undo,
                kind: ErpButtonKind.soft,
                onPressed: () async {
                  final ok = await confirmDialog(
                    ctx,
                    icon: Icons.undo,
                    title: 'إلغاء القيد رقم ${e.number}؟',
                    body:
                        'يُسجَّل قيد عكسي بتاريخ اليوم يعيد الأرصدة كما كانت، ويبقى القيدان ظاهرين في الدفتر.',
                    confirmLabel: 'إلغاء القيد',
                    confirmKind: ErpButtonKind.danger,
                  );
                  if (!ok || !ctx.mounted) return;
                  final done = await runPosting(
                    ctx,
                    (s) => s.ledger.reverse(e.id),
                    done: 'أُلغي القيد',
                  );
                  if (done && ctx.mounted) Navigator.pop(ctx);
                },
              ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            e.memo,
            style: Ds.body.copyWith(
              fontSize: 16.5,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${EntryKind.label(e.kind)} · ${dateLabel(e.date)}',
            style: Ds.secondary,
          ),
          if (otherEntry != null) ...[
            const SizedBox(height: 10),
            StatusBadge(
              e.isReversal
                  ? 'يلغي القيد رقم ${otherEntry.number}'
                  : 'أُلغي بالقيد رقم ${otherEntry.number}',
              tone: Tone.warning,
              icon: Icons.undo,
              small: true,
            ),
          ],
          const SheetLabel('السطور'),
          FormRows(
            children: [
              for (final l in e.lines)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 12,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              accounts[l.accountId]?.name ?? '—',
                              style: Ds.body,
                            ),
                            if (l.memo.isNotEmpty)
                              Text(l.memo, style: Ds.secondary),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Money(l.debit > 0 ? l.debit : l.credit),
                          Text(
                            l.debit > 0 ? 'مدين' : 'دائن',
                            style: Ds.secondary.copyWith(fontSize: 12),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    Expanded(child: Text('الإجمالي', style: Ds.label)),
                    Money(e.total),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

/// A hub row: icon, title, subtitle and a chevron.
class HubRow extends StatelessWidget {
  const HubRow({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    required this.onTap,
    this.trailing,
  });
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => ListRow(
    title: title,
    leading: IconChip(icon, color: Tw.accentInk, bg: Tw.accentSoft),
    subtitle: subtitle == null ? null : Text(subtitle!),
    onTap: onTap,
    trailing: Row(
      mainAxisSize: MainAxisSize.min,
      children: [if (trailing != null) trailing!, const RowChevron()],
    ),
  );
}

/// The «PDF» header button: builds the report and lets the user save or
/// share the file.
class PdfButton extends StatefulWidget {
  const PdfButton({super.key, required this.name, required this.build});
  final String name;
  final Future<Uint8List> Function(PdfReports pdf, AppServices s) build;
  @override
  State<PdfButton> createState() => _PdfButtonState();
}

class _PdfButtonState extends State<PdfButton> {
  bool _busy = false;

  Future<void> _go() async {
    setState(() => _busy = true);
    final s = AppScope.read(context);
    try {
      final bytes = await widget.build(await PdfReports.load(), s);
      final safe = '${widget.name} ${s.workspace.name} ${Ledger.today()}'
          .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
      final saved = await FilePicker.platform.saveFile(
        dialogTitle: 'حفظ التقرير',
        fileName: '$safe.pdf',
        type: FileType.custom,
        allowedExtensions: const ['pdf'],
        bytes: bytes,
      );
      if (saved != null && mounted) {
        showToast(context, 'حُفظ التقرير', ToastType.success);
      }
    } catch (e) {
      if (mounted) {
        showToast(context, 'تعذر إنشاء التقرير: $e', ToastType.error);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: 'تقرير PDF',
    onPressed: _busy ? null : _go,
    icon:
        _busy
            ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
            : Icon(Icons.picture_as_pdf_outlined, size: 23, color: Tw.ink2),
  );
}
