/**
 * مزامنة رصيد «علينا» للمعتمد الرئيسي مع إجمالي المؤجل (دلتا + قيود).
 * ترحيل أول تشغيل: baseline بدون تعديل balance_payable.
 */

const { sumDeferredTotalAllCycles } = require('./deferredSalaryService');
const { readBuckets, syncNetBalance } = require('./accreditationBalance');

async function ensurePayrollSettingsRow(db, userId) {
  await db.query(
    `INSERT INTO payroll_settings (user_id, discount_rate, updated_at)
     VALUES ($1, 0, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

/**
 * @returns {Promise<{ success: boolean, baseline?: boolean, skipped?: boolean, deferredTotal?: number, balancePayableDelta?: number, message?: string }>}
 */
async function syncPrimaryAccreditationWithDeferred(db, userId) {
  try {
    await ensurePayrollSettingsRow(db, userId);
    const D = Math.round((await sumDeferredTotalAllCycles(db, userId)) * 100) / 100;

    const settings = (await db.query(
      'SELECT last_deferred_offset_applied, deferred_sync_baseline_done FROM payroll_settings WHERE user_id = $1',
      [userId]
    )).rows[0];

    const lastApplied = Number(settings?.last_deferred_offset_applied) || 0;
    const baselineDone = Number(settings?.deferred_sync_baseline_done) === 1;

    if (!baselineDone) {
      await db.query(
        `UPDATE payroll_settings SET last_deferred_offset_applied = $1::float, deferred_sync_baseline_done = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [D, userId]
      );
      return { success: true, baseline: true, deferredTotal: D, balancePayableDelta: 0 };
    }

    const delta = Math.round((D - lastApplied) * 100) / 100;
    if (Math.abs(delta) < 0.0001) {
      return { success: true, baseline: false, deferredTotal: D, balancePayableDelta: 0 };
    }

    const primary = (await db.query(
      'SELECT id FROM accreditation_entities WHERE user_id = $1 AND COALESCE(is_primary,0) = 1 LIMIT 1',
      [userId]
    )).rows[0];

    if (!primary) {
      await db.query(
        `UPDATE payroll_settings SET last_deferred_offset_applied = $1::float, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [D, userId]
      );
      return { success: true, skipped: true, reason: 'no_primary', deferredTotal: D };
    }

    const { pay, rec } = await readBuckets(db, primary.id);
    let newPay = (Number(pay) || 0) - delta;
    if (newPay < 0) newPay = 0;

    await db.query('UPDATE accreditation_entities SET balance_payable = $1 WHERE id = $2', [newPay, primary.id]);
    await syncNetBalance(db, primary.id);

    const meta = JSON.stringify({
      previousApplied: lastApplied,
      newTotalDeferred: D,
      delta,
      balancePayableBefore: pay,
      balancePayableAfter: newPay,
    });

    await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
       VALUES ($1, 'deferred_reserve_sync', $2, 'USD', $3, NULL, $4, $5)`,
      [
        primary.id,
        Math.abs(delta),
        delta > 0 ? 'from_us' : 'to_us',
        delta > 0
          ? `تعديل احتياطي مؤجل: زيادة المؤجل ${delta.toFixed(2)} — تخفيض «علينا» للمعتمد الرئيسي`
          : `إفراج احتياطي مؤجل: انخفاض المؤجل ${Math.abs(delta).toFixed(2)} — زيادة «علينا» للمعتمد الرئيسي`,
        meta,
      ]
    );

    await db.query(
      `UPDATE payroll_settings SET last_deferred_offset_applied = $1::float, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
      [D, userId]
    );

    return {
      success: true,
      baseline: false,
      deferredTotal: D,
      balancePayableDelta: -delta,
    };
  } catch (e) {
    console.error('[primaryAccreditationDeferredSync]', e.message);
    return { success: false, message: e.message || 'فشل مزامنة المؤجل مع المعتمد' };
  }
}

module.exports = {
  syncPrimaryAccreditationWithDeferred,
  ensurePayrollSettingsRow,
};
