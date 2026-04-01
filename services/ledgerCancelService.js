const { runTransaction } = require('../db/database');

const BLOCKED_FUND_TYPES = new Set(['opening_reference', 'movement_cancel', 'net_profit_mirror']);

/** أنواع معروفة في entity_payables — أي اسم جدول/كيان آخر يُمرَّر إن وافق نمطاً آمناً */
const ENTITY_PAYABLE_TYPES = new Set(['fund', 'transfer_company', 'shipping_company', 'sub_agency']);

function normalizeEntityPayableType(raw) {
  if (raw == null || raw === '') return 'transfer_company';
  const t = String(raw).trim();
  if (t === 'company') return 'transfer_company';
  if (ENTITY_PAYABLE_TYPES.has(t)) return t;
  if (/^[a-z][a-z0-9_]*$/i.test(t) && t.length <= 64) return t;
  return 'transfer_company';
}

function canCancelFundLedgerRow(row) {
  if (!row || row.cancelled_at) return false;
  if (row.type === 'movement_cancel') return false;
  if (BLOCKED_FUND_TYPES.has(row.type)) return false;
  if (row.ref_table === 'financial_returns' && row.ref_id) return true;
  if (row.movement_group_id) return true;
  if (row.ref_table === 'fund_transfers' && row.ref_id) return true;
  return false;
}

function canCancelCompanyLedgerRow(row) {
  if (!row || row.cancelled_at) return false;
  if (row.ref_table === 'financial_returns' && row.ref_id) return true;
  if (row.movement_group_id) return true;
  return false;
}

async function reverseFundLedgerRow(client, userId, row) {
  const own = (await client.query('SELECT 1 FROM funds f WHERE f.id = $1 AND f.user_id = $2', [row.fund_id, userId])).rows[0];
  if (!own) throw new Error('غير مصرح');
  if (row.cancelled_at) throw new Error('الحركة ملغاة مسبقاً');
  const cur = row.currency || 'USD';
  const amt = parseFloat(row.amount) || 0;
  const rev = -amt;
  await client.query(
    `INSERT INTO fund_balances (fund_id, currency, amount) VALUES ($1, $2, $3)
     ON CONFLICT (fund_id, currency) DO UPDATE SET amount = fund_balances.amount + $3`,
    [row.fund_id, cur, rev]
  );
  const ins = await client.query(
    `INSERT INTO fund_ledger (fund_id, type, amount, currency, notes, ref_table, ref_id)
     VALUES ($1, 'movement_cancel', $2, $3, $4, 'fund_ledger', $5) RETURNING id`,
    [row.fund_id, rev, cur, `إلغاء حركة دفتر صندوق #${row.id}`, row.id]
  );
  const revId = ins.rows[0].id;
  await client.query(
    'UPDATE fund_ledger SET cancelled_at = CURRENT_TIMESTAMP, cancelled_by_ledger_id = $1 WHERE id = $2',
    [revId, row.id]
  );
  return revId;
}

async function reverseCompanyLedgerRow(client, userId, row) {
  const own = (await client.query(
    'SELECT 1 FROM transfer_companies tc WHERE tc.id = $1 AND tc.user_id = $2',
    [row.company_id, userId]
  )).rows[0];
  if (!own) throw new Error('غير مصرح');
  if (row.cancelled_at) throw new Error('الحركة ملغاة مسبقاً');
  const cur = row.currency || 'USD';
  const amt = parseFloat(row.amount) || 0;
  const rev = -amt;
  await client.query(
    'UPDATE transfer_companies SET balance_amount = balance_amount + $1 WHERE id = $2 AND user_id = $3',
    [rev, row.company_id, userId]
  );
  const ins = await client.query(
    `INSERT INTO transfer_company_ledger (company_id, amount, currency, notes, ref_table, ref_id)
     VALUES ($1, $2, $3, $4, 'transfer_company_ledger', $5) RETURNING id`,
    [row.company_id, rev, cur, `إلغاء حركة دفتر شركة #${row.id}`, row.id]
  );
  const revId = ins.rows[0].id;
  await client.query(
    'UPDATE transfer_company_ledger SET cancelled_at = CURRENT_TIMESTAMP, cancelled_by_ledger_id = $1 WHERE id = $2',
    [revId, row.id]
  );
  return revId;
}

async function restorePayablesFromPayload(client, userId, payload) {
  if (!payload || !payload.payablesSettled || payload.payablesSettled <= 0.0001) return;
  const ps = parseFloat(payload.payablesSettled) || 0;
  if (ps <= 0) return;

  let working = payload;
  if (payload.kind === 'financial_return' && payload.returnId) {
    const missingType = payload.entityType == null || String(payload.entityType).trim() === '';
    const missingId = payload.entityId == null;
    if (missingType || missingId) {
      const rid = parseInt(payload.returnId, 10);
      if (rid) {
        const fr = (await client.query(
          'SELECT entity_type, entity_id, currency FROM financial_returns WHERE id = $1 AND user_id = $2',
          [rid, userId]
        )).rows[0];
        if (fr) {
          working = Object.assign({}, payload, {
            entityType: missingType ? fr.entity_type : payload.entityType,
            entityId: missingId ? fr.entity_id : payload.entityId,
            currency: payload.currency || fr.currency || 'USD',
          });
        }
      }
    }
  }

  const cur = (working.currency || 'USD').trim();
  if (working.kind === 'receive_from_main' && working.targetFundId) {
    await client.query(
      `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
       VALUES ($1, 'fund', $2, $3, $4, $5, 'payable')`,
      [userId, working.targetFundId, ps, cur, 'استرجاع من إلغاء تحويل (وارد من الرئيسي)']
    );
    return;
  }
  if (working.kind === 'company_payout' && working.companyId) {
    await client.query(
      `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
       VALUES ($1, 'transfer_company', $2, $3, $4, $5, 'payable')`,
      [userId, working.companyId, ps, cur, 'استرجاع من إلغاء صرف لشركة تحويل']
    );
    return;
  }
  if (working.kind === 'add_receivable' && working.companyId) {
    await client.query(
      `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
       VALUES ($1, 'transfer_company', $2, $3, $4, $5, 'payable')`,
      [userId, working.companyId, ps, cur, 'استرجاع من إلغاء «دين لنا»']
    );
    return;
  }
  if (working.kind === 'financial_return' && working.entityId != null) {
    const eid = parseInt(working.entityId, 10);
    if (!eid || isNaN(eid)) return;
    const et = normalizeEntityPayableType(working.entityType);
    await client.query(
      `INSERT INTO entity_payables (user_id, entity_type, entity_id, amount, currency, notes, settlement_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, et, eid, ps, cur, 'استرجاع من إلغاء مرتجع (استعادة دين علينا)', 'payable']
    );
  }
}

async function cancelByMovementGroup(client, userId, movementGroupId) {
  const se = (await client.query(
    'SELECT payload_json FROM movement_side_effects WHERE user_id = $1 AND movement_group_id = $2',
    [userId, movementGroupId]
  )).rows[0];
  let payload = null;
  if (se && se.payload_json) {
    try {
      payload = JSON.parse(se.payload_json);
    } catch (_) {}
  }

  const fundRows = (await client.query(
    `SELECT fl.* FROM fund_ledger fl
     INNER JOIN funds f ON f.id = fl.fund_id
     WHERE fl.movement_group_id = $1 AND f.user_id = $2 AND fl.cancelled_at IS NULL`,
    [movementGroupId, userId]
  )).rows;

  const compRows = (await client.query(
    `SELECT tl.* FROM transfer_company_ledger tl
     INNER JOIN transfer_companies tc ON tc.id = tl.company_id
     WHERE tl.movement_group_id = $1 AND tc.user_id = $2 AND tl.cancelled_at IS NULL`,
    [movementGroupId, userId]
  )).rows;

  if (fundRows.length === 0 && compRows.length === 0) {
    throw new Error('لا توجد حركات نشطة مرتبطة بهذا الإلغاء');
  }

  for (const r of fundRows) {
    if (r.type === 'movement_cancel') continue;
    await reverseFundLedgerRow(client, userId, r);
  }
  for (const r of compRows) {
    await reverseCompanyLedgerRow(client, userId, r);
  }

  if (payload && payload.kind === 'fund_transfer' && payload.fundTransferId) {
    await client.query('UPDATE fund_transfers SET cancelled_at = CURRENT_TIMESTAMP WHERE id = $1', [payload.fundTransferId]);
  }

  await restorePayablesFromPayload(client, userId, payload);

  if (se) {
    await client.query('DELETE FROM movement_side_effects WHERE user_id = $1 AND movement_group_id = $2', [userId, movementGroupId]);
  }
}

async function cancelFundTransferByRef(client, userId, ftId) {
  const rows = (await client.query(
    `SELECT fl.* FROM fund_ledger fl
     INNER JOIN funds f ON f.id = fl.fund_id
     WHERE fl.ref_table = 'fund_transfers' AND fl.ref_id = $1 AND f.user_id = $2 AND fl.cancelled_at IS NULL`,
    [ftId, userId]
  )).rows;
  if (rows.length === 0) throw new Error('لا توجد حركات مرتبطة بهذا الترحيل');
  for (const r of rows) {
    if (r.type !== 'movement_cancel') await reverseFundLedgerRow(client, userId, r);
  }
  await client.query('UPDATE fund_transfers SET cancelled_at = CURRENT_TIMESTAMP WHERE id = $1', [ftId]);
}

async function cancelFinancialReturnBundle(client, userId, returnId) {
  const fr = (await client.query(
    'SELECT * FROM financial_returns WHERE id = $1 AND user_id = $2',
    [returnId, userId]
  )).rows[0];
  if (!fr) throw new Error('المرتجع غير موجود');
  if (fr.cancelled_at) throw new Error('تم إلغاء هذا المرتجع مسبقاً');

  let payload = null;
  if (fr.movement_group_id) {
    const se = (await client.query(
      'SELECT payload_json FROM movement_side_effects WHERE user_id = $1 AND movement_group_id = $2',
      [userId, fr.movement_group_id]
    )).rows[0];
    if (se && se.payload_json) {
      try {
        payload = JSON.parse(se.payload_json);
      } catch (_) {}
    }
  }

  const fundRows = (await client.query(
    `SELECT fl.* FROM fund_ledger fl
     INNER JOIN funds f ON f.id = fl.fund_id
     WHERE fl.ref_table = 'financial_returns' AND fl.ref_id = $1 AND f.user_id = $2 AND fl.cancelled_at IS NULL`,
    [returnId, userId]
  )).rows;

  const compRows = (await client.query(
    `SELECT tl.* FROM transfer_company_ledger tl
     INNER JOIN transfer_companies tc ON tc.id = tl.company_id
     WHERE tl.ref_table = 'financial_returns' AND tl.ref_id = $1 AND tc.user_id = $2 AND tl.cancelled_at IS NULL`,
    [returnId, userId]
  )).rows;

  for (const r of fundRows) {
    if (r.type !== 'movement_cancel') await reverseFundLedgerRow(client, userId, r);
  }
  for (const r of compRows) {
    await reverseCompanyLedgerRow(client, userId, r);
  }

  let restorePayload;
  if (payload && payload.kind === 'financial_return') {
    restorePayload = Object.assign({}, payload, {
      entityType:
        payload.entityType != null && String(payload.entityType).trim() !== ''
          ? payload.entityType
          : fr.entity_type,
      entityId: payload.entityId != null ? payload.entityId : fr.entity_id,
    });
  } else {
    restorePayload = {
      kind: 'financial_return',
      entityType: fr.entity_type,
      entityId: fr.entity_id,
      payablesSettled: 0,
      currency: fr.currency || 'USD',
    };
  }
  if (restorePayload.kind === 'financial_return') {
    restorePayload.entityType = normalizeEntityPayableType(restorePayload.entityType);
  }
  await restorePayablesFromPayload(client, userId, restorePayload);

  await client.query(
    'UPDATE financial_returns SET cancelled_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2',
    [returnId, userId]
  );
  if (fr.movement_group_id) {
    await client.query('DELETE FROM movement_side_effects WHERE user_id = $1 AND movement_group_id = $2', [userId, fr.movement_group_id]);
  }
}

async function cancelFundLedgerMovement(db, userId, ledgerId) {
  await runTransaction(async (client) => {
    const row = (await client.query(
      `SELECT fl.*, f.user_id AS owner_id FROM fund_ledger fl
       JOIN funds f ON f.id = fl.fund_id WHERE fl.id = $1`,
      [ledgerId]
    )).rows[0];
    if (!row || row.owner_id !== userId) throw new Error('غير مصرح أو الحركة غير موجودة');
    if (!canCancelFundLedgerRow(row)) throw new Error('لا يمكن إلغاء هذا النوع من الحركات');
    if (row.ref_table === 'financial_returns' && row.ref_id) {
      await cancelFinancialReturnBundle(client, userId, row.ref_id);
      return;
    }
    if (row.movement_group_id) {
      await cancelByMovementGroup(client, userId, row.movement_group_id);
      return;
    }
    if (row.ref_table === 'fund_transfers' && row.ref_id) {
      await cancelFundTransferByRef(client, userId, row.ref_id);
      return;
    }
    throw new Error('لا يمكن إلغاء هذه الحركة');
  });
}

async function cancelTransferCompanyLedgerMovement(db, userId, ledgerId) {
  await runTransaction(async (client) => {
    const row = (await client.query(
      `SELECT tl.*, tc.user_id AS owner_id FROM transfer_company_ledger tl
       JOIN transfer_companies tc ON tc.id = tl.company_id WHERE tl.id = $1`,
      [ledgerId]
    )).rows[0];
    if (!row || row.owner_id !== userId) throw new Error('غير مصرح أو الحركة غير موجودة');
    if (!canCancelCompanyLedgerRow(row)) throw new Error('لا يمكن إلغاء هذا النوع من الحركات');
    if (row.ref_table === 'financial_returns' && row.ref_id) {
      await cancelFinancialReturnBundle(client, userId, row.ref_id);
      return;
    }
    if (row.movement_group_id) {
      await cancelByMovementGroup(client, userId, row.movement_group_id);
      return;
    }
    throw new Error('لا يمكن إلغاء هذه الحركة — سجلات قديمة بدون ربط جماعي');
  });
}

module.exports = {
  canCancelFundLedgerRow,
  canCancelCompanyLedgerRow,
  cancelFundLedgerMovement,
  cancelTransferCompanyLedgerMovement,
};
