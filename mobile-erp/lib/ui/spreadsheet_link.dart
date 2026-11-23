// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../google/sheets_client.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';

/// Value of the «لصق رابط جدول» entry in spreadsheet selects.
const pasteLinkValue = '__paste_spreadsheet_link__';
const pasteLinkLabel = '🔗 لصق رابط جدول Google…';

/// Spreadsheet id from a Google Sheets link (or a bare id).
String? extractSpreadsheetId(String input) {
  final m = RegExp(r'/spreadsheets/d/([a-zA-Z0-9_-]+)').firstMatch(input);
  if (m != null) return m.group(1);
  final t = input.trim();
  return RegExp(r'^[a-zA-Z0-9_-]{20,}$').hasMatch(t) ? t : null;
}

/// Asks for a Google Sheets link, checks it with the connected account and
/// returns the spreadsheet (id + title), or null when cancelled.
Future<SpreadsheetFile?> askSpreadsheetLink(
  BuildContext context,
  SheetsApi api,
) => showDialog<SpreadsheetFile>(
  context: context,
  builder:
      (_) => Directionality(
        textDirection: TextDirection.rtl,
        child: _LinkDialog(api: api),
      ),
);

class _LinkDialog extends StatefulWidget {
  const _LinkDialog({required this.api});
  final SheetsApi api;
  @override
  State<_LinkDialog> createState() => _LinkDialogState();
}

class _LinkDialogState extends State<_LinkDialog> {
  final _text = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _paste() async {
    final t = await pasteText();
    if (t != null && t.isNotEmpty) setState(() => _text.text = t);
  }

  Future<void> _confirm() async {
    final id = extractSpreadsheetId(_text.text);
    if (id == null) {
      setState(
        () => _error = 'الرابط غير صالح. انسخ رابط الجدول من Google Sheets.',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final meta = await widget.api.getSpreadsheet(id);
      if (!mounted) return;
      Navigator.pop(context, SpreadsheetFile(id, meta.title ?? id));
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    title: const Text(
      'رابط جدول Google',
      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
    ),
    content: SizedBox(
      width: 340,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: ErpTextField(
                  controller: _text,
                  ltr: true,
                  hint: 'https://docs.google.com/spreadsheets/d/…',
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 84,
                child: ErpButton(
                  label: 'لصق',
                  icon: Icons.content_paste_outlined,
                  kind: ErpButtonKind.outline,
                  height: 46,
                  fontSize: 12,
                  onPressed: _paste,
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(
              _error!,
              style: TextStyle(fontSize: 12.5, color: Tw.red700, height: 1.5),
            ),
          ],
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.pop(context),
        child: const Text('إلغاء'),
      ),
      FilledButton(
        style: FilledButton.styleFrom(backgroundColor: Tw.indigo600),
        onPressed: _busy ? null : _confirm,
        child: Text(_busy ? 'جاري التحقق...' : 'اختيار'),
      ),
    ],
  );
}
