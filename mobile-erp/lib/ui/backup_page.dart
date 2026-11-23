// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../app_services.dart';
import '../services/backup_service.dart';
import 'books/books_kit.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'shell.dart';
import 'ui_kit.dart';

const backupHelp = [
  HelpItem(
    '',
    'النسخة الاحتياطية فيها كل بيانات مساحة العمل: شجرة الحسابات والقيود والصناديق، والدورات المالية والتدقيق والإعدادات.',
  ),
  HelpItem(
    '',
    'احفظها في ملف (على الهاتف أو أرسلها لنفسك)، أو ارفعها إلى Google Drive في مجلد «LorkERP». يرى التطبيق في Drive الملفات التي أنشأها فقط.',
  ),
  HelpItem(
    '',
    'الاستعادة تستبدل كل بيانات مساحة العمل الحالية بما في النسخة. يُفضّل أخذ نسخة من الحالية قبلها.',
  ),
  HelpItem(
    '',
    'النسخ التلقائي يرفع نسخة إلى Drive مرة في اليوم عند فتح التطبيق، ويحتفظ بآخر 20 نسخة.',
  ),
];

String _when(DateTime? d) {
  if (d == null) return 'لم تُؤخذ بعد';
  final l = d.toLocal();
  return '${dateLabel(isoDate(l))} ${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
}

String _size(int bytes) =>
    bytes < 1024 * 1024
        ? '${(bytes / 1024).toStringAsFixed(0)} ك.ب'
        : '${(bytes / 1024 / 1024).toStringAsFixed(1)} م.ب';

class BackupPage extends StatefulWidget {
  const BackupPage({super.key});
  @override
  State<BackupPage> createState() => _BackupPageState();
}

class _BackupPageState extends State<BackupPage> {
  bool _busy = false;
  String? _busyLabel;
  bool _auto = false;
  DateTime? _lastDrive;
  DateTime? _lastFile;
  String? _autoError;
  List<DriveBackup>? _drive;
  String? _driveError;

  AppServices get _s => AppScope.read(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final b = _s.backup;
    final auto = await b.autoDrive();
    final lastDrive = await b.lastDrive();
    final lastFile = await b.lastFile();
    final err = await b.autoError();
    if (!mounted) return;
    setState(() {
      _auto = auto;
      _lastDrive = lastDrive;
      _lastFile = lastFile;
      _autoError = err;
    });
    if (_s.auth.isConnected) await _listDrive();
  }

  Future<void> _listDrive() async {
    try {
      final list = await _s.backup.listDrive();
      if (mounted) {
        setState(() {
          _drive = list;
          _driveError = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _driveError = '$e');
    }
  }

  Future<void> _run(String label, Future<void> Function() op) async {
    setState(() {
      _busy = true;
      _busyLabel = label;
    });
    try {
      await op();
    } catch (e) {
      if (mounted) showToast(context, '$e', ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveFile() => _run('جاري تجهيز الملف…', () async {
    final bytes = await _s.backup.export(_s.workspace.name);
    final date = DateTime.now().toIso8601String().substring(0, 10);
    final safe = _s.workspace.name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final saved = await FilePicker.platform.saveFile(
      dialogTitle: 'حفظ النسخة الاحتياطية',
      fileName: 'LorkERP $safe $date.${BackupService.extension}',
      bytes: bytes,
    );
    if (saved == null) return;
    await _s.backup.markFileSaved();
    if (!mounted) return;
    showToast(
      context,
      'حُفظت النسخة (${_size(bytes.length)})',
      ToastType.success,
    );
    await _load();
  });

  Future<void> _uploadDrive() => _run('جاري الرفع إلى Google Drive…', () async {
    if (!_s.auth.isConnected && !await _s.auth.connect()) return;
    final f = await _s.backup.uploadToDrive(_s.workspace.name);
    if (!mounted) return;
    showToast(
      context,
      'رُفعت النسخة إلى Drive (${_size(f.size)})',
      ToastType.success,
    );
    await _load();
  });

  Future<void> _restoreBytes(Uint8List bytes) async {
    final info = BackupService.inspect(bytes);
    if (!mounted) return;
    final ok = await confirmDialog(
      context,
      icon: Icons.restore,
      title: 'استعادة النسخة؟',
      body:
          'النسخة: «${info.workspace}» بتاريخ ${_when(info.createdAt)} (الإصدار ${info.appVersion}).\n'
          'فيها ${info.accounts} حسابًا و${info.entries} قيدًا و${info.cycles} دورة مالية.\n\n'
          'ستُستبدل كل بيانات مساحة العمل الحالية «${_s.workspace.name}» بها، ولا يمكن التراجع.',
      confirmLabel: 'استعادة',
      confirmKind: ErpButtonKind.danger,
    );
    if (!ok || !mounted) return;
    await _s.backup.restore(bytes);
    if (!mounted) return;
    showToast(context, 'استُعيدت النسخة', ToastType.success);
    await _s.host.reloadActive();
  }

  Future<void> _restoreFile() => _run('جاري قراءة الملف…', () async {
    final picked = await FilePicker.platform.pickFiles(
      type: FileType.any,
      withData: true,
    );
    final bytes = picked?.files.singleOrNull?.bytes;
    if (bytes == null) return;
    await _restoreBytes(bytes);
  });

  Future<void> _restoreDrive(DriveBackup f) =>
      _run('جاري التنزيل من Drive…', () async {
        final bytes = await _s.backup.downloadFromDrive(f.id);
        await _restoreBytes(bytes);
      });

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final connected = services.auth.isConnected;
    return Scaffold(
      backgroundColor: Tw.paper,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 40),
            children: [
              ScreenHeader(title: 'النسخ الاحتياطي', help: () => backupHelp),
              Padding(
                padding: Ds.pagePadding,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_busy) ...[
                      NoticeBox(
                        child: Row(
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 10),
                            Expanded(child: Text(_busyLabel ?? '')),
                          ],
                        ),
                      ),
                      gap,
                    ],
                    const SectionLabel('ملف', top: 4),
                    GroupList(
                      children: [
                        HubRow(
                          icon: Icons.save_alt,
                          title: 'حفظ نسخة في ملف',
                          subtitle: 'آخر نسخة: ${_when(_lastFile)}',
                          onTap: _busy ? () {} : _saveFile,
                        ),
                        HubRow(
                          icon: Icons.restore,
                          title: 'استعادة من ملف',
                          subtitle:
                              'ملف نسخة بامتداد ${BackupService.extension}',
                          onTap: _busy ? () {} : _restoreFile,
                        ),
                      ],
                    ),
                    gap,
                    const SectionLabel('Google Drive'),
                    GroupList(
                      children: [
                        HubRow(
                          icon: Icons.cloud_upload_outlined,
                          title: 'رفع نسخة الآن',
                          subtitle:
                              connected
                                  ? 'آخر نسخة: ${_when(_lastDrive)}'
                                  : 'يطلب ربط حساب Google',
                          onTap: _busy ? () {} : _uploadDrive,
                        ),
                        FormRow(
                          'نسخ تلقائي يومي',
                          Switch(
                            value: _auto,
                            onChanged: (v) async {
                              await services.backup.setAutoDrive(v);
                              setState(() => _auto = v);
                              if (v && !services.auth.isConnected) {
                                await services.auth.connect();
                              }
                            },
                          ),
                        ),
                      ],
                    ),
                    if (_autoError != null && _auto)
                      Caption(
                        'تعذر آخر نسخ تلقائي: $_autoError',
                        color: Tw.danger,
                      ),
                    if (connected) ...[
                      gap,
                      SectionLabel(
                        'النسخ على Drive',
                        trailing: IconButton(
                          tooltip: 'تحديث',
                          onPressed: _busy ? null : _listDrive,
                          icon: Icon(Icons.refresh, size: 20, color: Tw.ink2),
                        ),
                      ),
                      if (_driveError != null)
                        Caption(_driveError!, color: Tw.danger)
                      else if (_drive == null)
                        const Padding(
                          padding: EdgeInsets.all(20),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else if (_drive!.isEmpty)
                        const Caption('لا نسخ على Drive بعد.')
                      else
                        GroupList(
                          children: [
                            for (final f in _drive!)
                              ListRow(
                                title:
                                    f.workspace.isEmpty ? f.name : f.workspace,
                                leading: IconChip(
                                  Icons.cloud_outlined,
                                  color: Tw.accentInk,
                                  bg: Tw.accentSoft,
                                ),
                                subtitle: Text(
                                  '${_when(f.createdAt)} · ${_size(f.size)}',
                                ),
                                trailing: const RowChevron(),
                                onTap:
                                    _busy
                                        ? null
                                        : () => showAppSheet<void>(
                                          context,
                                          (ctx) => AppSheet(
                                            title:
                                                f.workspace.isEmpty
                                                    ? 'نسخة'
                                                    : f.workspace,
                                            child: Column(
                                              children: [
                                                ChoiceTile(
                                                  icon: Icons.restore,
                                                  label:
                                                      'استعادة في مساحة العمل الحالية',
                                                  onTap: () {
                                                    Navigator.pop(ctx);
                                                    _restoreDrive(f);
                                                  },
                                                ),
                                                ChoiceTile(
                                                  icon: Icons.delete_outline,
                                                  label: 'حذف من Drive',
                                                  danger: true,
                                                  onTap: () {
                                                    Navigator.pop(ctx);
                                                    _run(
                                                      'جاري الحذف…',
                                                      () async {
                                                        await services.backup
                                                            .deleteFromDrive(
                                                              f.id,
                                                            );
                                                        await _listDrive();
                                                      },
                                                    );
                                                  },
                                                ),
                                              ],
                                            ),
                                          ),
                                        ),
                              ),
                          ],
                        ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
