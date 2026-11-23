// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/payroll_service.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'ui_kit.dart';

/// The sheet (owner's mockup `unSheet`) listing the agent-sheet users who
/// are not audited yet: id (column A) and name (column C), the remaining
/// count, search, and copy (all, or the ids only).
Future<void> showUnauditedDialog(
  BuildContext context,
  PendingAgentMembers data,
) => showAppSheet<void>(context, (_) => _UnauditedDialog(data: data));

class _UnauditedDialog extends StatefulWidget {
  const _UnauditedDialog({required this.data});
  final PendingAgentMembers data;
  @override
  State<_UnauditedDialog> createState() => _UnauditedDialogState();
}

class _UnauditedDialogState extends State<_UnauditedDialog> {
  final _filter = TextEditingController();
  String _query = '';
  String? _copied;

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  List<PendingMember> get _visible {
    final q = _query.trim();
    if (q.isEmpty) return widget.data.members;
    return [
      for (final m in widget.data.members)
        if (m.id.contains(q) || m.name.contains(q)) m,
    ];
  }

  Future<void> _copy({required bool idsOnly}) async {
    final list = _visible;
    final text = [
      for (final m in list) idsOnly ? m.id : '${m.id}\t${m.name}',
    ].join('\n');
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    setState(
      () =>
          _copied =
              idsOnly
                  ? 'تم نسخ ${list.length} رقم'
                  : 'تم نسخ ${list.length} صف (الرقم والاسم)',
    );
  }

  @override
  Widget build(BuildContext context) {
    final members = widget.data.members;
    final visible = _visible;
    const title = 'السجلات غير المدققة في جدول الوكيل';
    if (members.isEmpty) {
      return AppSheet(
        title: title,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 24, 10, 12),
          child: Column(
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: Tw.surface2,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Icon(Icons.check, size: 30, color: Tw.ink3),
              ),
              const SizedBox(height: 14),
              Text(
                'لا يوجد أرقام غير مدققة في ورقة الوكيل.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, color: Tw.ink2),
              ),
            ],
          ),
        ),
      );
    }
    return AppSheet(
      title: title,
      scroll: false,
      footer: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_copied != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                '✓ $_copied',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: Tw.accentInk,
                ),
              ),
            ),
          Row(
            children: [
              Expanded(
                child: ErpButton(
                  label: 'نسخ الأرقام فقط',
                  kind: ErpButtonKind.outline,
                  onPressed: () => _copy(idsOnly: true),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ErpButton(
                  label: 'نسخ الكل',
                  icon: Icons.content_copy_outlined,
                  onPressed: () => _copy(idsOnly: false),
                ),
              ),
            ],
          ),
        ],
      ),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.6,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 2, 4, 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    formatCount(members.length),
                    style: TextStyle(
                      fontSize: 34,
                      fontWeight: FontWeight.w800,
                      height: 1.1,
                      color: Tw.ink,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'المتبقي من ${formatCount(widget.data.agentTotal)} رقم في ورقة الوكيل',
                      style: TextStyle(fontSize: 14, color: Tw.ink2),
                    ),
                  ),
                ],
              ),
            ),
            SheetSearch(
              controller: _filter,
              hint: 'بحث برقم أو اسم',
              onChanged: (v) => setState(() => _query = v),
            ),
            const SizedBox(height: 8),
            Expanded(
              child:
                  visible.isEmpty
                      ? Padding(
                        padding: const EdgeInsets.all(28),
                        child: Text(
                          'لا نتائج مطابقة.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Tw.ink2),
                        ),
                      )
                      : ListView.builder(
                        itemCount: visible.length,
                        itemBuilder: (_, i) {
                          final m = visible[i];
                          return Container(
                            constraints: const BoxConstraints(minHeight: 50),
                            decoration: BoxDecoration(
                              border: Border(
                                bottom: BorderSide(color: Tw.rule),
                              ),
                            ),
                            child: Row(
                              children: [
                                SelectableText(
                                  m.id,
                                  textDirection: TextDirection.ltr,
                                  style: TextStyle(
                                    fontSize: 14.5,
                                    fontWeight: FontWeight.w700,
                                    color: Tw.ink,
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    m.name.isEmpty ? '—' : m.name,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 14.5,
                                      color: Tw.ink2,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
            ),
            if (_query.trim().isNotEmpty)
              Caption('النسخ يشمل ${visible.length} من نتائج البحث فقط.'),
          ],
        ),
      ),
    );
  }
}
