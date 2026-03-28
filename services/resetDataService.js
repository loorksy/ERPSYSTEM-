/**
 * حذف بيانات من الخادم بترتيب يحترم المفاتيح الأجنبية.
 */

const RESET_CATEGORIES = [
  {
    id: 'payroll_cycles',
    label: 'الدورات المالية والرواتب والتدقيق',
    description: 'الدورات، أعمدة الرواتب، الكاش، التدقيق، المؤجل، ومزامنة الوكالات المرتبطة بالدورات',
  },
  {
    id: 'sub_agencies',
    label: 'الوكالات الفرعية',
    description: 'الوكالات، أرباح المزامنة من عمود W، الربط، المعاملات',
  },
  {
    id: 'shipping',
    label: 'الشحن والمخزون ووكالات النقل',
    description:
      'عمليات الشراء/البيع، المخزون، وكالات الشحن. (على نفس السيرفر قد تشمل سجلاتاً مشتركة لجميع الحسابات.)',
  },
  {
    id: 'shipping_lists',
    label: 'قوائم الشحن (معتمدو الشحن والشركات)',
    description:
      'قائمة المعتمدين السريعة وشركات الشحن. (قد تكون مشتركة بين المستخدمين على نفس السيرفر.)',
  },
  {
    id: 'funds',
    label: 'الصناديق',
    description:
      'الصناديق، الأرصدة، السجلات، التحويلات، ترحيل الأرباح، وديون «علينا» المسجّلة للصناديق. يُمسح معها تلقائياً الدفتر الموحّد والمصاريف وتبديل الراتب المرتبطة بنفس المستخدم.',
  },
  {
    id: 'transfer_companies',
    label: 'شركات التحويل',
    description: 'شركات التحويل وسجلها',
  },
  {
    id: 'accreditations',
    label: 'الاعتمادات',
    description: 'المعتمدون (الاسم والكود) وسجل العمليات',
  },
  {
    id: 'accounting_ledger',
    label: 'الدفتر المحاسبي والمصاريف وتبديل الراتب',
    description:
      'قيود الدفتر الموحّد (ledger_entries)، المصاريف اليدوية، سجلات تبديل الراتب، الوساطة الإدارية، وديون entity_payables عند الحاجة. يُنفَّذ تلقائياً أيضاً عند اختيار «الصناديق»؛ استخدمه منفرداً لمسح القيود دون حذف الصناديق.',
  },
  {
    id: 'ai',
    label: 'الذكاء الاصطناعي والتحليلات',
    description:
      'وظائف التحليل حسب المستخدم، وسجل التحليلات العام، وإعدادات المزوّدين المخزّنة محلياً (قد تؤثر على كل من يستخدم نفس السيرفر).',
  },
  {
    id: 'google_sheets',
    label: 'ربط Google Sheets محلياً',
    description: 'مسح الرمز والجدول من قاعدة البيانات (لا يحذف ملفات Google)',
  },
];

/**
 * @param {boolean} preserveIntegrations عند wipeAll: عدم مسح فئتي ai و google_sheets
 */
function has(cat, selected, wipeAll, preserveIntegrations) {
  if (preserveIntegrations && wipeAll && (cat === 'ai' || cat === 'google_sheets')) {
    return false;
  }
  return wipeAll || (selected && selected.includes(cat)) || (selected && selected.includes('all'));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} userId
 * @param {string[]} selected
 * @param {boolean} wipeAll
 * @param {{ preserveIntegrations?: boolean }} [options]
 */
async function executeReset(client, userId, selected, wipeAll, options = {}) {
  const s = selected || [];
  const preserveIntegrations = !!options.preserveIntegrations;

  // 1) معاملات الوكالة المرتبطة بعمليات شحن (قبل حذف shipping_transactions)
  if (has('sub_agencies', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM sub_agency_transactions');
  } else if (has('shipping', s, wipeAll, preserveIntegrations)) {
    await client.query('DELETE FROM sub_agency_transactions WHERE shipping_transaction_id IS NOT NULL');
  }

  // 2) الشحن
  if (has('shipping', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM shipping_carrier_transactions');
    await client.query('DELETE FROM shipping_transactions');
    await client.query('DELETE FROM shipping_inventory');
    await client.query('DELETE FROM shipping_carrier_agencies WHERE user_id = $1', [userId]);
  }

  // 3) الدورات والرواتب والمرتبط بالدورات
  if (has('payroll_cycles', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query(
      'DELETE FROM cash_box_snapshot WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query(
      'DELETE FROM deferred_balance_users WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM deferred_salary_lines WHERE user_id = $1', [userId]);
    await client.query(
      'DELETE FROM agency_cycle_users WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query(
      'DELETE FROM agency_sync_log WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query(
      'DELETE FROM agency_sheet_mapping WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query(
      'DELETE FROM sub_agency_cycle_settings WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM payroll_user_audit_cache WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM member_profile_events WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM member_adjustments WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM member_profiles WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM payroll_cycle_cache WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM payroll_cycle_columns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM payroll_settings WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM financial_cycles WHERE user_id = $1', [userId]);
  }

  // 4) الوكالات الفرعية (بعد الدورات إن وُجدت؛ يبقى تنظيف الجداول العامة)
  if (has('sub_agencies', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM user_agency_link');
    await client.query('DELETE FROM agency_sheet_mapping');
    await client.query('DELETE FROM agency_cycle_users');
    await client.query('DELETE FROM agency_sync_log');
    await client.query('DELETE FROM sub_agency_cycle_settings');
    await client.query('DELETE FROM shipping_sub_agencies');
  }

  // 5) قوائم الشحن
  if (has('shipping_lists', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM shipping_approved');
    await client.query('DELETE FROM shipping_companies');
  }

  // 6) صناديع (قبل شركات التحويل إن كان هناك FK من funds)
  if (has('funds', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM financial_returns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM entity_payables WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM fx_spread_entries WHERE user_id = $1', [userId]);
    await client.query(
      `DELETE FROM fund_transfers WHERE from_fund_id IN (SELECT id FROM funds WHERE user_id = $1)
       OR to_fund_id IN (SELECT id FROM funds WHERE user_id = $1)`,
      [userId]
    );
    await client.query(
      'DELETE FROM profit_transfer_batches WHERE user_id = $1 OR fund_id IN (SELECT id FROM funds WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM fund_ledger WHERE fund_id IN (SELECT id FROM funds WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM fund_balances WHERE fund_id IN (SELECT id FROM funds WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM funds WHERE user_id = $1', [userId]);
  }

  /**
   * دفتر موحّد، مصاريف، تبديل راتب (قبل حذف شركات التحويل)، وساطة إدارية.
   * يُشغَّل عند: الدفتر صراحةً، أو الصناديق، أو حذف كل شيء — لربط القيود بالبيانات المحذوفة.
   */
  if (has('accounting_ledger', s, wipeAll, preserveIntegrations) || has('funds', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM salary_swap_entries WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM ledger_entries WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM expense_entries WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM admin_brokerage_entries WHERE user_id = $1', [userId]);
  }
  /* ديون مسجّلة (تبديل راتب/تقسيط…) إذا لم تُمسَح مع الصناديق */
  if (has('accounting_ledger', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query('DELETE FROM entity_payables WHERE user_id = $1', [userId]);
  }

  if (has('transfer_companies', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query(
      'DELETE FROM transfer_company_ledger WHERE company_id IN (SELECT id FROM transfer_companies WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM transfer_companies WHERE user_id = $1', [userId]);
  }

  if (has('accreditations', s, wipeAll, preserveIntegrations) || wipeAll) {
    await client.query(
      'DELETE FROM accreditation_ledger WHERE accreditation_id IN (SELECT id FROM accreditation_entities WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM accreditation_entities WHERE user_id = $1', [userId]);
  }

  if (has('ai', s, wipeAll, preserveIntegrations)) {
    await client.query('DELETE FROM analysis_jobs WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM message_analyses');
    await client.query('DELETE FROM ai_config');
  }

  if (has('google_sheets', s, wipeAll, preserveIntegrations)) {
    await client.query(
      `UPDATE google_sheets_config SET spreadsheet_id = NULL, token = NULL, credentials = NULL,
       sync_enabled = 0, last_sync = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
    );
  }
}

module.exports = {
  RESET_CATEGORIES,
  executeReset,
};
