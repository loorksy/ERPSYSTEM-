/**
 * تسميات عربية موحّدة لأنواع الحركات (دفتر، صناديق، مصادر ربح).
 * يُستورد من الخادم (تقارير PDF، APIs) والواجهة تعيد استخدام نفس المفاتيح عبر profit-sources.js.
 */

const NET_PROFIT_SOURCE_LABELS = {
  fx_spread_profit: 'ربح فرق التصريف',
  audit_cycle_profits: 'أرباح تدقيق الدورة (مكافات شهرية وإيداع W في الصندوق)',
  audit_management_yz: 'أرباح المكافات الشهرية',
  audit_management_w: 'أرباح الإدارة: عمود W (أرشيف — لا يُنشأ قيد جديد)',
  transfer_discount_profit: 'ربح نسبة خصم التحويل',
  cycle_creation_discount_profit: 'ربح خصم التحويل (إنشاء دورة)',
  accreditation_brokerage: 'وساطة معتمدين',
  accreditation_payable_discount: 'ربح خصم دين علينا (معتمد)',
  admin_brokerage: 'وساطة إدارية',
  shipping_sale_profit: 'ربح بيع شحن',
  sub_agency_share: 'حصة وكالة فرعية',
  sub_agency_company_profit: 'ربح الشركة من نسبة الوكالات',
  manual_expense: 'مصروف يدوي',
  sub_agency_reward: 'مكافأة وكالة فرعية',
  agent_table_primary_seed: 'جدول الوكيل (رأس مال)',
  primary_agent_seed: 'رأس مال من جدول الوكيل',
  profit_transfer: 'ترحيل أرباح',
  fx_spread_disbursement: 'تصريف عملات',
  company_payout: 'صرف لشركة تحويل',
  fund_allocation: 'تحويل لصندوق',
  shipping_sale_cash: 'بيع شحن نقدي',
  shipping_buy_cash: 'شراء شحن نقدي',
};

const FUND_LEDGER_TYPE_LABELS = {
  return_in: 'مرتجع وارد',
  return_out: 'مرتجع صادر',
  return_recorded: 'مرتجع مسجّل',
  audit_profit_credit: 'إيداع أرباح تدقيق',
  expense: 'مصروف',
  transfer_in: 'تحويل وارد',
  transfer_out: 'تحويل صادر',
  opening_reference: 'رصيد افتتاحي',
  loan_cash_in: 'سلفة كاش',
  salary_swap_cash: 'تبديل راتب كاش',
  salary_swap_installment: 'تبديل راتب تقسيط',
  shipping_sale_cash: 'بيع شحن نقدي',
  shipping_buy_cash: 'شراء شحن نقدي',
  company_payout: 'صرف لشركة تحويل',
  fund_allocation: 'تحويل لصندوق',
  fund_receive_from_main: 'وارد من الصندوق الرئيسي',
  accreditation_bulk: 'استيراد رصيد معتمد',
  accreditation_debt_payable: 'دين علينا — معتمد',
  accreditation_remainder: 'باقي بعد الوساطة',
};

function labelNetProfitSource(code) {
  const k = code == null ? '' : String(code).trim();
  if (!k) return '—';
  return NET_PROFIT_SOURCE_LABELS[k] || k.replace(/_/g, ' ');
}

function labelFundLedgerType(code) {
  const k = code == null ? '' : String(code).trim();
  if (!k) return '—';
  return FUND_LEDGER_TYPE_LABELS[k] || k.replace(/_/g, ' ');
}

/** تصنيف لون واجهة: مرتجع | دين | صرف | رصيد */
function movementColorCategory({ bucket, sourceType, fundLedgerType, amount }) {
  const t = String(fundLedgerType || sourceType || '').toLowerCase();
  const a = Number(amount) || 0;
  if (/return|مرتجع/.test(t)) return 'refund';
  if (bucket === 'expense' || t.includes('expense') || t.includes('مصروف')) return 'payout';
  if (t.includes('payable') || t.includes('debt') || t.includes('دين')) return 'debt';
  if (a >= 0 && (bucket === 'main_cash' || bucket === 'net_profit')) return 'balance';
  if (a < 0) return 'payout';
  return 'balance';
}

module.exports = {
  NET_PROFIT_SOURCE_LABELS,
  FUND_LEDGER_TYPE_LABELS,
  labelNetProfitSource,
  labelFundLedgerType,
  movementColorCategory,
};
