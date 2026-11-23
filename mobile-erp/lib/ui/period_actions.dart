// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import 'books/cycle_posting_page.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'sheet_page.dart';
import 'ui_kit.dart';

/// The ⋯ of a period (owner's mockup): a sheet with «تدقيق الدورة» (outside
/// the audit screen), «مزامنة الدورة» (Google periods), «تعديل الدورة»,
/// «إقفال التدقيق» / «إعادة فتح التدقيق» and «حذف الدورة».
enum PeriodAction { audit, sync, edit, lock, books, delete }

String periodName(Cycle c) => c.name.isEmpty ? 'دورة #${c.id}' : c.name;

Future<PeriodAction?> showPeriodMenu(
  BuildContext context,
  Cycle cycle, {
  bool fromAudit = false,
}) {
  final closed = cycle.auditClosedAt != null;
  return showAppSheet<PeriodAction>(context, (ctx) {
    Widget choice(
      PeriodAction a,
      IconData icon,
      String label, {
      bool danger = false,
    }) => ChoiceTile(
      icon: icon,
      label: label,
      danger: danger,
      onTap: () => Navigator.pop(ctx, a),
    );
    return AppSheet(
      title: periodName(cycle),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!fromAudit)
            choice(
              PeriodAction.audit,
              Icons.assignment_turned_in_outlined,
              'تدقيق الدورة',
            ),
          if (cycle.linkedToGoogle)
            choice(PeriodAction.sync, Icons.sync, 'مزامنة الدورة'),
          choice(PeriodAction.edit, Icons.edit_outlined, 'تعديل الدورة'),
          choice(
            PeriodAction.lock,
            closed ? Icons.lock_open_outlined : Icons.lock_outline,
            closed ? 'إعادة فتح التدقيق' : 'إقفال التدقيق',
          ),
          choice(
            PeriodAction.books,
            Icons.menu_book_outlined,
            'ترحيل إلى الدفاتر',
          ),
          choice(
            PeriodAction.delete,
            Icons.delete_outline,
            'حذف الدورة',
            danger: true,
          ),
        ],
      ),
    );
  });
}

/// The ⋯ button of a period.
class PeriodMenu extends StatelessWidget {
  const PeriodMenu({
    super.key,
    required this.cycle,
    required this.onSelected,
    this.fromAudit = false,
    this.color,
  });
  final Cycle cycle;
  final ValueChanged<PeriodAction> onSelected;
  final bool fromAudit;
  final Color? color;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: 'إجراءات «${periodName(cycle)}»',
    icon: Icon(Icons.more_horiz, size: 24, color: color ?? Tw.ink2),
    onPressed: () async {
      final a = await showPeriodMenu(context, cycle, fromAudit: fromAudit);
      if (a != null) onSelected(a);
    },
  );
}

/// Runs a period action (except [PeriodAction.audit], which the caller
/// opens). Returns true when the period was deleted.
Future<bool> runPeriodAction(
  BuildContext context,
  Cycle cycle,
  PeriodAction action,
) async {
  final s = AppScope.read(context);
  switch (action) {
    case PeriodAction.audit:
      return false;
    case PeriodAction.sync:
      showToast(context, 'جاري مزامنة الدورة…', ToastType.info);
      final r = await s.cycles.syncCycle(cycle.id);
      if (!context.mounted) return false;
      showToast(
        context,
        r.detail == null ? r.message : '${r.message} — ${r.detail}',
        r.success ? ToastType.success : ToastType.warning,
      );
      if (r.success) s.cyclesChanged();
      return false;
    case PeriodAction.edit:
      final saved = await showAppSheet<bool>(
        context,
        (_) => CycleModal(edit: cycle),
      );
      if (saved == true) s.cyclesChanged();
      return false;
    case PeriodAction.lock:
      final close = cycle.auditClosedAt == null;
      await s.db.setAuditClosed(cycle.id, close);
      if (!context.mounted) return false;
      showToast(
        context,
        close ? 'أُقفل التدقيق' : 'أُعيد فتح التدقيق',
        ToastType.success,
      );
      s.cyclesChanged();
      return false;
    case PeriodAction.books:
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CyclePostingPage(cycleId: cycle.id),
        ),
      );
      return false;
    case PeriodAction.delete:
      final ok = await confirmDialog(
        context,
        icon: Icons.delete_outline,
        title: 'حذف الدورة المالية',
        body:
            'سيُحذف «${periodName(cycle)}» من هذا الهاتف مع حالات تدقيقها. لا يُحذف أي شيء من Google، ولا يمكن التراجع.',
        confirmLabel: 'حذف',
        confirmKind: ErpButtonKind.danger,
      );
      if (!ok || !context.mounted) return false;
      await s.cycles.deleteCycle(cycle.id);
      if (!context.mounted) return true;
      showToast(context, 'حُذفت الدورة المالية', ToastType.success);
      s.cyclesChanged();
      return true;
  }
}
