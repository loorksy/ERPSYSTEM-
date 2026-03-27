const { getMemberProfileRow } = require('./memberDirectoryService');

async function ensureMemberProfileExists(db, userId, memberUserId) {
  const mid = String(memberUserId).trim();
  if (!mid) return;
  await db.query(
    `INSERT INTO member_profiles (user_id, member_user_id, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, member_user_id) DO NOTHING`,
    [userId, mid]
  );
}

/**
 * خصم دين على الشركة من راتب الدورة (بعد خصم نسبة التحويل). يُرجع المبلغ المخصوم من الراتب.
 */
async function applyDebtAgainstCycleSalary(db, userId, cycleId, memberUserId, cycleSalaryUsd) {
  await ensureMemberProfileExists(db, userId, memberUserId);
  const mid = String(memberUserId).trim();
  const row = await getMemberProfileRow(db, userId, mid);
  const debt = Number(row?.debt_to_company_usd || 0);
  const salary = Number(cycleSalaryUsd || 0);
  if (debt <= 0 || salary <= 0) return 0;
  const repay = Math.min(debt, salary);
  const newDebt = Math.round((debt - repay) * 100) / 100;
  await db.query(
    `UPDATE member_profiles SET debt_to_company_usd = $1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $2 AND member_user_id = $3`,
    [newDebt, userId, mid]
  );
  await db.query(
    `INSERT INTO member_profile_events (user_id, member_user_id, event_type, amount, cycle_id, notes, status)
     VALUES ($1, $2, 'debt_cycle_repay', $3, $4, $5, 'done')`,
    [
      userId,
      mid,
      -repay,
      cycleId || null,
      `تم خصم دين سابق من راتب الدورة (${repay} من أصل دين ${debt})`,
    ]
  );
  return repay;
}

async function processAdjustment(db, userId, { memberUserId, kind, amount, notes, cycleId, syncUserInfoSheet, userInfoUserIdCol, userInfoSalaryCol }) {
  const amt = Math.abs(Number(amount));
  if (!amt || Number.isNaN(amt)) return { success: false, message: 'مبلغ غير صالح' };
  const mid = String(memberUserId || '').trim();
  if (!mid) return { success: false, message: 'رقم المستخدم مطلوب' };
  const k = String(kind || '').toLowerCase();
  if (!['deduct', 'add', 'reward'].includes(k)) return { success: false, message: 'نوع غير صالح' };

  await ensureMemberProfileExists(db, userId, mid);
  const profile = await getMemberProfileRow(db, userId, mid);
  let def = Number(profile?.deferred_balance_usd || 0);
  let sal = Number(profile?.total_salary_audited_usd || 0);
  let debt = Number(profile?.debt_to_company_usd || 0);

  const ins = await db.query(
    `INSERT INTO member_adjustments (user_id, member_user_id, kind, amount, status, notes, cycle_id, processed_at)
     VALUES ($1, $2, $3, $4, 'processing', $5, $6, NULL) RETURNING id`,
    [userId, mid, k, amt, notes || null, cycleId || null]
  );
  const adjId = ins.rows[0].id;

  try {
    if (k === 'deduct') {
      let rem = amt;
      const takeDef = Math.min(rem, Math.max(0, def));
      def = Math.round((def - takeDef) * 100) / 100;
      rem = Math.round((rem - takeDef) * 100) / 100;
      const takeSal = Math.min(rem, Math.max(0, sal));
      sal = Math.round((sal - takeSal) * 100) / 100;
      rem = Math.round((rem - takeSal) * 100) / 100;
      debt = Math.round((debt + rem) * 100) / 100;
      await db.query(
        `UPDATE member_profiles SET deferred_balance_usd = $1, total_salary_audited_usd = $2, debt_to_company_usd = $3, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $4 AND member_user_id = $5`,
        [def, sal, debt, userId, mid]
      );
      await db.query(
        `INSERT INTO member_profile_events (user_id, member_user_id, event_type, amount, cycle_id, notes, status, meta_json)
         VALUES ($1, $2, 'adjustment_deduct', $3, $4, $5, 'done', $6)`,
        [
          userId,
          mid,
          -amt,
          cycleId || null,
          notes || 'خصم',
          JSON.stringify({ adjustmentId: adjId }),
        ]
      );
    } else {
      def = Math.round((def + amt) * 100) / 100;
      await db.query(
        `UPDATE member_profiles SET deferred_balance_usd = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND member_user_id = $3`,
        [def, userId, mid]
      );
      const ev = k === 'reward' ? 'adjustment_reward' : 'adjustment_add';
      await db.query(
        `INSERT INTO member_profile_events (user_id, member_user_id, event_type, amount, cycle_id, notes, status, meta_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'done', $7)`,
        [
          userId,
          mid,
          ev,
          amt,
          cycleId || null,
          notes || (k === 'reward' ? 'مكافأة' : 'إضافة'),
          JSON.stringify({ adjustmentId: adjId }),
        ]
      );
    }
    await db.query(
      `UPDATE member_adjustments SET status = 'done', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [adjId]
    );

    let sheetSynced = false;
    let sheetMessage = '';
    const doSheet = syncUserInfoSheet !== false;
    if (doSheet) {
      try {
        const { applyAdjustmentToUserInfoGoogleSheet } = require('./memberAdjustmentSheetsSync');
        const sr = await applyAdjustmentToUserInfoGoogleSheet(db, userId, {
          cycleId,
          memberUserId: mid,
          kind: k,
          amount: amt,
          userInfoUserIdCol: userInfoUserIdCol || 'C',
          userInfoSalaryCol: userInfoSalaryCol || 'L',
        });
        sheetSynced = sr.sheetSynced;
        sheetMessage = sr.sheetMessage || '';
      } catch (sheetErr) {
        sheetMessage = sheetErr.message || String(sheetErr);
      }
    }

    return { success: true, id: adjId, sheetSynced, sheetMessage };
  } catch (e) {
    await db.query(`UPDATE member_adjustments SET status = 'failed' WHERE id = $1`, [adjId]);
    throw e;
  }
}

module.exports = {
  ensureMemberProfileExists,
  applyDebtAgainstCycleSalary,
  processAdjustment,
};
