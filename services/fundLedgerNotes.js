/**
 * عناوين عربية واضحة لحركات الصندوق (عرض فقط — لا تُعدّل القيم المخزنة).
 */

function fmtAmt(n, cur) {
  const a = Math.abs(Number(n) || 0);
  const c = (cur || 'USD').trim();
  return `${a.toLocaleString('en-US', { minimumFractionDigits: 2 })} ${c}`;
}

async function getTransferCompanyName(db, userId, id, cache) {
  const k = `tc:${id}`;
  if (cache[k] !== undefined) return cache[k];
  const r = (await db.query(
    'SELECT name FROM transfer_companies WHERE id = $1 AND user_id = $2',
    [id, userId]
  )).rows[0];
  cache[k] = r?.name || null;
  return cache[k];
}

async function getFundLabel(db, userId, id, cache) {
  const k = `f:${id}`;
  if (cache[k] !== undefined) return cache[k];
  const r = (await db.query(
    'SELECT name, fund_number FROM funds WHERE id = $1 AND user_id = $2',
    [id, userId]
  )).rows[0];
  if (!r) {
    cache[k] = null;
    return null;
  }
  const num = r.fund_number ? ` — رقم ${r.fund_number}` : '';
  cache[k] = `${r.name || 'صندوق'}${num}`;
  return cache[k];
}

async function getFundTransferPeer(db, userId, ftId, cache) {
  const k = `ft:${ftId}`;
  if (cache[k] !== undefined) return cache[k];
  const r = (await db.query(
    `SELECT ft.from_fund_id, ft.to_fund_id,
            f1.name AS from_name, f1.fund_number AS from_num,
            f2.name AS to_name, f2.fund_number AS to_num
     FROM fund_transfers ft
     JOIN funds f1 ON f1.id = ft.from_fund_id AND f1.user_id = $2
     JOIN funds f2 ON f2.id = ft.to_fund_id AND f2.user_id = $2
     WHERE ft.id = $1`,
    [ftId, userId]
  )).rows[0];
  cache[k] = r || null;
  return cache[k];
}

/**
 * @param {import('../db/database').Db} db
 * @param {number} userId
 * @param {object} row — صف من fund_ledger
 * @param {Record<string,string|null>} cache
 */
async function buildDisplayNote(db, userId, row, cache) {
  const base = row.notes && String(row.notes).trim() ? String(row.notes).trim() : '';
  const t = String(row.type || '').trim();
  const amt = Number(row.amount) || 0;
  const cur = row.currency || 'USD';
  const absStr = fmtAmt(amt, cur);
  const rt = row.ref_table;
  const rid = row.ref_id != null ? parseInt(row.ref_id, 10) : null;

  try {
    if (t === 'company_payout' && amt < 0 && rt === 'transfer_companies' && rid) {
      const name = await getTransferCompanyName(db, userId, rid, cache);
      if (name) return `تم تحويل ${absStr} إلى شركة التحويل «${name}»`;
    }
    if (t === 'fund_allocation' && amt < 0 && rt === 'funds' && rid) {
      const label = await getFundLabel(db, userId, rid, cache);
      if (label) return `تم تحويل ${absStr} إلى صندوق ${label}`;
    }
    if (t === 'fund_receive_from_main' && amt > 0 && rt === 'funds' && rid) {
      const label = await getFundLabel(db, userId, rid, cache);
      if (label) return `وارد ${absStr} من الصندوق المصدر «${label}»`;
    }
    if (t === 'transfer_out' && amt < 0 && rt === 'fund_transfers' && rid) {
      const ft = await getFundTransferPeer(db, userId, rid, cache);
      if (ft) {
        const toLabel = await getFundLabel(db, userId, ft.to_fund_id, cache);
        if (toLabel) return `تم تحويل ${absStr} إلى صندوق ${toLabel}`;
      }
    }
    if (t === 'transfer_in' && amt > 0 && rt === 'fund_transfers' && rid) {
      const ft = await getFundTransferPeer(db, userId, rid, cache);
      if (ft) {
        const fromLabel = await getFundLabel(db, userId, ft.from_fund_id, cache);
        if (fromLabel) return `وارد ${absStr} من صندوق ${fromLabel}`;
      }
    }
    if ((t === 'salary_swap_cash' || t === 'salary_swap_installment') && rt === 'transfer_companies' && rid) {
      const name = await getTransferCompanyName(db, userId, rid, cache);
      if (name) return `${base || t} — شركة التحويل: «${name}»`;
    }
    if (t === 'shipping_sale_cash' && amt > 0) {
      return base ? `إيداع بيع شحن — ${base}` : `إيداع بيع شحن ${absStr}`;
    }
    if (t === 'shipping_buy_cash' && amt < 0) {
      return base ? `خصم شراء شحن — ${base}` : `خصم شراء شحن ${absStr}`;
    }
    if (t === 'accreditation_transfer_from_main' && amt < 0) {
      return base || `خصم من الصندوق الرئيسي للمعتمد — ${absStr}`;
    }
    if (t === 'accreditation_transfer_payable' && Math.abs(amt) < 0.0001) {
      return base || 'تسجيل التزام معتمد (دين علينا) — دون تغيير الرصيد النقدي للصندوق';
    }
    if (t === 'accreditation_transfer_in' && amt > 0 && rt === 'accreditation_entities' && rid) {
      return base || `إيداع تحويل معتمد — ${absStr}`;
    }
  } catch (_) {
    /* keep base */
  }
  return base || null;
}

/**
 * يضيف الحقل displayNotes لكل صف (للواجهة).
 */
async function enrichFundLedgerDisplayNotes(db, userId, rows) {
  if (!rows || !rows.length) return rows;
  const cache = {};
  const out = [];
  for (const row of rows) {
    const displayNotes = await buildDisplayNote(db, userId, row, cache);
    out.push({
      ...row,
      displayNotes: displayNotes || row.notes || null,
    });
  }
  return out;
}

module.exports = {
  enrichFundLedgerDisplayNotes,
  buildDisplayNote,
};
