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
    label: 'الصناديع',
    description: 'الصناديع، الأرصدة، السجلات، التحويلات، ترحيل الأرباح',
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

function has(cat, selected, wipeAll) {
  return wipeAll || (selected && selected.includes(cat)) || (selected && selected.includes('all'));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} userId
 * @param {string[]} selected
 * @param {boolean} wipeAll
 */
async function executeReset(client, userId, selected, wipeAll) {
  const s = selected || [];

  // 1) معاملات الوكالة المرتبطة بعمليات شحن (قبل حذف shipping_transactions)
  if (has('sub_agencies', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM sub_agency_transactions');
  } else if (has('shipping', s, wipeAll)) {
    await client.query('DELETE FROM sub_agency_transactions WHERE shipping_transaction_id IS NOT NULL');
  }

  // 2) الشحن
  if (has('shipping', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM shipping_carrier_transactions');
    await client.query('DELETE FROM shipping_transactions');
    await client.query('DELETE FROM shipping_inventory');
    await client.query('DELETE FROM shipping_carrier_agencies WHERE user_id = $1', [userId]);
  }

  // 3) الدورات والرواتب والمرتبط بالدورات
  if (has('payroll_cycles', s, wipeAll) || wipeAll) {
    await client.query(
      'DELETE FROM cash_box_snapshot WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
    await client.query(
      'DELETE FROM deferred_balance_users WHERE cycle_id IN (SELECT id FROM financial_cycles WHERE user_id = $1)',
      [userId]
    );
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
    await client.query('DELETE FROM payroll_cycle_cache WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM payroll_cycle_columns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM payroll_settings WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM financial_cycles WHERE user_id = $1', [userId]);
  }

  // 4) الوكالات الفرعية (بعد الدورات إن وُجدت؛ يبقى تنظيف الجداول العامة)
  if (has('sub_agencies', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM user_agency_link');
    await client.query('DELETE FROM agency_sheet_mapping');
    await client.query('DELETE FROM agency_cycle_users');
    await client.query('DELETE FROM agency_sync_log');
    await client.query('DELETE FROM sub_agency_cycle_settings');
    await client.query('DELETE FROM shipping_sub_agencies');
  }

  // 5) قوائم الشحن
  if (has('shipping_lists', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM shipping_approved');
    await client.query('DELETE FROM shipping_companies');
  }

  // 6) صناديع (قبل شركات التحويل إن كان هناك FK من funds)
  if (has('funds', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM financial_returns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM entity_payables WHERE user_id = $1', [userId]);
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

  if (has('transfer_companies', s, wipeAll) || wipeAll) {
    await client.query(
      'DELETE FROM transfer_company_ledger WHERE company_id IN (SELECT id FROM transfer_companies WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM transfer_companies WHERE user_id = $1', [userId]);
  }

  if (has('accreditations', s, wipeAll) || wipeAll) {
    await client.query(
      'DELETE FROM accreditation_ledger WHERE accreditation_id IN (SELECT id FROM accreditation_entities WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM accreditation_entities WHERE user_id = $1', [userId]);
  }

  if (has('ai', s, wipeAll) || wipeAll) {
    await client.query('DELETE FROM analysis_jobs WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM message_analyses');
    await client.query('DELETE FROM ai_config');
  }

  if (has('google_sheets', s, wipeAll) || wipeAll) {
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
