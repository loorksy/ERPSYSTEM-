// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:async';
import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_services.dart';
import '../data/app_database.dart';
import '../data/file_import.dart';
import '../data/workbook_export.dart';
import '../erp/js_compat.dart';
import '../erp/normalize.dart';
import '../erp/payroll_audit_engine.dart';
import '../google/sheets_client.dart';
import '../services/cycle_service.dart';
import '../services/payroll_service.dart';
import 'erp_theme.dart';
import 'erp_widgets.dart';
import 'help.dart';
import 'period_actions.dart';
import 'spreadsheet_link.dart';
import 'ui_kit.dart';
import 'unaudited_dialog.dart';

const _draftKey = 'payrollAuditDraftV1';
const _localSource = '__local_file__';

/// ERP «تدقيق الرواتب» (`views/partials/payroll-google.ejs`) as the audit
/// screen of one period (owner's redesign): opened from the periods list.
class PayrollPage extends StatefulWidget {
  const PayrollPage({
    super.key,
    required this.cycleId,
    required this.onOpenSettings,
  });
  final int cycleId;
  final VoidCallback onOpenSettings;

  @override
  State<PayrollPage> createState() => PayrollPageState();
}

class PayrollPageState extends State<PayrollPage> {
  bool _ready = false;
  int _revision = -1;
  List<Cycle> _cycles = const [];
  String _cycleId = '';
  bool _optionsVisible = false;

  // Session banner
  bool? _sessionClosed;

  // User-info source
  String? _ssMessage = '— جاري التحميل... —';
  List<SpreadsheetFile> _spreadsheets = const [];
  String _spreadsheetId = '';
  ImportedFile? _localFile;
  List<String> _userInfoSheets = const [];
  String _userInfoSheet = '';

  // Columns
  List<ColumnOption> _cycleMgmtCols = CycleService.columnsFromHeader(const []);
  List<ColumnOption> _cycleAgentCols = CycleService.columnsFromHeader(const []);
  List<ColumnOption> _userInfoCols = CycleService.columnsFromHeader(const []);
  String _cycleMgmtUserIdCol = 'A';
  String _cycleAgentUserIdCol = 'A';
  String _cycleAgentSalaryCol = 'D';
  String _userInfoUserIdCol = 'C';
  String _userInfoTitleCol = 'D';
  String _userInfoSalaryCol = 'L';
  String _userInfoStatusCol = '';

  // Settings
  final _discount = TextEditingController(text: '0');
  String _agentColor = defaultAgentColor;
  String _mgmtColor = defaultManagementColor;

  // Run
  bool _running = false;
  String? _progress;
  AuditJob? _job;

  /// Result saved by the running job once prepared (duplicates list),
  /// read once per job instead of on every progress refresh.
  PayrollResult? _jobResult;
  int? _jobResultFor;
  Timer? _poll;
  PayrollResult? _result;
  bool _exporting = false;
  bool _loadingPending = false;

  /// Default columns of the workspace (Settings).
  WorkspaceColumns _ws = const WorkspaceColumns();
  int _columnsRevision = -1;

  AppServices get _s => AppScope.read(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final services = AppScope.of(context);
    final connected = services.auth.isConnected;
    if (!_ready) {
      _ready = true;
      _revision = services.cyclesRevision;
      _columnsRevision = services.columnsRevision;
      _connected = connected;
      _init();
      return;
    }
    if (services.columnsRevision != _columnsRevision) {
      // The workspace columns were changed in Settings: use them now.
      _columnsRevision = services.columnsRevision;
      _applyWorkspaceColumns();
    }
    if (services.cyclesRevision != _revision) {
      _revision = services.cyclesRevision;
      _reloadCycles();
    }
    if (connected != _connected) {
      // Google was connected or disconnected from Settings.
      _connected = connected;
      if (_optionsVisible) _loadSpreadsheetsList();
    }
  }

  bool _connected = false;

  @override
  void dispose() {
    _poll?.cancel();
    _discount.dispose();
    _tick.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    _ws = await _s.db.getWorkspaceColumns();
    await _loadSettings();
    await _loadCycles();
    if (!mounted) return;
    // Opening the period loads it from the phone; «مزامنة الدورة» (⋯)
    // reads Google again, and the audit itself syncs first like ERP.
    setState(() => _optionsVisible = true);
    if (!await _restoreDraft()) {
      await _loadSpreadsheetsList();
      await _loadCycleColumns();
    }
    await _useCycleUserInfo();
    await _refreshSession();
    await _watchJob();
  }

  // ------------------------------------------------------------ settings

  Future<void> _loadSettings() async {
    final s = await _s.db.getPayrollSettings();
    if (!mounted) return;
    setState(() {
      _discount.text = jsNumberToString(s.discountRate);
      _agentColor = s.agentColor;
      _mgmtColor = s.managementColor;
    });
  }

  Future<void> _saveSettings() async {
    final rate = jsParseFloat(_discount.text.trim());
    await _s.db.savePayrollSettings(
      PayrollSettings(
        discountRate: rate.isNaN ? 0 : rate,
        agentColor: _agentColor,
        managementColor: _mgmtColor,
      ),
    );
    if (!mounted) return;
    showToast(context, 'تم حفظ إعدادات التدقيق', ToastType.success);
    _saveDraft();
  }

  // -------------------------------------------------------------- cycles

  Future<void> _loadCycles() async {
    final list = await _s.db.listCycles();
    if (!mounted) return;
    setState(() {
      _cycles = list;
      _cycleId = '${widget.cycleId}';
    });
  }

  Future<void> _reloadCycles() async {
    final list = await _s.db.listCycles();
    if (!mounted) return;
    setState(() => _cycles = list);
    if (!_cycles.any((c) => '${c.id}' == _cycleId)) {
      // The period was deleted: back to the list.
      Navigator.of(context).maybePop();
      return;
    }
    await _refreshSession();
  }

  Cycle? get _cycle {
    for (final c in _cycles) {
      if ('${c.id}' == _cycleId) return c;
    }
    return null;
  }

  Future<void> _loadCycleColumns() async {
    if (_cycle == null) return;
    // The list holds light records; the header rows need the snapshot.
    final cycle = await _s.db.getCycle(_cycle!.id);
    if (cycle == null) return;
    // ERP `payrollLoadCycleColumns`: letters up to the widest first row (at
    // least 26), labelled with the header row for Google-linked cycles, and
    // reset to A / A / D.
    final mgmtFirst =
        cycle.managementRows.isEmpty
            ? const <String>[]
            : cycle.managementRows.first;
    final agentFirst =
        cycle.agentRows.isEmpty ? const <String>[] : cycle.agentRows.first;
    final width = [
      26,
      mgmtFirst.length,
      agentFirst.length,
    ].reduce((a, b) => a > b ? a : b);
    final fallback = [
      for (var i = 0; i < width; i++) ColumnOption(columnIndexToLetter(i), ''),
    ];
    if (!mounted) return;
    setState(() {
      _cycleMgmtCols =
          cycle.linkedToGoogle
              ? CycleService.columnsFromHeader(mgmtFirst)
              : fallback;
      _cycleAgentCols =
          cycle.linkedToGoogle
              ? CycleService.columnsFromHeader(agentFirst)
              : fallback;
      _cycleMgmtUserIdCol = _pickCol(_cycleMgmtCols, _ws.mgmtUserIdCol, 'A');
      _cycleAgentUserIdCol = _pickCol(_cycleAgentCols, _ws.agentUserIdCol, 'A');
      _cycleAgentSalaryCol = _pickCol(_cycleAgentCols, _ws.agentSalaryCol, 'D');
    });
  }

  /// Applies the workspace columns (Settings) to every column choice.
  Future<void> _applyWorkspaceColumns() async {
    final ws = await _s.db.getWorkspaceColumns();
    if (!mounted) return;
    setState(() {
      _ws = ws;
      _cycleMgmtUserIdCol = _pickCol(_cycleMgmtCols, ws.mgmtUserIdCol, 'A');
      _cycleAgentUserIdCol = _pickCol(_cycleAgentCols, ws.agentUserIdCol, 'A');
      _cycleAgentSalaryCol = _pickCol(_cycleAgentCols, ws.agentSalaryCol, 'D');
      _userInfoUserIdCol = _pickCol(_userInfoCols, ws.userInfoUserIdCol, 'C');
      _userInfoTitleCol = _pickCol(_userInfoCols, ws.userInfoTitleCol, 'D');
      _userInfoSalaryCol = _pickCol(_userInfoCols, ws.userInfoSalaryCol, 'L');
      _userInfoStatusCol =
          _userInfoCols.any((c) => c.letter == ws.userInfoStatusCol)
              ? ws.userInfoStatusCol
              : '';
    });
    _saveDraft();
  }

  static String _pickCol(
    List<ColumnOption> cols,
    String? wanted,
    String fallback,
  ) {
    if (wanted != null && cols.any((c) => c.letter == wanted)) return wanted;
    if (cols.any((c) => c.letter == fallback)) return fallback;
    return cols.isEmpty ? fallback : cols.first.letter;
  }

  // ------------------------------------------------------------- session

  Future<void> _refreshSession() async {
    final cycle =
        _cycleId.isEmpty ? null : await _s.db.getCycleInfo(int.parse(_cycleId));
    if (!mounted) return;
    setState(
      () => _sessionClosed = cycle == null ? null : cycle.auditClosedAt != null,
    );
  }

  Future<void> _setSession(bool close) async {
    if (_cycleId.isEmpty) {
      showToast(context, 'اختر الدورة أولاً', ToastType.error);
      return;
    }
    await _s.db.setAuditClosed(int.parse(_cycleId), close);
    if (!mounted) return;
    showToast(
      context,
      close ? 'أُقفل التدقيق' : 'أُعيد فتح التدقيق',
      ToastType.success,
    );
    _s.cyclesChanged();
    await _refreshSession();
  }

  // ---------------------------------------------------- user-info source

  Future<void> _loadSpreadsheetsList() async {
    setState(() => _ssMessage = '— جاري التحميل... —');
    try {
      final list = await _s.sheets.listSpreadsheets();
      if (!mounted) return;
      setState(() {
        _spreadsheets = [
          ...list,
          for (final f in _spreadsheets)
            if (!list.any((x) => x.id == f.id)) f,
        ];
        _ssMessage = null;
      });
    } catch (e) {
      if (mounted) setState(() => _ssMessage = e.toString());
    }
  }

  /// «تحديث القوائم»: the spreadsheets, then the sheets and column names
  /// of the chosen user-info spreadsheet.
  Future<void> _refreshGoogleLists() async {
    await _loadSpreadsheetsList();
    if (_spreadsheetId.isNotEmpty && _spreadsheetId != _localSource) {
      await _loadUserInfoSheetsAndColumns(
        _spreadsheetId,
        _userInfoSheet.isEmpty ? null : _userInfoSheet,
      );
    }
  }

  Future<void> _onSourceChanged(String picked) async {
    var v = picked;
    if (v == pasteLinkValue) {
      final f = await askSpreadsheetLink(context, _s.sheets);
      if (f == null || !mounted) return;
      setState(() {
        _spreadsheets = [f, ..._spreadsheets.where((x) => x.id != f.id)];
        _ssMessage = null;
      });
      v = f.id;
    }
    if (v == _localSource) {
      try {
        final f = await pickSpreadsheetFile();
        if (!mounted) return;
        if (f == null) {
          if (_localFile == null) setState(() => _spreadsheetId = '');
          return;
        }
        setState(() {
          _localFile = f;
          _spreadsheetId = _localSource;
          _userInfoSheets = f.sheetNames;
          _userInfoSheet = '';
        });
        _applyUserInfoColumns(
          f.firstSheetRows.isEmpty ? const [] : f.firstSheetRows.first,
        );
        _saveDraft();
      } catch (e) {
        if (mounted) showToast(context, e.toString(), ToastType.error);
      }
      return;
    }
    setState(() {
      _spreadsheetId = v;
      _userInfoSheet = '';
      _userInfoSheets = const [];
    });
    if (v.isNotEmpty) await _loadUserInfoSheetsAndColumns(v, null);
    _saveDraft();
  }

  Future<void> _loadUserInfoSheetsAndColumns(
    String spreadsheetId,
    String? sheetName,
  ) async {
    if (spreadsheetId == _localSource) {
      final f = _localFile;
      if (f == null) return;
      final rows = f.rowsOf(sheetName);
      _applyUserInfoColumns(rows.isEmpty ? const [] : rows.first);
      return;
    }
    try {
      final meta = await _s.sheets.getSpreadsheet(spreadsheetId);
      if (!mounted) return;
      setState(() => _userInfoSheets = [for (final s in meta.sheets) s.title]);
      // The saved sheet was deleted or renamed in Google (owner's report:
      // Google only said «Unable to parse range»).
      if (sheetName != null &&
          sheetName.isNotEmpty &&
          !_userInfoSheets.contains(sheetName)) {
        showToast(
          context,
          'الورقة «$sheetName» غير موجودة في «${meta.title ?? 'جدول بيانات المستخدمين'}»؛ ربما حُذفت أو تغيّر اسمها. اختر الورقة من «إعداد التدقيق» ← «الورقة».',
          ToastType.warning,
        );
        return;
      }
      final cols = await _s.cycles.googleColumns(spreadsheetId, sheetName);
      if (!mounted) return;
      _applyColumnOptions(cols);
    } catch (e) {
      if (mounted) showToast(context, e.toString(), ToastType.warning);
    }
  }

  void _applyUserInfoColumns(List<String> header) =>
      _applyColumnOptions(CycleService.columnsFromHeader(header));

  void _applyColumnOptions(List<ColumnOption> cols) {
    setState(() {
      _userInfoCols = cols;
      _userInfoUserIdCol = _pickCol(cols, _ws.userInfoUserIdCol, 'C');
      _userInfoTitleCol = _pickCol(cols, _ws.userInfoTitleCol, 'D');
      _userInfoSalaryCol = _pickCol(cols, _ws.userInfoSalaryCol, 'L');
      _userInfoStatusCol =
          cols.any((c) => c.letter == _ws.userInfoStatusCol)
              ? _ws.userInfoStatusCol
              : '';
    });
  }

  // --------------------------------------------------------------- draft

  Future<void> _saveDraft() async {
    if (_cycleId.isEmpty) return;
    final draft = {
      'cycleId': _cycleId,
      'spreadsheetId': _spreadsheetId == _localSource ? '' : _spreadsheetId,
      'userInfoSheetName': _spreadsheetId == _localSource ? '' : _userInfoSheet,
      'userInfoUserIdCol': _userInfoUserIdCol,
      'userInfoTitleCol': _userInfoTitleCol,
      'userInfoSalaryCol': _userInfoSalaryCol,
      'userInfoStatusCol': _userInfoStatusCol,
      'cycleMgmtUserIdCol': _cycleMgmtUserIdCol,
      'cycleAgentUserIdCol': _cycleAgentUserIdCol,
      'cycleAgentSalaryCol': _cycleAgentSalaryCol,
      'discountRate': _discount.text,
      'agentColor': _agentColor,
      'managementColor': _mgmtColor,
    };
    await _s.db.setValue(_draftKey, jsonEncode(draft));
  }

  /// The last choices (source, columns, discount, colours) as defaults;
  /// the period stays the one of this screen.
  Future<bool> _restoreDraft() async {
    final raw = await _s.db.getValue(_draftKey);
    if (raw == null || !mounted) return false;
    Map<String, dynamic> d;
    try {
      d = Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      return false;
    }
    await _loadSpreadsheetsList();
    final ss = d['spreadsheetId']?.toString() ?? '';
    if (ss.isNotEmpty) {
      setState(() {
        _spreadsheetId = ss;
        _userInfoSheet = d['userInfoSheetName']?.toString() ?? '';
      });
      await _loadUserInfoSheetsAndColumns(
        ss,
        _userInfoSheet.isEmpty ? null : _userInfoSheet,
      );
    }
    await _loadCycleColumns();
    if (!mounted) return true;
    String pick(List<ColumnOption> cols, String key, String current) {
      final v = d[key]?.toString();
      return v != null && cols.any((c) => c.letter == v) ? v : current;
    }

    setState(() {
      _userInfoUserIdCol = pick(
        _userInfoCols,
        'userInfoUserIdCol',
        _userInfoUserIdCol,
      );
      _userInfoTitleCol = pick(
        _userInfoCols,
        'userInfoTitleCol',
        _userInfoTitleCol,
      );
      _userInfoSalaryCol = pick(
        _userInfoCols,
        'userInfoSalaryCol',
        _userInfoSalaryCol,
      );
      final st = d['userInfoStatusCol']?.toString() ?? '';
      _userInfoStatusCol =
          st.isEmpty || _userInfoCols.any((c) => c.letter == st) ? st : '';
      _cycleMgmtUserIdCol = pick(
        _cycleMgmtCols,
        'cycleMgmtUserIdCol',
        _cycleMgmtUserIdCol,
      );
      _cycleAgentUserIdCol = pick(
        _cycleAgentCols,
        'cycleAgentUserIdCol',
        _cycleAgentUserIdCol,
      );
      _cycleAgentSalaryCol = pick(
        _cycleAgentCols,
        'cycleAgentSalaryCol',
        _cycleAgentSalaryCol,
      );
      if (d['discountRate'] != null) {
        _discount.text = d['discountRate'].toString();
      }
      final ac = d['agentColor']?.toString();
      final mc = d['managementColor']?.toString();
      if (ac != null && ac.length == 7) _agentColor = ac;
      if (mc != null && mc.length == 7) _mgmtColor = mc;
    });
    return true;
  }

  // ----------------------------------------------------------------- run

  /// ERP `payrollRunAudit`: 1/2 sync (cycle + user-info snapshot), then
  /// 2/2 `payroll-execute`. A file from the phone runs the same audit
  /// locally instead.
  Future<void> _runAudit({bool full = false}) async {
    final request = await _buildRequest(full: full);
    if (request == null || !mounted) return;
    final source = request.userInfo;

    if (source is GoogleUserInfo) {
      // Runs in the background (continues when the app is closed and
      // resumes after a lost connection); this page follows its progress.
      if (!await _noActiveJob()) return;
      await _s.startAuditJob(request);
      if (!mounted) return;
      setState(() => _result = null);
      await _watchJob();
      return;
    }

    setState(() {
      _running = true;
      _progress = 'تدقيق على الهاتف...';
    });
    try {
      final result = await _s.payroll.execute(
        request,
        onProgress: (m) {
          if (mounted) setState(() => _progress = m);
        },
      );
      if (!mounted) return;
      _s.cyclesChanged();
      _announce(result);
      await _refreshSession();
    } finally {
      if (mounted) {
        setState(() {
          _running = false;
          _progress = null;
        });
      }
    }
  }

  /// One background job at a time (the audit and the «غير مذكور» tools).
  Future<bool> _noActiveJob() async {
    final active = [
      for (final j in await _s.db.pendingAuditJobs())
        if (j.cycleId != null) j,
    ];
    if (!mounted) return false;
    if (active.isEmpty) return true;
    showToast(
      context,
      'يوجد تدقيق قيد التنفيذ. انتظر انتهاءه ثم أعد المحاولة.',
      ToastType.warning,
    );
    await _watchJob();
    return false;
  }

  /// The audit request from the page (cycle, user-info source, columns,
  /// discount and colours); saves the cycle columns like ERP.
  Future<PayrollRequest?> _buildRequest({bool full = false}) async {
    if (_cycleId.isEmpty || _spreadsheetId.isEmpty) {
      showToast(
        context,
        'اختر الدورة ومصدر بيانات المستخدمين أولاً',
        ToastType.error,
      );
      return null;
    }
    UserInfoSource source;
    if (_spreadsheetId == _localSource) {
      final f = _localFile;
      if (f == null) {
        showToast(
          context,
          'اختر ملف بيانات المستخدمين من الجهاز',
          ToastType.error,
        );
        return null;
      }
      final sheetName =
          _userInfoSheet.isEmpty ? f.sheetNames.first : _userInfoSheet;
      source = LocalUserInfo(f.fileName, sheetName, f.rowsOf(sheetName));
    } else {
      source = GoogleUserInfo(
        _spreadsheetId,
        _userInfoSheet.isEmpty ? null : _userInfoSheet,
      );
    }
    final cycleId = int.parse(_cycleId);
    await _s.db.saveCycleColumns(
      cycleId,
      CycleColumns(
        mgmtUserIdCol: _cycleMgmtUserIdCol,
        agentUserIdCol: _cycleAgentUserIdCol,
        agentSalaryCol: _cycleAgentSalaryCol,
      ),
    );
    if (!mounted) return null;
    final rawDiscount = _discount.text.trim();
    final parsed = rawDiscount.isEmpty ? null : jsParseFloat(rawDiscount);
    final request = PayrollRequest(
      cycleId: cycleId,
      userInfo: source,
      discountRate: parsed == null || parsed.isNaN ? null : parsed,
      agentColor: _agentColor,
      managementColor: _mgmtColor,
      columns: AuditColumns.of(
        userInfoUserIdCol: _userInfoUserIdCol,
        userInfoTitleCol: _userInfoTitleCol,
        userInfoSalaryCol: _userInfoSalaryCol,
        cycleMgmtUserIdCol: _cycleMgmtUserIdCol,
        cycleAgentUserIdCol: _cycleAgentUserIdCol,
        cycleAgentSalaryCol: _cycleAgentSalaryCol,
      ),
      userInfoStatusCol: _userInfoStatusCol.isEmpty ? null : _userInfoStatusCol,
      // Owner's request: an empty agency name goes to «غير مذكور».
      emptyTitle: _ws.unmentionedLabel,
      // Owner's request (3.3.0): a period audited before gets only its new
      // information audited, unless the full audit is asked for.
      forceReaudit: full,
      // Owner's request (3.4.0): a cycle without a management sheet.
      withoutManagement: _noMgmt,
    );
    _saveDraft();
    return request;
  }

  /// Owner's «غير مذكور» tools: a background job like the audit.
  Future<void> _runTool(String kind) async {
    if (_spreadsheetId == _localSource) {
      showToast(
        context,
        'هذه الأداة تعمل على جداول Google فقط. اختر جدول بيانات المستخدمين من Google.',
        ToastType.warning,
      );
      return;
    }
    if (!(_cycle?.linkedToGoogle ?? false)) {
      showToast(
        context,
        'هذا الإجراء متاح لدورات Google فقط.',
        ToastType.warning,
      );
      return;
    }
    final ws = await _s.db.getWorkspaceColumns();
    if (!mounted) return;
    final label = ws.unmentionedLabel;
    final users = kind == JobKind.unmentionedUsers;
    final idCols = {_userInfoUserIdCol, ...ws.unmentionedIdCols}.join(' و');
    final labelCols = {
      _userInfoTitleCol,
      ...ws.unmentionedLabelCols,
    }.where((c) => !ws.unmentionedIdCols.contains(c)).join(' و');
    final ok = await confirmDialog(
      context,
      icon: users ? Icons.person_add_alt_outlined : Icons.input_outlined,
      title: users ? 'تدقيق غير المذكورين' : 'سحب صفوف الإدارة إلى «$label»',
      body:
          users
              ? 'سيُضاف كل رقم في ورقة الوكيل غير موجود في جدول بيانات المستخدمين مرة واحدة فقط (حتى لو له أكثر من راتب)، في صف جديد بعد آخر صف: الرقم في العمود $idCols، و«$label» في العمود $labelCols.\n\nثم تُدقق هذه الصفوف بنفس منطق التدقيق: تُنسخ صفوفها من ورقة الإدارة إلى ورقة «$label» (حسب عمود $_userInfoTitleCol)، ويُكتب الراتب والحالة، وتُلوّن. لا تتغير الصفوف الموجودة.'
              : 'ستُنسخ صفوف ورقة الإدارة غير الملوّنة (غير المدققة) التي فيها مبلغ غير صفري في العمود ${ws.mgmtShareCol}، وصاحبها غير موجود في جدول بيانات المستخدمين، إلى ورقة «$label» في جدول الإدارة (تُنشأ إن لم تكن موجودة).\n\nتُلوّن الصفوف المنقولة بلون غير المذكورين (من الإعدادات) في ورقة الإدارة وفي «$label»، حتى تتميز ولا تُسحب مرة أخرى. يُفضّل تنفيذ «تدقيق غير المذكورين» قبلها.',
      confirmLabel: users ? 'إضافة وتدقيق' : 'سحب الصفوف',
    );
    if (!ok || !mounted) return;
    final request = await _buildRequest();
    if (request == null || !mounted) return;
    if (!await _noActiveJob()) return;
    await _s.startAuditJob(
      request,
      kind: kind,
      unmentioned: UnmentionedOptions(
        label: label,
        idCols: ws.unmentionedIdCols,
        labelCols: ws.unmentionedLabelCols,
        shareCol: ws.mgmtShareCol,
        color: ws.unmentionedColor,
      ),
    );
    if (!mounted) return;
    setState(() => _result = null);
    await _watchJob();
  }

  /// Shows the outcome of an audit like ERP (toast + results section).
  void _announce(PayrollResult result) {
    if (!result.success) {
      showToast(context, result.message, ToastType.error);
      return;
    }
    setState(() => _result = result);
    var toast = result.message;
    if (result.cycleSynced && !toast.contains('تمت مزامنة جداول الدورة')) {
      toast = 'تمت مزامنة جداول الدورة من Google ثم $toast';
    }
    if (result.duplicates.isNotEmpty) {
      toast +=
          ' — ${result.duplicates.length} رقم مكرر في جدول بيانات المستخدمين (انظر التفاصيل)';
    }
    showToast(
      context,
      toast,
      result.applied ? ToastType.success : ToastType.warning,
    );
  }

  // ----------------------------------------------------- background job

  /// Follows the latest audit job of the selected cycle.
  Future<void> _watchJob() async {
    _poll?.cancel();
    if (_cycleId.isEmpty) {
      setState(() => _job = null);
      return;
    }
    final job = await _s.db.latestAuditJob(int.parse(_cycleId));
    if (!mounted) return;
    setState(() => _job = job);
    if (job == null) return;
    if (job.active) {
      _poll = Timer.periodic(const Duration(seconds: 1), (_) => _pollJob());
    } else {
      await _settleJob(job);
    }
  }

  Future<void> _pollJob() async {
    final current = _job;
    if (current == null) return;
    final job = await _s.db.getAuditJob(current.id);
    if (!mounted || job == null) return;
    setState(() => _job = job);
    if (job.active && job.stepTotal > 0 && _jobResultFor != job.id) {
      _jobResultFor = job.id;
      final json = await _s.db.getAuditJobResult(job.id);
      if (mounted && json != null) {
        setState(() => _jobResult = PayrollResult.fromJson(json));
      }
    }
    if (!job.active) {
      _poll?.cancel();
      await _settleJob(job);
      _s.cyclesChanged();
      await _refreshSession();
    } else if (job.status == AuditJob.queued &&
        DateTime.now().difference(job.updatedAt).inSeconds > 20) {
      // The worker has not picked the job up yet: make sure it is scheduled.
      await _s.resumeAuditJobs();
    }
  }

  /// A finished job: announce it once, and keep showing its result.
  Future<void> _settleJob(AuditJob job) async {
    final json = await _s.db.getAuditJobResult(job.id);
    if (!mounted) return;
    final result = json == null ? null : PayrollResult.fromJson(json);
    if (!job.seen) {
      await _s.db.updateAuditJob(job.id, {'seen': 1});
      if (!mounted) return;
      if (result != null) {
        _announce(result);
      } else if (job.error != null) {
        showToast(context, job.error!, ToastType.error);
      }
    } else if (result != null && result.success && _result == null) {
      setState(() => _result = result);
    }
  }

  /// The followed job is one of the «غير مذكور» tools (not the audit).
  bool get _toolJob =>
      _job != null && JobKind.of(_job!.request) != JobKind.audit;

  /// Owner's request: agent-sheet ids not audited yet, on demand (read only).
  Future<void> _showUnaudited() async {
    if (_cycleId.isEmpty) return;
    setState(() => _loadingPending = true);
    try {
      final data = await _s.payroll.unauditedAgentMembers(int.parse(_cycleId));
      if (!mounted) return;
      await showUnauditedDialog(context, data);
    } catch (e) {
      if (mounted) showToast(context, e.toString(), ToastType.error);
    } finally {
      if (mounted) setState(() => _loadingPending = false);
    }
  }

  Future<void> _resumeNow() async {
    await _s.resumeAuditJobs(now: true);
    if (mounted) showToast(context, 'جاري استئناف التدقيق...', ToastType.info);
  }

  Future<void> _export() async {
    final cycle =
        _cycleId.isEmpty ? null : await _s.db.getCycle(int.parse(_cycleId));
    if (cycle == null) return;
    setState(() => _exporting = true);
    try {
      final state = LocalWorkbookState.fromJson(
        await _s.db.getLocalWorkbook(cycle.id),
      );
      final bytes = WorkbookExport.encode(cycle, state);
      final date = DateTime.now().toIso8601String().substring(0, 10);
      final safeName = cycle.name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
      final saved = await FilePicker.platform.saveFile(
        dialogTitle: 'حفظ نتائج التدقيق',
        fileName: 'تدقيق $safeName - $date.xlsx',
        type: FileType.custom,
        allowedExtensions: const ['xlsx'],
        bytes: bytes,
      );
      if (saved != null && mounted) {
        showToast(context, 'تم حفظ ملف Excel', ToastType.success);
      }
    } catch (e) {
      if (mounted) {
        showToast(context, 'تعذر تصدير النتائج: $e', ToastType.error);
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  // ------------------------------------------------------------------ UI
  //
  // Owner's mockup (`docs/design/almudaqqiq-redesign.html`, `screenAudit`):
  // a back link to the periods, the period's name and facts, then what
  // fits its state — ready (the strip, «بيانات المستخدمين» and «إعداد
  // التدقيق» rows that open sheets, «بدء التدقيق»), running (the run card
  // with the step and «استئناف الآن»), done (the results card, the
  // follow-up tools, «إعداد التدقيق والتشخيص» and «إعادة التدقيق»). The
  // period's actions are in ⋯, explanations behind one «؟».

  bool get _jobRunning => _running || (_job?.active ?? false);

  /// Rebuilds the open sheets (source, settings) with the page.
  final _tick = ValueNotifier<int>(0);

  /// A cycle made without a management sheet carries its user-info sheet
  /// (chosen in the cycle form, 3.4.0): the audit starts from it.
  Future<void> _useCycleUserInfo() async {
    final c = _cycle;
    final ss = c?.userInfoSpreadsheetId;
    if (c == null || !c.withoutManagement || ss == null || !mounted) return;
    if (_spreadsheetId == ss && _userInfoSheet == (c.userInfoSheetName ?? '')) {
      return;
    }
    setState(() {
      _spreadsheetId = ss;
      _userInfoSheet = c.userInfoSheetName ?? '';
    });
    await _loadUserInfoSheetsAndColumns(
      ss,
      _userInfoSheet.isEmpty ? null : _userInfoSheet,
    );
  }

  /// A cycle made without a management sheet is audited without it
  /// (3.4.0, decided in the cycle form).
  bool get _noMgmt => _cycle?.withoutManagement ?? false;

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    _tick.value++;
  }

  Future<void> _periodAction(PeriodAction action) async {
    final cycle = _cycle;
    if (cycle == null) return;
    final deleted = await runPeriodAction(context, cycle, action);
    if (!mounted) return;
    if (deleted) {
      Navigator.of(context).maybePop();
      return;
    }
    if (action == PeriodAction.sync) await _loadCycleColumns();
    await _refreshSession();
  }

  List<HelpItem> _help() {
    final label = _ws.unmentionedLabel;
    return [
      const HelpItem(
        '',
        'الدورة بلا جدول إدارة (اختيار «بدون جدول الإدارة» عند إنشائها أو تعديلها) تُدقق بجدولي بيانات المستخدمين والوكيل فقط، وتبدأ بجدول بيانات المستخدمين المختار معها. من له راتب في الوكيل «سحب وكالة» ويُكتب راتبه بعد الخصم، ومن رقمه في الوكيل وراتبه 0 «بدون راتب» (الراتب 0)، ومن ليس في الوكيل «غير موجود». لا يُنسخ شيء إلى أوراق الوكالات، وتُلوَّن صفوف الوكيل فقط، وأداة «٢. نقل سجلات الإدارة» لا تظهر',
      ),
      const HelpItem(
        '',
        'اختر مصدر بيانات المستخدمين: جدولًا من Google Sheets أو ملفًا من الجهاز، أو الصق رابط جدول Google. يُحفظ اختيارك على الهاتف.',
      ),
      const HelpItem(
        '',
        'في «إعداد التدقيق» أعمدة رقم المستخدم والراتب في جدولي الإدارة والوكيل، وورقة بيانات المستخدمين وأعمدتها، ونسبة الخصم، ولونا الوكيل والإدارة. القيم الافتراضية من «ربط حقول البيانات»، و«حفظ كإعداد افتراضي» يجعل الخصم واللونين الافتراضي.',
      ),
      const HelpItem(
        '',
        'تدقيق Google يزامن جداول الدورة وبيانات المستخدمين، ثم ينسخ كل سجل إلى ورقة وكالته في جدول الإدارة، ويكتب الراتب بعد الخصم والحالة، ويلوّن السجلات. يكمل في الخلفية حتى لو أغلقت التطبيق، ويُستأنف من الخطوة نفسها إذا انقطع الإنترنت. التدقيق من ملف يُحسب على الهاتف ولا يكتب شيئًا في Google، وتُصدَّر نتائجه إلى Excel.',
      ),
      const HelpItem(
        '',
        'بعد أول تدقيق ناجح، «تدقيق المعلومات الجديدة» يدقق فقط من ليس «مدققًا» في الدورة: الصفوف المضافة بعد التدقيق (في بيانات المستخدمين أو الإدارة أو الوكيل)، ومن لم يُعثر عليه من قبل. لا يعيد كتابة رواتب وحالات المدققين ولا تلوينهم ولا نسخهم إلى جدول الإدارة. «تدقيق كامل من البداية» يعيد كل شيء كما في النظام.',
      ),
      const HelpItem(
        '',
        'زر التحديث ⟳ في أعلى ورقة المصدر وورقة الإعداد يعيد جلب الجداول والأوراق وأسماء الأعمدة من Google دون إغلاق التطبيق.',
      ),
      const HelpItem(
        '',
        'الشريط الملوّن بلوني الوكيل والإدارة من الإعداد، والمخطط لغير الموجود. السجلات المكررة في بيانات المستخدمين تُدقق مرة واحدة ويُكتب في الصفوف الأخرى «مكرر (الصف N)». «تشخيص المطابقة» يعرض أعداد الأرقام وعينات للمقارنة عند عدم التطابق.',
      ),
      HelpItem(
        '',
        'أدوات بعد التدقيق (بعد تدقيق كامل أو جزئي): «السجلات غير المدققة» في جدول الوكيل للاطلاع والنسخ فقط. «١» تضيف أرقام الوكيل غير الموجودة في بيانات المستخدمين مرة واحدة بعنوان «$label» ثم تدققها، و«٢» تنقل سجلات الإدارة غير الملوّنة التي فيها مبلغ في ${_ws.mgmtShareCol} إلى «$label» وتلوّنها بلون غير المذكورين. يُفضّل تنفيذ «١» أولًا. تعملان على جداول Google فقط وتطلبان تأكيدًا قبل الكتابة.',
      ),
      const HelpItem(
        '',
        '«إقفال التدقيق» من «⋯» يعلّم الدورة كمنتهية على هذا الجهاز، ويمكن إعادة فتحه في أي وقت.',
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final cycle = _cycle;
    final running = _jobRunning && !_toolJob;
    final done = !running && _result != null;
    final closed = _sessionClosed == true;
    return Directionality(
      textDirection: TextDirection.rtl,
      child: PopScope(
        // An audit from a file runs on this screen: stay until it ends.
        canPop: !_running,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) {
            showToast(
              context,
              'انتظر حتى ينتهي التدقيق على الهاتف',
              ToastType.info,
            );
          }
        },
        child: ColoredBox(
          color: Tw.paper,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              _topBar(cycle),
              if (cycle != null) _head(cycle),
              if (closed) _lockBanner(),
              if (running) ...[
                _pad(_runCard(_job ?? _localJobPlaceholder()), top: 18),
                _section(child: _setupRows(enabled: false)),
              ] else if (done) ...[
                _pad(_resultsCard(), top: 18),
                _section(child: _tools(), title: 'أدوات بعد التدقيق'),
                _section(child: _details()),
              ] else ...[
                _readyBlock(),
                _section(child: _setupRows()),
                _pad(_startButton(), top: 16),
                _section(
                  child: Disclosure(
                    title: 'أدوات بعد التدقيق',
                    child: Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: _tools(),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _pad(Widget child, {double top = 0}) =>
      Padding(padding: EdgeInsets.fromLTRB(16, top, 16, 0), child: child);

  /// `.section`: 26 px above, 16 px sides, an optional title.
  Widget _section({required Widget child, String? title}) => Padding(
    padding: EdgeInsets.fromLTRB(16, title == null ? 26 : 12, 16, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [if (title != null) SectionLabel(title), child],
    ),
  );

  /// `.topbar`: «الدورات» back link, «؟» and ⋯.
  Widget _topBar(Cycle? cycle) => SizedBox(
    height: 54,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(6, 4, 6, 0),
      child: Row(
        children: [
          TextButton.icon(
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.chevron_right, size: 22),
            label: const Text('الدورات', style: TextStyle(fontSize: 16)),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(44, 44),
            ),
          ),
          const Spacer(),
          HelpButton(title: 'تدقيق الدورة', items: _help),
          if (cycle != null)
            PeriodMenu(
              cycle: cycle,
              fromAudit: true,
              onSelected: _periodAction,
            ),
        ],
      ),
    ),
  );

  /// `.phead`: name, source and the period's facts.
  Widget _head(Cycle cycle) {
    final b = TextStyle(fontWeight: FontWeight.w700, color: Tw.ink);
    TextSpan fact(String label, String value) => TextSpan(
      children: [TextSpan(text: '$label '), TextSpan(text: value, style: b)],
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 2, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(periodName(cycle), style: Ds.screenTitle),
          const SizedBox(height: 4),
          Text(
            cycle.linkedToGoogle
                ? 'من ${ltr('Google Sheets')}'
                : 'من ملفات محلية على الهاتف',
            style: TextStyle(fontSize: 14.5, color: Tw.ink2),
          ),
          const SizedBox(height: 4),
          DefaultTextStyle.merge(
            style: TextStyle(fontSize: 14, color: Tw.ink2),
            child: Wrap(
              spacing: 16,
              runSpacing: 2,
              children: [
                Text.rich(
                  fact('سجلات الإدارة', formatCount(cycle.managementCount)),
                ),
                Text.rich(fact('سجلات الوكيل', formatCount(cycle.agentCount))),
                if (cycle.transferDiscountPct > 0)
                  Text.rich(
                    fact(
                      'خصم التحويل',
                      ltr('${jsNumberToString(cycle.transferDiscountPct)}%'),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// `.banner`: the audit of this period is locked.
  Widget _lockBanner() => Container(
    margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    decoration: BoxDecoration(
      color: Tw.neutralSoft,
      borderRadius: BorderRadius.circular(18),
    ),
    child: Row(
      children: [
        Icon(Icons.lock_outline, size: 22, color: Tw.ink2),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'التدقيق مُقفل لهذه الدورة',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: Tw.ink,
                ),
              ),
              Text(
                'علامة على هذا الهاتف بأن الدورة انتهت. النتائج والأدوات متاحة.',
                style: TextStyle(fontSize: 13, color: Tw.ink2),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        ErpButton(
          label: 'إعادة فتح',
          kind: ErpButtonKind.indigoSoft,
          height: 40,
          expand: false,
          onPressed: () => _setSession(false),
        ),
      ],
    ),
  );

  // ------------------------------------------------------------- ready

  /// `.ready`: the empty strip and what to do next.
  Widget _readyBlock() {
    final failed = _job != null && !_toolJob && _job!.status == AuditJob.failed;
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 22, 22, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ResultStrip(parts: []),
          const SizedBox(height: 12),
          Text(
            _spreadsheetId.isNotEmpty
                ? 'جاهزة للتدقيق. راجع الإعداد إن احتجت ثم ابدأ.'
                : 'اختر مصدر بيانات المستخدمين لبدء التدقيق.',
            style: TextStyle(fontSize: 14.5, color: Tw.ink2),
          ),
          if (failed && _job!.error != null) ...[
            const SizedBox(height: 10),
            NoticeBox(
              bg: Tw.dangerSoft,
              child: Text(
                'تعذّر التدقيق السابق: ${_job!.error}',
                style: TextStyle(color: Tw.danger),
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _sourceName() {
    if (_spreadsheetId == _localSource) {
      return '${_localFile?.fileName ?? 'ملف'}، من الجهاز';
    }
    final name =
        _spreadsheets
            .where((f) => f.id == _spreadsheetId)
            .map((f) => f.name)
            .firstOrNull ??
        _spreadsheetId;
    final sheet = _userInfoSheet.isEmpty ? '' : ' ($_userInfoSheet)';
    return '$name$sheet، من ${ltr('Google Sheets')}';
  }

  String _discountText() {
    final d = _discount.text.trim();
    return ltr('${d.isEmpty ? '0' : d}%');
  }

  /// The two rows that open the source and the audit settings.
  Widget _setupRows({bool enabled = true}) => GroupList(
    children: [
      ListRow(
        enabled: enabled,
        leading: IconChip(Icons.table_chart_outlined),
        title: 'بيانات المستخدمين',
        subtitle:
            _spreadsheetId.isEmpty
                ? Text(
                  'اختر جدولًا من Google أو ملفًا من الجهاز',
                  style: TextStyle(color: Tw.warn),
                )
                : Text(_sourceName()),
        trailing: const RowChevron(),
        onTap: _openSourceSheet,
      ),
      ListRow(
        enabled: enabled,
        leading: IconChip(Icons.tune),
        title: 'إعداد التدقيق',
        subtitle: Text(
          _noMgmt
              ? 'بدون الإدارة، الوكيل ${ltr('$_cycleAgentUserIdCol/$_cycleAgentSalaryCol')}، المستخدم $_userInfoUserIdCol، الراتب $_userInfoSalaryCol، خصم ${_discountText()}'
              : 'الإدارة $_cycleMgmtUserIdCol، الوكيل ${ltr('$_cycleAgentUserIdCol/$_cycleAgentSalaryCol')}، المستخدم $_userInfoUserIdCol، الراتب $_userInfoSalaryCol، خصم ${_discountText()}',
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ColorDots([
              hexColor(_agentColor),
              if (!_noMgmt) hexColor(_mgmtColor),
            ]),
            const SizedBox(width: 6),
            const RowChevron(),
          ],
        ),
        onTap: _openConfigSheet,
      ),
    ],
  );

  Widget _startButton() {
    final local = _spreadsheetId == _localSource;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ErpButton(
          label: 'بدء التدقيق',
          icon: Icons.play_arrow_rounded,
          loading: _running,
          loadingLabel: _progress ?? 'جاري التدقيق...',
          onPressed:
              _spreadsheetId.isNotEmpty && !_jobRunning ? _runAudit : null,
        ),
        Caption(
          local
              ? 'يُحسب التدقيق على الهاتف من الملف المختار، ولا يُكتب شيء في Google.'
              : 'يكمل التدقيق في الخلفية حتى لو أغلقت التطبيق.',
          center: true,
        ),
      ],
    );
  }

  // ----------------------------------------------------------- running

  /// A local (on-phone) audit has no job: its progress is [_progress].
  AuditJob _localJobPlaceholder() => AuditJob(
    id: -1,
    cycleId: _cycle?.id,
    status: AuditJob.running,
    request: const {},
    stepNext: 0,
    stepTotal: 0,
    progress: _progress,
    error: null,
    attempts: 0,
    seen: true,
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
  );

  /// `.run-card`: a running or paused job (the audit or a follow-up tool).
  Widget _runCard(AuditJob job, {bool compact = false}) {
    final waiting = job.status == AuditJob.waiting;
    final kind = JobKind.of(job.request);
    final total = job.stepTotal;
    final done = job.stepNext.clamp(0, total);
    final duplicates =
        _jobResultFor == job.id && _jobResult != null
            ? _jobResult!.duplicates
            : const <DuplicateGroup>[];
    final title =
        waiting
            ? 'بانتظار الاتصال'
            : kind == JobKind.audit
            ? 'جاري التدقيق'
            : 'جاري ${JobKind.title(kind)}';
    final local = job.id == -1;
    return Container(
      padding: EdgeInsets.fromLTRB(20, compact ? 14 : 18, 20, 20),
      decoration: panelDecoration(radius: Ds.radiusL),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                    color: Tw.ink,
                  ),
                ),
              ),
              if (total > 0)
                Text(
                  'الخطوة ${(done + 1).clamp(1, total)} من $total',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: Tw.ink2,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          if (total > 0)
            ResultStrip(parts: const [], progress: done / total)
          else
            const ProgressLine(height: 8),
          const SizedBox(height: 14),
          Row(
            children: [
              if (waiting) ...[
                Icon(Icons.wifi_off, size: 18, color: Tw.warn),
                const SizedBox(width: 6),
              ],
              Expanded(
                child: Text(
                  '${job.progress ?? 'جاري التدقيق'}${waiting ? '' : '…'}',
                  style: TextStyle(
                    fontSize: 15,
                    color: waiting ? Tw.warn : Tw.ink,
                  ),
                ),
              ),
            ],
          ),
          if (waiting) ...[
            const SizedBox(height: 12),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: ErpButton(
                label: 'استئناف الآن',
                icon: Icons.sync,
                kind: ErpButtonKind.indigoSoft,
                height: 40,
                expand: false,
                onPressed: _resumeNow,
              ),
            ),
          ],
          if (duplicates.isNotEmpty) ...[
            const SizedBox(height: 10),
            _dupRow(duplicates),
          ],
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              local
                  ? 'التدقيق من الملف يتم على هذه الشاشة؛ انتظر حتى ينتهي.'
                  : 'يمكنك إغلاق التطبيق: يكمل العمل في الخلفية، وإذا انقطع الإنترنت يُستأنف من الخطوة نفسها.',
              style: Ds.caption,
            ),
          ),
        ],
      ),
    );
  }

  // -------------------------------------------------------------- done

  /// `.results`: the outcome first.
  Widget _resultsCard() {
    final r = _result!;
    final s = r.summary;
    var msg = r.message;
    if (r.cycleSynced && !msg.contains('تمت مزامنة جداول الدورة')) {
      msg = 'تمت مزامنة جداول الدورة من Google ثم $msg';
    }
    final when = _job?.updatedAt;
    // The result shown is the one of the latest job, which may be one of
    // the «غير مذكور» tools rather than the audit.
    final kind =
        r.localOnly || _job == null ? JobKind.audit : JobKind.of(_job!.request);
    final what = kind == JobKind.audit ? 'التدقيق' : JobKind.title(kind);
    final mgmtId =
        (_cycle?.managementSpreadsheetId ?? '').isEmpty
            ? null
            : _cycle!.managementSpreadsheetId;
    final agent = hexColor(_agentColor);
    final mgmt = hexColor(_mgmtColor);
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: panelDecoration(radius: Ds.radiusL),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  color: r.applied ? Tw.accentSoft : Tw.warnSoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  r.applied ? Icons.check : Icons.info_outline,
                  size: 14,
                  color: r.applied ? Tw.accentInk : Tw.warn,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  r.applied
                      ? (when == null || r.localOnly
                          ? 'اكتمل $what'
                          : 'اكتمل $what ${_when(when)}')
                      : 'لم تُطبَّق النتائج',
                  style: TextStyle(fontSize: 14, color: Tw.ink2),
                ),
              ),
            ],
          ),
          if (s != null) ...[
            Padding(
              padding: const EdgeInsets.only(top: 10, bottom: 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    formatCount(s.total),
                    style: TextStyle(
                      fontSize: 46,
                      fontWeight: FontWeight.w800,
                      height: 1.1,
                      color: Tw.ink,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'السجلات المدققة',
                    style: TextStyle(fontSize: 15, color: Tw.ink2),
                  ),
                ],
              ),
            ),
            ResultStrip(
              parts: [
                (s.agent, agent),
                (s.management, mgmt),
                (s.noSalary, Tw.slate400),
                (s.notFound, null),
              ],
            ),
            const SizedBox(height: 14),
            ResultLegend(
              items: [
                (typeAgent, s.agent, agent),
                // 3.4.0: «بدون راتب» replaces «سحب إدارة» in an audit
                // without the management sheet.
                if (s.noSalary > 0 || s.management == 0 && _noMgmt)
                  (typeNoSalary, s.noSalary, Tw.slate400)
                else
                  (typeManagement, s.management, mgmt),
                (typeNotFound, s.notFound, null),
              ],
            ),
          ],
          if (r.duplicates.isNotEmpty) ...[
            const SizedBox(height: 6),
            _dupRow(r.duplicates),
          ],
          Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Text(
              r.localOnly
                  ? '$msg — دُقّقت على الهاتف ولم يُكتب شيء في Google. صدّر النتائج إلى Excel.'
                  : msg,
              style: TextStyle(
                fontSize: 13.5,
                height: 1.65,
                color: r.applied ? Tw.ink2 : Tw.warn,
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (r.results.isNotEmpty)
            ErpButton(
              label: 'النتيجة لكل مستخدم',
              icon: Icons.format_list_bulleted,
              kind: ErpButtonKind.indigoSoft,
              onPressed: () => _openRowsSheet(r),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              alignment: WrapAlignment.spaceEvenly,
              spacing: 4,
              children: [
                // One link per spreadsheet: the management table, and the
                // spreadsheet of the result when it is another one.
                if (!r.localOnly &&
                    mgmtId != null &&
                    !(r.spreadsheetUrl?.contains(mgmtId) ?? false))
                  _link(
                    Icons.open_in_new,
                    'جدول الإدارة',
                    () => _openUrl(
                      'https://docs.google.com/spreadsheets/d/$mgmtId',
                    ),
                  ),
                if (r.spreadsheetUrl != null)
                  _link(
                    Icons.open_in_new,
                    mgmtId != null && r.spreadsheetUrl!.contains(mgmtId)
                        ? 'جدول الإدارة'
                        : 'بيانات المستخدمين',
                    () => _openUrl(r.spreadsheetUrl!),
                  ),
                if (r.localOnly)
                  _link(
                    Icons.file_download_outlined,
                    _exporting ? 'جاري التصدير…' : 'تصدير إلى Excel',
                    _exporting ? null : _export,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static const _monthsShort = [
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ];

  /// «اليوم، 3:20 م» or «في 16 أكتوبر، 3:20 م».
  String _when(DateTime t) {
    final l = t.toLocal();
    final now = DateTime.now();
    final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
    final time =
        '$h:${l.minute.toString().padLeft(2, '0')} ${l.hour < 12 ? 'ص' : 'م'}';
    final today =
        l.year == now.year && l.month == now.month && l.day == now.day;
    return today
        ? 'اليوم، $time'
        : 'في ${l.day} ${_monthsShort[l.month - 1]}، $time';
  }

  Future<void> _openUrl(String url) =>
      launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);

  /// `.link`.
  Widget _link(IconData icon, String label, VoidCallback? onTap) =>
      TextButton.icon(
        onPressed: onTap,
        icon: Icon(icon, size: 17),
        label: Text(label, style: const TextStyle(fontSize: 14)),
      );

  /// `.dup-row`: the duplicated ids of the user-info sheet.
  Widget _dupRow(List<DuplicateGroup> duplicates) => Material(
    color: Tw.surface2,
    borderRadius: BorderRadius.circular(14),
    child: InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => _openDuplicatesSheet(duplicates),
      child: SizedBox(
        height: 48,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Icon(Icons.content_copy_outlined, size: 18, color: Tw.ink2),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'السجلات المكررة (حالات استثنائية)',
                  style: TextStyle(fontSize: 14.5, color: Tw.ink),
                ),
              ),
              Text(
                formatCount(duplicates.length),
                style: TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w700,
                  color: Tw.ink,
                ),
              ),
              Icon(Icons.chevron_left, size: 18, color: Tw.ink3),
            ],
          ),
        ),
      ),
    ),
  );

  /// `.section` «إعداد التدقيق والتشخيص» + «إعادة التدقيق».
  Widget _details() {
    final r = _result;
    final diag =
        r != null && (r.diagnostic != null || r.sampleUserIds.isNotEmpty);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Disclosure(
          title: 'إعداد التدقيق والتشخيص',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 4),
              _setupRows(),
              if (diag) ...[
                const SizedBox(height: 8),
                GroupList(
                  children: [
                    ListRow(
                      leading: IconChip(Icons.bar_chart),
                      title: 'تشخيص المطابقة',
                      subtitle: const Text('أعداد الأرقام وعينات للمقارنة'),
                      trailing: const RowChevron(),
                      onTap: () => _openDiagnosticSheet(r),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        ErpButton(
          label:
              _spreadsheetId == _localSource
                  ? 'إعادة التدقيق'
                  : 'تدقيق المعلومات الجديدة',
          icon: Icons.sync,
          kind: ErpButtonKind.indigoSoft,
          loading: _running,
          loadingLabel: _progress ?? 'جاري التدقيق...',
          onPressed:
              _spreadsheetId.isNotEmpty && !_jobRunning ? _runAudit : null,
        ),
        if (_spreadsheetId != _localSource) ...[
          const Caption(
            'يدقق الصفوف الجديدة فقط (ومن لم يُعثر عليه من قبل)، ولا يعيد كتابة أو نسخ أو تلوين من دُقق.',
            center: true,
          ),
          Center(
            child: TextButton(
              onPressed:
                  _spreadsheetId.isNotEmpty && !_jobRunning ? _runFull : null,
              child: const Text('تدقيق كامل من البداية…'),
            ),
          ),
        ],
      ],
    );
  }

  /// ERP's audit of every user again (rewrites all salaries, statuses and
  /// colours; rows already in the management sheets are still not copied
  /// twice).
  Future<void> _runFull() async {
    final ok = await confirmDialog(
      context,
      icon: Icons.sync,
      title: 'تدقيق كامل من البداية',
      body:
          'يُعاد تدقيق كل المستخدمين: تُكتب رواتب وحالات الجميع في جدول بيانات المستخدمين وتُلوَّن كل الصفوف من جديد. الصفوف الموجودة في أوراق الإدارة لا تُنسخ مرة ثانية.',
      confirmLabel: 'تدقيق كامل',
    );
    if (ok && mounted) await _runAudit(full: true);
  }

  // ------------------------------------------------- follow-up tools

  /// Owner's requests (2026-11-17), after a full or partial audit: the
  /// read-only list of agent records not audited yet, then the two
  /// «غير مذكور» steps. Nothing runs until a row is tapped (and the two
  /// steps ask before writing).
  Widget _tools() {
    final busy = _jobRunning;
    final google = _spreadsheetId != _localSource;
    final label = _ws.unmentionedLabel;
    final active = (_job?.active ?? false) && _toolJob;
    final activeKind = active ? JobKind.of(_job!.request) : null;
    Widget tool(String kind, IconData icon, String title, String sub) {
      final runningThis = activeKind == kind;
      return ListRow(
        enabled: runningThis || (!busy && google),
        leading: IconChip(icon),
        title: title,
        subtitle: Text(runningThis ? 'جاري التنفيذ في الخلفية…' : sub),
        below:
            runningThis
                ? const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: ProgressLine(height: 3),
                )
                : null,
        trailing: const RowChevron(),
        onTap: busy || !google ? null : () => _runTool(kind),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GroupList(
          children: [
            ListRow(
              leading: IconChip(Icons.format_list_bulleted),
              title: 'السجلات غير المدققة',
              subtitle: const Text('في جدول الوكيل، للاطلاع والنسخ'),
              onTap: _loadingPending ? null : _showUnaudited,
              trailing:
                  _loadingPending
                      ? const Padding(
                        padding: EdgeInsets.all(10),
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                      : const RowChevron(),
            ),
            tool(
              JobKind.unmentionedUsers,
              Icons.person_add_alt_outlined,
              '١. تدقيق غير المذكورين',
              'إضافة أرقام الوكيل الناقصة بعنوان «$label» ثم تدقيقها',
            ),
            if (!_noMgmt)
              tool(
                JobKind.unmentionedMgmt,
                Icons.swap_horiz,
                '٢. نقل سجلات الإدارة غير الملوّنة',
                'إلى «$label» إن كان فيها مبلغ في ${_ws.mgmtShareCol}',
              ),
          ],
        ),
        if (!google)
          const Caption('الأداتان ١ و٢ تعملان على جداول Google فقط.'),
        if (active) ...[
          const SizedBox(height: 12),
          _runCard(_job!, compact: true),
        ],
      ],
    );
  }

  // ------------------------------------------------------------ sheets

  /// `srcSheet`: Google spreadsheets, a pasted link, or a file.
  Future<void> _openSourceSheet() async {
    final picked = await showAppSheet<String>(
      context,
      (ctx) => ValueListenableBuilder<int>(
        valueListenable: _tick,
        builder: (ctx, _, _) {
          final linked = _cycle?.linkedToGoogle ?? false;
          final loading = _ssMessage != null && _ssMessage!.contains('جاري');
          final failed = _ssMessage != null && !loading;
          final known = {for (final f in _spreadsheets) f.id};
          final local = _spreadsheetId == _localSource;
          return AppSheet(
            title: 'مصدر بيانات المستخدمين',
            actions: [RefreshAction(onRefresh: _refreshGoogleLists)],
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (failed)
                  NoticeBox(
                    bg: Tw.warnSoft,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'حساب Google غير مربوط أو تعذّر جلب الجداول: $_ssMessage',
                          style: TextStyle(color: Tw.warn),
                        ),
                        TextButton(
                          onPressed: () {
                            Navigator.pop(ctx);
                            widget.onOpenSettings();
                          },
                          child: const Text('الذهاب إلى الإعدادات'),
                        ),
                      ],
                    ),
                  )
                else if (!linked)
                  NoticeBox(
                    bg: Tw.warnSoft,
                    child: Text(
                      'هذه الدورة من ملفات محلية، فالتدقيق على Google يحتاج دورة مرتبطة بجداول Google. يمكنك التدقيق من ملف على الجهاز.',
                      style: TextStyle(color: Tw.warn),
                    ),
                  ),
                const SheetLabel('من Google Sheets'),
                if (loading)
                  const ChoiceTile(
                    icon: Icons.hourglass_empty,
                    label: '— جاري التحميل... —',
                  ),
                for (final f in _spreadsheets)
                  ChoiceTile(
                    icon: Icons.table_chart_outlined,
                    label: f.name,
                    selected: f.id == _spreadsheetId,
                    tail:
                        f.id == _spreadsheetId ? const Icon(Icons.check) : null,
                    onTap: () => Navigator.pop(ctx, f.id),
                  ),
                if (_spreadsheetId.isNotEmpty &&
                    !local &&
                    !known.contains(_spreadsheetId))
                  ChoiceTile(
                    icon: Icons.table_chart_outlined,
                    label: _spreadsheetId,
                    selected: true,
                    tail: const Icon(Icons.check),
                    onTap: () => Navigator.pop(ctx, _spreadsheetId),
                  ),
                ChoiceTile(
                  icon: Icons.link,
                  label: 'لصق رابط جدول Google…',
                  onTap: () => Navigator.pop(ctx, pasteLinkValue),
                ),
                const SheetLabel('من الجهاز'),
                ChoiceTile(
                  icon: Icons.description_outlined,
                  label:
                      local && _localFile != null
                          ? _localFile!.fileName
                          : 'ملف من الجهاز (Excel / CSV)…',
                  selected: local,
                  tail: local ? const Icon(Icons.check) : null,
                  onTap: () => Navigator.pop(ctx, _localSource),
                ),
                Caption(
                  linked
                      ? 'من Google: تُزامن البيانات ثم تُكتب النتائج والألوان في Google. من الجهاز: يُحسب التدقيق على الهاتف وتُصدَّر النتائج إلى Excel.'
                      : 'يُحسب التدقيق على الهاتف من الملف المختار، وتُحفظ النتائج لتصديرها إلى Excel.',
                ),
              ],
            ),
          );
        },
      ),
    );
    if (picked != null && mounted) await _onSourceChanged(picked);
  }

  /// `cfgSheet`: the audit settings.
  Future<void> _openConfigSheet() => showAppSheet<void>(
    context,
    (ctx) => ValueListenableBuilder<int>(
      valueListenable: _tick,
      builder:
          (ctx, _, _) => AppSheet(
            title: 'إعداد التدقيق',
            actions: [RefreshAction(onRefresh: _refreshGoogleLists)],
            footer: Row(
              children: [
                ErpButton(
                  label: 'حفظ كإعداد افتراضي',
                  kind: ErpButtonKind.outline,
                  expand: false,
                  onPressed: _saveSettings,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ErpButton(
                    label: 'تم',
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SheetLabel(
                  _noMgmt ? 'جدول الوكيل' : 'جدولا الإدارة والوكيل',
                  first: true,
                ),
                FormRows(
                  children: [
                    if (!_noMgmt)
                      _colRow(
                        'رقم المستخدم (الإدارة)',
                        _cycleMgmtCols,
                        _cycleMgmtUserIdCol,
                        (v) => setState(() => _cycleMgmtUserIdCol = v),
                      ),
                    _colRow(
                      'رقم المستخدم (الوكيل)',
                      _cycleAgentCols,
                      _cycleAgentUserIdCol,
                      (v) => setState(() => _cycleAgentUserIdCol = v),
                    ),
                    _colRow(
                      'الراتب (الوكيل)',
                      _cycleAgentCols,
                      _cycleAgentSalaryCol,
                      (v) => setState(() => _cycleAgentSalaryCol = v),
                    ),
                  ],
                ),
                const SheetLabel('بيانات المستخدمين'),
                FormRows(
                  children: [
                    FormRow(
                      'الورقة',
                      CompactSelect<String>(
                        options: [
                          const SelectOption('', 'أول ورقة'),
                          for (final s in _userInfoSheets) SelectOption(s, s),
                          if (_userInfoSheet.isNotEmpty &&
                              !_userInfoSheets.contains(_userInfoSheet))
                            SelectOption(
                              _userInfoSheet,
                              _userInfoSheets.isEmpty
                                  ? _userInfoSheet
                                  : '$_userInfoSheet (غير موجودة)',
                            ),
                        ],
                        value: _userInfoSheet,
                        maxWidth: 170,
                        onChanged: (v) {
                          setState(() => _userInfoSheet = v);
                          if (_spreadsheetId.isNotEmpty) {
                            _loadUserInfoSheetsAndColumns(
                              _spreadsheetId,
                              v.isEmpty ? null : v,
                            );
                          }
                          _saveDraft();
                        },
                      ),
                    ),
                    _colRow(
                      'رقم المستخدم',
                      _userInfoCols,
                      _userInfoUserIdCol,
                      (v) => setState(() => _userInfoUserIdCol = v),
                    ),
                    _colRow(
                      'اسم الوكالة (الورقة)',
                      _userInfoCols,
                      _userInfoTitleCol,
                      (v) => setState(() => _userInfoTitleCol = v),
                    ),
                    _colRow(
                      'كتابة الراتب',
                      _userInfoCols,
                      _userInfoSalaryCol,
                      (v) => setState(() => _userInfoSalaryCol = v),
                    ),
                    FormRow(
                      'كتابة الحالة',
                      CompactSelect<String>(
                        options: [
                          SelectOption('', 'تلقائي (${_statusColLabel()})'),
                          for (final c in _userInfoCols)
                            SelectOption(c.letter, c.label),
                        ],
                        shown:
                            (v) =>
                                v.isEmpty ? 'تلقائي (${_statusColLabel()})' : v,
                        value: _userInfoStatusCol,
                        onChanged: (v) {
                          setState(() => _userInfoStatusCol = v);
                          _saveDraft();
                        },
                      ),
                    ),
                  ],
                ),
                const SheetLabel('الخصم والألوان'),
                FormRows(
                  children: [
                    FormRow(
                      'الخصم %',
                      SizedBox(
                        width: 84,
                        child: NumberBox(
                          controller: _discount,
                          onChanged: (_) {
                            setState(() {});
                            _saveDraft();
                          },
                        ),
                      ),
                    ),
                    FormRow(
                      'لون الوكيل',
                      ColorSwatchButton(
                        value: _agentColor,
                        onChanged: (v) {
                          setState(() => _agentColor = v);
                          _saveDraft();
                        },
                      ),
                    ),
                    if (!_noMgmt)
                      FormRow(
                        'لون الإدارة',
                        ColorSwatchButton(
                          value: _mgmtColor,
                          onChanged: (v) {
                            setState(() => _mgmtColor = v);
                            _saveDraft();
                          },
                        ),
                      ),
                  ],
                ),
                const Caption(
                  'الألوان نفسها تُكتب في جداولك، ويستخدمها الشريط الملوّن في النتائج.',
                ),
              ],
            ),
          ),
    ),
  );

  String _statusColLabel() =>
      _userInfoStatusCol.isEmpty
          ? columnIndexToLetter(
            (columnLetterToIndex(_userInfoSalaryCol) ?? 11) + 1,
          )
          : _userInfoStatusCol;

  Widget _colRow(
    String label,
    List<ColumnOption> cols,
    String value,
    ValueChanged<String> onChanged,
  ) => FormRow(
    label,
    CompactSelect<String>(
      options: [for (final c in cols) SelectOption(c.letter, c.label)],
      shown: (v) => v,
      value: value,
      onChanged: (v) {
        onChanged(v);
        _saveDraft();
      },
    ),
  );

  /// `rowsSheet`: the outcome of every user, searchable and filtered.
  Future<void> _openRowsSheet(PayrollResult r) {
    final agent = hexColor(_agentColor);
    final mgmt = hexColor(_mgmtColor);
    String cat(String type) =>
        isAgentType(type)
            ? 'agent'
            : type == typeManagement
            ? 'mgmt'
            : type == typeNoSalary
            ? 'nosal'
            : 'none';
    final counts = {'agent': 0, 'mgmt': 0, 'nosal': 0, 'none': 0};
    for (final row in r.results) {
      counts[cat(row.type)] = counts[cat(row.type)]! + 1;
    }
    var query = '';
    var filter = 'all';
    return showAppSheet<void>(
      context,
      (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          final q = query.trim();
          final rows = [
            for (final row in r.results)
              if ((filter == 'all' || cat(row.type) == filter) &&
                  (q.isEmpty ||
                      row.userId.contains(q) ||
                      row.title.contains(q)))
                row,
          ];
          Widget chip(String key, String label, int n) => Padding(
            padding: const EdgeInsetsDirectional.only(end: 6),
            child: FilterPill(
              label: label,
              count: formatCount(n),
              selected: filter == key,
              onTap: () => setLocal(() => filter = key),
            ),
          );
          return AppSheet(
            title: 'النتيجة لكل مستخدم',
            scroll: false,
            child: SizedBox(
              height: MediaQuery.of(ctx).size.height * 0.72,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SheetSearch(
                    hint: 'ابحث برقم المستخدم أو اسم الوكالة',
                    onChanged: (v) => setLocal(() => query = v),
                  ),
                  const SizedBox(height: 12),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        chip('all', 'الكل', r.results.length),
                        chip('agent', typeAgent, counts['agent']!),
                        if (counts['mgmt']! > 0 || counts['nosal']! == 0)
                          chip('mgmt', typeManagement, counts['mgmt']!),
                        if (counts['nosal']! > 0)
                          chip('nosal', typeNoSalary, counts['nosal']!),
                        chip('none', typeNotFound, counts['none']!),
                      ],
                    ),
                  ),
                  const SizedBox(height: 6),
                  Expanded(
                    child:
                        rows.isEmpty
                            ? Padding(
                              padding: const EdgeInsets.all(28),
                              child: Text(
                                'لا نتائج مطابقة.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Tw.ink2),
                              ),
                            )
                            : ListView.builder(
                              itemCount: rows.length,
                              itemBuilder: (_, i) {
                                final row = rows[i];
                                final c = cat(row.type);
                                return Container(
                                  constraints: const BoxConstraints(
                                    minHeight: 50,
                                  ),
                                  decoration: BoxDecoration(
                                    border: Border(
                                      bottom: BorderSide(color: Tw.rule),
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      ColorKey(
                                        c == 'agent'
                                            ? agent
                                            : c == 'mgmt'
                                            ? mgmt
                                            : null,
                                      ),
                                      const SizedBox(width: 10),
                                      Text(
                                        row.userId.isEmpty ? '—' : row.userId,
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
                                          row.title,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 14.5,
                                            color: Tw.ink2,
                                          ),
                                        ),
                                      ),
                                      Text(
                                        row.type,
                                        style: TextStyle(
                                          fontSize: 13,
                                          color: Tw.ink2,
                                        ),
                                      ),
                                    ],
                                  ),
                                );
                              },
                            ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  /// `dupSheet`.
  Future<void> _openDuplicatesSheet(
    List<DuplicateGroup> duplicates,
  ) => showAppSheet<void>(
    context,
    (ctx) => AppSheet(
      title: 'السجلات المكررة',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'أرقام مكررة في جدول بيانات المستخدمين: ${formatCount(duplicates.length)}. دُقق أول صف لكل رقم ونُسخ مرة واحدة فقط، والصفوف الأخرى كُتب فيها «مكرر» ولم تُنسخ.',
            style: TextStyle(fontSize: 14.5, height: 1.7, color: Tw.ink2),
          ),
          const SizedBox(height: 8),
          for (final d in duplicates)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 2),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: Tw.rule)),
              ),
              child: Wrap(
                spacing: 12,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    d.userId,
                    textDirection: TextDirection.ltr,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: Tw.ink,
                    ),
                  ),
                  Text(
                    'الصفوف ${d.rows.join('، ')}',
                    style: TextStyle(fontSize: 14.5, color: Tw.ink),
                  ),
                  Text(
                    'دُقق الصف ${d.firstRow}',
                    style: TextStyle(fontSize: 13, color: Tw.ink2),
                  ),
                ],
              ),
            ),
        ],
      ),
    ),
  );

  /// `diagSheet`: unique counts, the hint, and samples to compare.
  Future<void> _openDiagnosticSheet(PayrollResult r) {
    final d = r.diagnostic;
    String? hint;
    if (d != null) {
      if (d.managementUniqueCount == 0 && d.agentUniqueCount == 0) {
        hint =
            'عمودا الإدارة والوكيل لا يقرآن أرقاماً — غيّر «رقم المستخدم — الإدارة» و«رقم المستخدم — الوكيل» إلى العمود الذي فيه رقم المستخدم فعلياً (B, C, D...).';
      } else if (d.managementUniqueCount == 0) {
        hint =
            'المشكلة من جدول الإدارة: لم يُقرأ أي رقم من ورقة الإدارة (العدد 0). غيّر «رقم المستخدم — الإدارة» إلى العمود الذي فيه رقم المستخدم فعلياً (جرّب B ثم C ثم D…). الوكيل يقرأ بشكل صحيح.';
      } else if (d.agentUniqueCount == 0) {
        hint =
            'المشكلة من جدول الوكيل: لم يُقرأ أي رقم من ورقة الوكيل. غيّر «رقم المستخدم — الوكيل» إلى العمود الصحيح (B, C, D…).';
      }
    }
    String list(List<String> ids) =>
        ids.take(10).join(', ') + (ids.length > 10 ? '...' : '');
    Widget kv(String label, String value) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 40),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: TextStyle(fontSize: 14.5, color: Tw.ink),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              value,
              textDirection: TextDirection.ltr,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: Tw.ink,
              ),
            ),
          ],
        ),
      ),
    );
    return showAppSheet<void>(
      context,
      (ctx) => AppSheet(
        title: 'تشخيص المطابقة',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (d != null) ...[
              FormRows(
                children: [
                  kv(
                    'الأرقام الفريدة في بيانات المستخدمين',
                    formatCount(d.userInfoUniqueCount),
                  ),
                  kv(
                    'الأرقام الفريدة في جدول الإدارة',
                    formatCount(d.managementUniqueCount),
                  ),
                  kv(
                    'الأرقام الفريدة في جدول الوكيل',
                    formatCount(d.agentUniqueCount),
                  ),
                ],
              ),
              if (hint != null) ...[
                const SizedBox(height: 10),
                NoticeBox(
                  bg: Tw.warnSoft,
                  child: Text(hint, style: TextStyle(color: Tw.warn)),
                ),
              ],
              if (d.sampleCheck.isNotEmpty) ...[
                const SheetLabel('أول 5 أرقام من بيانات المستخدمين'),
                FormRows(
                  children: [
                    for (final sc in d.sampleCheck)
                      kv(
                        sc.userId,
                        'الإدارة ${sc.inMgmt ? 'نعم' : 'لا'}، الوكيل ${sc.inAgent ? 'نعم' : 'لا'}',
                      ),
                  ],
                ),
              ],
            ],
            if (r.sampleUserIds.isNotEmpty) ...[
              const SheetLabel('عينة أرقام للمقارنة'),
              FormRows(
                children: [
                  FormRow(
                    'عمود المستخدم في بيانات المستخدمين',
                    Text(list(r.sampleUserIds), style: Ds.secondary),
                    block: true,
                  ),
                  if (r.sampleMgmtIds.isNotEmpty)
                    FormRow(
                      'عمود المستخدم في جدول الإدارة (الدورة)',
                      Text(list(r.sampleMgmtIds), style: Ds.secondary),
                      block: true,
                    ),
                  if (r.sampleAgentIds.isNotEmpty)
                    FormRow(
                      'عمود المستخدم في جدول الوكيل (الدورة)',
                      Text(list(r.sampleAgentIds), style: Ds.secondary),
                      block: true,
                    ),
                ],
              ),
            ],
            const Caption(
              'إذا لم تتطابق الأرقام، قارن هذه العينات بأعمدة رقم المستخدم في «إعداد التدقيق».',
            ),
          ],
        ),
      ),
    );
  }
}
