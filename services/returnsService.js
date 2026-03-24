const { runTransaction } = require('../db/database');

/**
 * تسجيل مرتجع مالي وربطه بالسجلات عند الترحيل لصندوق.
 * @param {import('../db/database').getDb} db
 * @param {number} userId
 * @param {object} body
 */
async function createReturn(db, userId, body) {
  const entityType = body.entityType === 'fund' ? 'fund' : 'transfer_company';
  const entityId = parseInt(body.entityId, 10);
  const amount = parseFloat(body.amount);
  const currency = (body.currency || 'USD').trim();
  const disposition = body.disposition === 'transfer_to_fund' ? 'transfer_to_fund' : 'remain_at_entity';
  const targetFundId = body.targetFundId ? parseInt(body.targetFundId, 10) : null;
  const sentAmount = body.sentAmount != null ? parseFloat(body.sentAmount) : null;
  const utilizedAmount = body.utilizedAmount != null ? parseFloat(body.utilizedAmount) : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!entityId || isNaN(amount) || amount <= 0) {
    throw new Error('معرف الكيان ومبلغ المرتجع مطلوبان');
  }

  if (disposition === 'transfer_to_fund' && !targetFundId) {
    throw new Error('اختر صندوق الترحيل');
  }

  if (entityType === 'transfer_company') {
    const row = (await db.query(
      'SELECT id FROM transfer_companies WHERE id = $1 AND user_id = $2',
      [entityId, userId]
    )).rows[0];
    if (!row) throw new Error('شركة غير موجودة');
  } else {
    const row = (await db.query(
      'SELECT id FROM funds WHERE id = $1 AND user_id = $2',
      [entityId, userId]
    )).rows[0];
    if (!row) throw new Error('صندوق غير موجود');
    if (disposition === 'transfer_to_fund' && targetFundId === entityId) {
      throw new Error('لا يمكن الترحيل لنفس الصندوق');
    }
  }

  if (disposition === 'transfer_to_fund') {
    const tf = (await db.query(
      'SELECT id FROM funds WHERE id = $1 AND user_id = $2',
      [targetFundId, userId]
    )).rows[0];
    if (!tf) throw new Error('صندوق الوجهة غير موجود');
  }

  let returnId;

  await runTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO financial_returns (
        user_id, entity_type, entity_id, amount, currency, sent_amount, utilized_amount,
        disposition, target_fund_id, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        userId,
        entityType,
        entityId,
        amount,
        currency,
        Number.isFinite(sentAmount) ? sentAmount : null,
        Number.isFinite(utilizedAmount) ? utilizedAmount : null,
        disposition,
        disposition === 'transfer_to_fund' ? targetFundId : null,
        notes,
      ]
    );
    returnId = ins.rows[0].id;
    const noteLine = notes || `مرتجع #${returnId}`;

    if (entityType === 'transfer_company') {
      if (disposition === 'transfer_to_fund') {
        await client.query(
          `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [entityId, -amount, currency, `مرتجع إلى صندوق — ${noteLine}`, 'financial_returns', returnId]
        );
        await client.query(
          'UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3',
          [-amount, entityId, userId]
        );
        await client.query(
          `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
           ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
          [targetFundId, currency, amount]
        );
        await client.query(
          `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            targetFundId,
            'return_in',
            amount,
            currency,
            `مرتجع من شركة تحويل — ${noteLine}`,
            'financial_returns',
            returnId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [entityId, 0, currency, `تعريف مرتجع (يبقى لدى الشركة) — ${amount} ${currency} — ${noteLine}`, 'financial_returns', returnId]
        );
      }
    } else {
      /* صندوق مصدر */
      if (disposition === 'transfer_to_fund') {
        await client.query(
          `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
           ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
          [entityId, currency, -amount]
        );
        await client.query(
          `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entityId, 'return_out', -amount, currency, `مرتجع صادر إلى صندوق آخر — ${noteLine}`, 'financial_returns', returnId]
        );
        await client.query(
          `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
           ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
          [targetFundId, currency, amount]
        );
        await client.query(
          `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            targetFundId,
            'return_in',
            amount,
            currency,
            `مرتجع وارد من صندوق — ${noteLine}`,
            'financial_returns',
            returnId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entityId, 'return_recorded', 0, currency, `تعريف مرتجع (يبقى بالصندوق) — ${amount} ${currency} — ${noteLine}`, 'financial_returns', returnId]
        );
      }
    }
  });

  return { id: returnId };
}

async function listReturnsForEntity(db, userId, entityType, entityId) {
  const et = entityType === 'fund' ? 'fund' : 'transfer_company';
  const eid = parseInt(entityId, 10);
  if (!eid) return [];
  const rows = (await db.query(
    `SELECT * FROM financial_returns WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC LIMIT 100`,
    [userId, et, eid]
  )).rows;
  return rows;
}

module.exports = { createReturn, listReturnsForEntity };
