// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/chart.dart';
import '../../accounting/ledger.dart';
import '../../accounting/money.dart';
import '../../app_services.dart';
import '../erp_widgets.dart';
import '../ui_kit.dart';
import 'books_kit.dart';

/// The sheets that post the everyday operations: «سند قبض», «سند صرف»,
/// «تحويل بين الصناديق», «مصروف» and «صندوق جديد».

enum VoucherMode { receipt, payment }

Future<void> showVoucherSheet(
  BuildContext context,
  VoucherMode mode, {
  int? fundId,
}) => showAppSheet<void>(
  context,
  (_) => _VoucherSheet(mode: mode, fundId: fundId),
);

class _VoucherSheet extends StatefulWidget {
  const _VoucherSheet({required this.mode, this.fundId});
  final VoucherMode mode;
  final int? fundId;
  @override
  State<_VoucherSheet> createState() => _VoucherSheetState();
}

class _VoucherSheetState extends State<_VoucherSheet> {
  final _amount = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  Account? _fund;
  Account? _other;
  bool _busy = false;

  bool get _receipt => widget.mode == VoucherMode.receipt;

  @override
  void initState() {
    super.initState();
    _initFund();
  }

  Future<void> _initFund() async {
    final s = AppScope.read(context);
    final funds = await s.books.funds();
    if (!mounted || funds.isEmpty) return;
    setState(() {
      _fund =
          funds
              .firstWhere(
                (f) => f.account.id == widget.fundId,
                orElse: () => funds.first,
              )
              .account;
    });
  }

  @override
  void dispose() {
    _amount.dispose();
    _memo.dispose();
    super.dispose();
  }

  Future<void> _pickFund() async {
    final s = AppScope.read(context);
    final ids = {for (final f in await s.books.funds()) f.account.id};
    if (!mounted) return;
    final a = await pickAccount(
      context,
      title: 'الصندوق',
      where: (a) => ids.contains(a.id),
      selectedId: _fund?.id,
    );
    if (a != null) setState(() => _fund = a);
  }

  Future<void> _pickOther() async {
    final fundId = _fund?.id;
    final a = await pickAccount(
      context,
      title: _receipt ? 'مقبوض من حساب' : 'مدفوع إلى حساب',
      selectedId: _other?.id,
      where:
          (a) =>
              a.id != fundId &&
              (_receipt
                  ? a.type != AccountType.expense
                  : a.type != AccountType.revenue),
    );
    if (a != null) setState(() => _other = a);
  }

  Future<void> _save() async {
    final amount = AmountField.cents(_amount);
    if (amount == null || amount <= 0) {
      showToast(context, 'اكتب المبلغ', ToastType.warning);
      return;
    }
    if (_fund == null || _other == null) {
      showToast(
        context,
        _fund == null ? 'اختر الصندوق' : 'اختر الحساب المقابل',
        ToastType.warning,
      );
      return;
    }
    final memo =
        _memo.text.trim().isEmpty
            ? '${_receipt ? 'قبض من' : 'صرف إلى'} ${_other!.name}'
            : _memo.text.trim();
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) =>
          _receipt
              ? s.books.receipt(
                fundId: _fund!.id,
                fromAccountId: _other!.id,
                amount: amount,
                date: _date,
                memo: memo,
              )
              : s.books.payment(
                fundId: _fund!.id,
                toAccountId: _other!.id,
                amount: amount,
                date: _date,
                memo: memo,
              ),
      done: _receipt ? 'سُجّل سند القبض' : 'سُجّل سند الصرف',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => AppSheet(
    title: _receipt ? 'سند قبض' : 'سند صرف',
    footer: ErpButton(
      label: 'تسجيل',
      icon: Icons.check,
      loading: _busy,
      onPressed: _save,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SheetLabel('المبلغ', first: true),
        AmountField(controller: _amount, autofocus: true),
        const SheetLabel('التفاصيل'),
        FormRows(
          children: [
            FormRow(
              _receipt ? 'إلى الصندوق' : 'من الصندوق',
              PickerValue(
                text: _fund?.name ?? 'اختر',
                placeholder: _fund == null,
                onTap: _pickFund,
              ),
            ),
            FormRow(
              _receipt ? 'مقبوض من' : 'مدفوع إلى',
              PickerValue(
                text: _other?.name ?? 'اختر الحساب',
                placeholder: _other == null,
                onTap: _pickOther,
              ),
            ),
            FormRow(
              'التاريخ',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        const SheetLabel('البيان'),
        MemoField(controller: _memo, hint: 'اختياري'),
        const SizedBox(height: 10),
        Caption(
          _receipt
              ? 'يُسجَّل قيد: من حـ/ الصندوق إلى حـ/ المقبوض منه (إيراد، زبون، رأس مال…).'
              : 'يُسجَّل قيد: من حـ/ المدفوع إليه (مورد، مسحوبات، ذمة…) إلى حـ/ الصندوق.',
        ),
      ],
    ),
  );
}

// ---------------------------------------------------------------- transfer

Future<void> showTransferSheet(BuildContext context, {int? fromId}) =>
    showAppSheet<void>(context, (_) => _TransferSheet(fromId: fromId));

class _TransferSheet extends StatefulWidget {
  const _TransferSheet({this.fromId});
  final int? fromId;
  @override
  State<_TransferSheet> createState() => _TransferSheetState();
}

class _TransferSheetState extends State<_TransferSheet> {
  final _amount = TextEditingController();
  final _fee = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  List<FundBalanceView> _funds = const [];
  int? _from;
  int? _to;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    final funds = await s.books.funds();
    if (!mounted) return;
    setState(() {
      _funds = [for (final f in funds) FundBalanceView(f.account, f.balance)];
      _from = widget.fromId ?? (funds.isEmpty ? null : funds.first.account.id);
      final others = funds.where((f) => f.account.id != _from);
      _to = others.isEmpty ? null : others.first.account.id;
    });
  }

  @override
  void dispose() {
    _amount.dispose();
    _fee.dispose();
    _memo.dispose();
    super.dispose();
  }

  FundBalanceView? _byId(int? id) =>
      _funds.where((f) => f.account.id == id).firstOrNull;

  Future<int?> _pick(String title, int? selected, int? not) async {
    final r = await showAppSheet<int>(
      context,
      (ctx) => AppSheet(
        title: title,
        child: Column(
          children: [
            for (final f in _funds)
              if (f.account.id != not)
                ChoiceTile(
                  icon:
                      f.account.id == selected
                          ? Icons.check
                          : Icons.account_balance_wallet_outlined,
                  label: f.account.name,
                  selected: f.account.id == selected,
                  tail: Money(f.balance, size: 13.5),
                  onTap: () => Navigator.pop(ctx, f.account.id),
                ),
          ],
        ),
      ),
    );
    return r ?? selected;
  }

  Future<void> _save() async {
    final amount = AmountField.cents(_amount);
    final fee = _fee.text.trim().isEmpty ? 0 : AmountField.cents(_fee);
    if (amount == null || amount <= 0 || fee == null || fee < 0) {
      showToast(context, 'اكتب المبلغ', ToastType.warning);
      return;
    }
    if (_from == null || _to == null) {
      showToast(context, 'تحتاج صندوقين على الأقل للتحويل', ToastType.warning);
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.books.transfer(
        fromId: _from!,
        toId: _to!,
        amount: amount,
        fee: fee,
        date: _date,
        memo: _memo.text,
      ),
      done: 'تم التحويل',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final from = _byId(_from);
    final to = _byId(_to);
    return AppSheet(
      title: 'تحويل بين الصناديق',
      footer: ErpButton(
        label: 'تحويل',
        icon: Icons.swap_horiz,
        loading: _busy,
        onPressed: _save,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SheetLabel('المبلغ', first: true),
          AmountField(controller: _amount, autofocus: true),
          const SheetLabel('الصناديق'),
          FormRows(
            children: [
              FormRow(
                'من',
                PickerValue(
                  text: from?.account.name ?? 'اختر',
                  placeholder: from == null,
                  onTap: () async {
                    final id = await _pick('من الصندوق', _from, null);
                    setState(() {
                      _from = id;
                      if (_to == id) _to = null;
                    });
                  },
                ),
              ),
              FormRow(
                'إلى',
                PickerValue(
                  text: to?.account.name ?? 'اختر',
                  placeholder: to == null,
                  onTap: () async {
                    final id = await _pick('إلى الصندوق', _to, _from);
                    setState(() => _to = id);
                  },
                ),
              ),
              FormRow(
                'التاريخ',
                DateValue(
                  value: _date,
                  onChanged: (v) => setState(() => _date = v),
                ),
              ),
            ],
          ),
          if (from != null)
            Caption(
              'رصيد «${from.account.name}»: ${formatCents(from.balance)}',
            ),
          const SheetLabel('عمولة التحويل (اختياري)'),
          AmountField(controller: _fee, hint: '0.00'),
          const SizedBox(height: 6),
          const Caption(
            'تُخصم العمولة من الصندوق المحوَّل منه وتُسجَّل في «عمولات ومصاريف التحويل».',
          ),
          const SheetLabel('البيان'),
          MemoField(controller: _memo, hint: 'اختياري'),
        ],
      ),
    );
  }
}

class FundBalanceView {
  const FundBalanceView(this.account, this.balance);
  final Account account;
  final int balance;
}

// ----------------------------------------------------------------- expense

Future<void> showExpenseSheet(BuildContext context, {int? categoryId}) =>
    showAppSheet<void>(context, (_) => _ExpenseSheet(categoryId: categoryId));

class _ExpenseSheet extends StatefulWidget {
  const _ExpenseSheet({this.categoryId});
  final int? categoryId;
  @override
  State<_ExpenseSheet> createState() => _ExpenseSheetState();
}

class _ExpenseSheetState extends State<_ExpenseSheet> {
  final _amount = TextEditingController();
  final _memo = TextEditingController();
  String _date = Ledger.today();
  Account? _category;
  Account? _fund;
  Account? _payable;
  bool _onCredit = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final s = AppScope.read(context);
    final funds = await s.books.funds();
    final cats = await s.books.expenseCategories();
    if (!mounted) return;
    setState(() {
      if (funds.isNotEmpty) _fund = funds.first.account;
      _category = cats.where((c) => c.id == widget.categoryId).firstOrNull;
    });
  }

  @override
  void dispose() {
    _amount.dispose();
    _memo.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final amount = AmountField.cents(_amount);
    if (amount == null || amount <= 0) {
      showToast(context, 'اكتب المبلغ', ToastType.warning);
      return;
    }
    if (_category == null) {
      showToast(context, 'اختر بند المصروف', ToastType.warning);
      return;
    }
    if (_onCredit ? _payable == null : _fund == null) {
      showToast(
        context,
        _onCredit ? 'اختر المورد / الدائن' : 'اختر الصندوق',
        ToastType.warning,
      );
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.books.expense(
        categoryId: _category!.id,
        amount: amount,
        fundId: _onCredit ? null : _fund!.id,
        payableId: _onCredit ? _payable!.id : null,
        date: _date,
        memo: _memo.text.trim(),
      ),
      done: 'سُجّل المصروف',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => AppSheet(
    title: 'مصروف جديد',
    footer: ErpButton(
      label: 'تسجيل المصروف',
      icon: Icons.check,
      loading: _busy,
      onPressed: _save,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SheetLabel('المبلغ', first: true),
        AmountField(controller: _amount, autofocus: true),
        const SheetLabel('التفاصيل'),
        FormRows(
          children: [
            FormRow(
              'البند',
              PickerValue(
                text: _category?.name ?? 'اختر البند',
                placeholder: _category == null,
                onTap: () async {
                  final a = await pickAccount(
                    context,
                    title: 'بند المصروف',
                    selectedId: _category?.id,
                    where: (a) => a.type == AccountType.expense,
                  );
                  if (a != null) setState(() => _category = a);
                },
              ),
            ),
            FormRow(
              'الدفع',
              SizedBox(
                width: 190,
                child: SegmentedChoice(
                  options: const ['نقدًا', 'بالآجل'],
                  selected: _onCredit ? 1 : 0,
                  onChanged: (i) => setState(() => _onCredit = i == 1),
                ),
              ),
            ),
            if (!_onCredit)
              FormRow(
                'من الصندوق',
                PickerValue(
                  text: _fund?.name ?? 'اختر',
                  placeholder: _fund == null,
                  onTap: () async {
                    final s = AppScope.read(context);
                    final ids = {
                      for (final f in await s.books.funds()) f.account.id,
                    };
                    if (!context.mounted) return;
                    final a = await pickAccount(
                      context,
                      title: 'الصندوق',
                      selectedId: _fund?.id,
                      where: (a) => ids.contains(a.id),
                    );
                    if (a != null) setState(() => _fund = a);
                  },
                ),
              )
            else
              FormRow(
                'على حساب',
                PickerValue(
                  text: _payable?.name ?? 'اختر الدائن',
                  placeholder: _payable == null,
                  onTap: () async {
                    final a = await pickAccount(
                      context,
                      title: 'المورد / الدائن',
                      selectedId: _payable?.id,
                      where: (a) => a.type == AccountType.liability,
                    );
                    if (a != null) setState(() => _payable = a);
                  },
                ),
              ),
            FormRow(
              'التاريخ',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        const SheetLabel('البيان'),
        MemoField(controller: _memo, hint: 'اختياري (يُستعمل اسم البند)'),
      ],
    ),
  );
}

// ---------------------------------------------------------------- new fund

Future<void> showNewFundSheet(BuildContext context) =>
    showAppSheet<void>(context, (_) => const _NewFundSheet());

class _NewFundSheet extends StatefulWidget {
  const _NewFundSheet();
  @override
  State<_NewFundSheet> createState() => _NewFundSheetState();
}

class _NewFundSheetState extends State<_NewFundSheet> {
  final _name = TextEditingController();
  final _opening = TextEditingController();
  final _note = TextEditingController();
  String _date = Ledger.today();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _opening.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      showToast(context, 'اكتب اسم الصندوق', ToastType.warning);
      return;
    }
    final opening =
        _opening.text.trim().isEmpty ? 0 : AmountField.cents(_opening);
    if (opening == null || opening < 0) {
      showToast(context, 'الرصيد الافتتاحي غير صحيح', ToastType.warning);
      return;
    }
    setState(() => _busy = true);
    final ok = await runPosting(
      context,
      (s) => s.books.createFund(
        name,
        opening: opening,
        date: _date,
        note: _note.text.trim(),
      ),
      done: 'أُضيف الصندوق',
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => AppSheet(
    title: 'صندوق جديد',
    footer: ErpButton(
      label: 'إضافة الصندوق',
      icon: Icons.add,
      loading: _busy,
      onPressed: _save,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SheetLabel('الاسم', first: true),
        ErpTextField(
          controller: _name,
          hint: 'مثال: صندوق المكتب، بنك، محفظة شام كاش',
        ),
        const SheetLabel('الرصيد الافتتاحي (اختياري)'),
        AmountField(controller: _opening),
        const SizedBox(height: 8),
        FormRows(
          children: [
            FormRow(
              'تاريخ الرصيد',
              DateValue(
                value: _date,
                onChanged: (v) => setState(() => _date = v),
              ),
            ),
          ],
        ),
        const SheetLabel('ملاحظة'),
        MemoField(controller: _note, hint: 'اختياري'),
        const SizedBox(height: 10),
        const Caption(
          'الصندوق حساب فرعي تحت «النقدية والصناديق»، ورصيده الافتتاحي يُقيَّد مقابل «أرصدة افتتاحية».',
        ),
      ],
    ),
  );
}

/// A name prompt (new account, rename, new expense category).
Future<String?> askName(
  BuildContext context,
  String title, {
  String initial = '',
  String hint = 'الاسم',
}) async {
  final c = TextEditingController(text: initial);
  final r = await showAppSheet<String>(
    context,
    (ctx) => AppSheet(
      title: title,
      footer: ErpButton(
        label: 'حفظ',
        onPressed: () => Navigator.pop(ctx, c.text.trim()),
      ),
      child: ErpTextField(controller: c, hint: hint),
    ),
  );
  c.dispose();
  return r == null || r.isEmpty ? null : r;
}
