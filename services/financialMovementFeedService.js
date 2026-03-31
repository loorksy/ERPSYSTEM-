/**
 * سجل موحّد للحركات المالية ذات الصلة بـ «دين لنا» و«دين علينا» و«الالتزامات».
 * bucket: payable = entity_payables | receivable = لنا (يبقى عند الكيان) | obligation = مكوّنات الالتزامات | transfer = ترحيل نقدي لصندوق (ليس «دين لنا»)
 */
const { computeDebtBreakdown, computeReceivablesToUs } = require('./debtAggregation');

function iso(d) {
  if (!d) return null;
  try {
    const x = d instanceof Date ? d : new Date(d);
    return Number.isNaN(x.getTime()) ? null : x.toISOString();
  } catch (_) {
    return null;
  }
}

function itemBase(id, bucket, kind, occurredAt, amount, currency, titleAr, summaryAr, whyAr, howAr, linkUrl, detail) {
  const cur = currency || 'USD';
  const amt = parseFloat(amount) || 0;
  const usdEquiv = cur === 'USD' || cur === '' ? Math.abs(amt) : Math.abs(amt);
  return {
    id,
    bucket,
    kind,
    occurredAt: iso(occurredAt),
    amount: amt,
    currency: cur,
    amountUsdApprox: usdEquiv,
    titleAr,
    summaryAr: summaryAr || '',
    whyAr: whyAr || '',
    howAr: howAr || '',
    linkUrl: linkUrl || null,
    detail: detail || {},
  };
}

/**
 * @param {object} db
 * @param {number} userId
 * @param {{ limit?: number, bucket?: 'all'|'payable'|'receivable'|'obligation'|'transfer' }} [opts]
 */
async function buildFinancialMovementFeed(db, userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 400, 50), 800);
  const breakdown = await computeDebtBreakdown(db, userId);
  const recv = await computeReceivablesToUs(db, userId);

  let items = [];

  const epRows = (await db.query(
    `SELECT ep.id, ep.entity_type, ep.entity_id, ep.amount, ep.currency, ep.notes, ep.settlement_mode, ep.created_at,
            f.name AS fund_name, tc.name AS company_name
     FROM entity_payables ep
     LEFT JOIN funds f ON ep.entity_type = 'fund' AND f.id = ep.entity_id AND f.user_id = ep.user_id
     LEFT JOIN transfer_companies tc ON ep.entity_type = 'transfer_company' AND tc.id = ep.entity_id AND tc.user_id = ep.user_id
     WHERE ep.user_id = $1
     ORDER BY ep.created_at DESC
     LIMIT $2`,
    [userId, limit]
  )).rows;

  for (const ep of epRows) {
    const en = ep.entity_type === 'fund' ? ep.fund_name : ep.company_name;
    const entLabel = ep.entity_type === 'fund' ? 'صندوق' : 'شركة تحويل';
    items.push(
      itemBase(
        `ep-${ep.id}`,
        'payable',
        'entity_payable',
        ep.created_at,
        ep.amount,
        ep.currency,
        `دين علينا — ${entLabel}${en ? ` (${en})` : ''}`,
        ep.notes || '—',
        ep.notes || 'مُسجَّل كالتزام صريح تجاه الكيان.',
        'إدراج في جدول التزامات entity_payables (يمكن تسويته لاحقاً من صرف أو مرتجع).',
        ep.entity_type === 'fund' ? `/debts/fund/${ep.entity_id}` : `/debts/company/${ep.entity_id}`,
        ep
      )
    );
  }

  const shipRows = (await db.query(
    `SELECT id, total, quantity, item_type, status, buyer_type, created_at
     FROM shipping_transactions WHERE type = 'sell' AND status = 'debt'
     ORDER BY created_at DESC LIMIT 200`
  )).rows;

  for (const s of shipRows) {
    items.push(
      itemBase(
        `ship-${s.id}`,
        'obligation',
        'shipping_debt',
        s.created_at,
        s.total,
        'USD',
        'شحن — بيع آجل (دين)',
        `صنف: ${s.item_type || '—'} — الكمية: ${s.quantity ?? '—'}`,
        'بيع مُسجَّل كدين (آجل) في معاملات الشحن.',
        'حقل status = debt في shipping_transactions.',
        '/shipping',
        s
      )
    );
  }

  const negCos = (await db.query(
    `SELECT id, name, balance_amount, balance_currency, created_at
     FROM transfer_companies WHERE user_id = $1 AND balance_amount < -0.0001`,
    [userId]
  )).rows;

  for (const c of negCos) {
    items.push(
      itemBase(
        `tc-neg-${c.id}`,
        'obligation',
        'company_negative_balance',
        c.created_at,
        c.balance_amount,
        c.balance_currency || 'USD',
        `شركة تحويل — رصيد سالب (علينا): ${c.name || ''}`,
        'الرصيد السالب يعني التزاماً علينا تجاه الشركة في هذا الملف.',
        'يتراكم من حركات دفتر شركة التحويل (صرف، اعتمادات، إلخ).',
        'حساب مركّب من سجل transfer_company_ledger.',
        `/debts/company/${c.id}`,
        c
      )
    );
  }

  const negFunds = (await db.query(
    `SELECT f.id, f.name, fb.amount, fb.currency, f.created_at
     FROM funds f
     JOIN fund_balances fb ON fb.fund_id = f.id
     WHERE f.user_id = $1 AND fb.amount < -0.0001 AND fb.currency = 'USD'`,
    [userId]
  )).rows;

  for (const f of negFunds) {
    items.push(
      itemBase(
        `fund-neg-${f.id}`,
        'obligation',
        'fund_negative_balance',
        f.created_at,
        f.amount,
        f.currency || 'USD',
        `صندوق — رصيد سالب: ${f.name || ''}`,
        'رصيد الصندوق بالسالب يعكس التزاماً أو عجزاً نقدياً في هذا الملف.',
        'يُحسب من fund_balances و fund_ledger.',
        'مجموع حركات الصندوق.',
        `/funds/${f.id}`,
        f
      )
    );
  }

  const accPayRows = (await db.query(
    `SELECT id, name, code, balance_payable, balance_amount, created_at
     FROM accreditation_entities WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001`,
    [userId]
  )).rows;

  for (const a of accPayRows) {
    items.push(
      itemBase(
        `acc-pay-${a.id}`,
        'obligation',
        'accreditation_payable',
        a.created_at,
        a.balance_payable,
        'USD',
        `معتمد — مطلوب دفع: ${a.name || ''}`,
        `balance_payable = ${a.balance_payable}`,
        'التزام تجاه المعتمد (مطلوب تسديد).',
        'حقل balance_payable في accreditation_entities.',
        `/approvals/${a.id}`,
        a
      )
    );
  }

  let fxRows = [];
  try {
    fxRows = (await db.query(
      `SELECT id, spread_usd, notes, created_at, internal_rate, delivery_rate
       FROM fx_spread_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    )).rows;
  } catch (_) {
    fxRows = [];
  }
  for (const fx of fxRows) {
    items.push(
      itemBase(
        `fx-${fx.id}`,
        'obligation',
        'fx_spread',
        fx.created_at,
        fx.spread_usd,
        'USD',
        'فرق تصريف (التزام تقديري)',
        fx.notes || '—',
        'فرق بين سعر داخلي وسعر تسليم لشركة تحويل.',
        'تسجيل في fx_spread_entries.',
        '/fx-spread',
        fx
      )
    );
  }

  if ((breakdown.payablesSumUsd || 0) > 0.0001) {
    items.push(
      itemBase(
        'agg-entity-payables-total',
        'obligation',
        'aggregate_entity_payables',
        new Date(),
        breakdown.payablesSumUsd,
        'USD',
        'مجموع entity_payables (USD) — مكوّن إجمالي الالتزامات',
        'يُطابق مجموع السجلات المفتوحة في جدول التزامات الكيانات.',
        'يُضاف إلى إجمالي الالتزامات مع الشحن والأرصدة السالبة وغيرها.',
        'من computeDebtBreakdown.payablesSumUsd.',
        '/payables-us',
        { payablesSumUsd: breakdown.payablesSumUsd, entityPayablesFromAccTransferUsd: breakdown.entityPayablesFromAccTransferUsd }
      )
    );
  }

  const posCos = (await db.query(
    `SELECT id, name, balance_amount, balance_currency, created_at
     FROM transfer_companies WHERE user_id = $1 AND balance_amount > 0.0001`,
    [userId]
  )).rows;

  for (const c of posCos) {
    items.push(
      itemBase(
        `tc-pos-${c.id}`,
        'receivable',
        'company_positive_balance',
        c.created_at,
        c.balance_amount,
        c.balance_currency || 'USD',
        `شركة تحويل — لنا لدى الشركة: ${c.name || ''}`,
        'رصيد موجب = أصل لنا لدى شركة التحويل.',
        'حركات دفتر الشركة (صرف، دين لنا، مرتجعات، إلخ).',
        'تراكب transfer_company_ledger.',
        `/debts/company/${c.id}`,
        c
      )
    );
  }

  const subQ = (await db.query(`
    SELECT s.id, s.name,
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0) AS balance
    FROM shipping_sub_agencies s
    LEFT JOIN sub_agency_transactions t ON t.sub_agency_id = s.id
    GROUP BY s.id, s.name
    HAVING (
      COALESCE(SUM(CASE WHEN t.type IN ('profit', 'reward') THEN t.amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type IN ('deduction', 'due') THEN t.amount ELSE 0 END), 0)
    ) < -0.0001
    ORDER BY s.name
  `)).rows;

  for (const s of subQ) {
    const amt = Math.abs(s.balance || 0);
    items.push(
      itemBase(
        `sub-${s.id}`,
        'receivable',
        'sub_agency_receivable',
        new Date(),
        amt,
        'USD',
        `وكالة فرعية — لنا: ${s.name || ''}`,
        'رصيد الوكالة سالب = لصالحنا وفق حركات الوكالة.',
        'مجموع مكافآت/أرباح ناقص خصومات في sub_agency_transactions.',
        'حساب تراكمي على الوكالة.',
        `/sub-agencies/${s.id}`,
        s
      )
    );
  }

  const accNeg = (await db.query(
    `SELECT id, name, code, balance_amount, created_at FROM accreditation_entities
     WHERE user_id = $1 AND balance_amount < -0.0001 ORDER BY name`,
    [userId]
  )).rows;

  for (const a of accNeg) {
    items.push(
      itemBase(
        `acc-recv-${a.id}`,
        'receivable',
        'accreditation_receivable',
        a.created_at,
        Math.abs(a.balance_amount),
        'USD',
        `معتمد — لنا عليه: ${a.name || ''}`,
        `balance_amount سالب = لنا على المعتمد.`,
        'رصيد المعتمد سالب يعني مطلوب منه لنا.',
        'حقل balance_amount في accreditation_entities.',
        `/approvals/${a.id}`,
        a
      )
    );
  }

  const members = (await db.query(
    `SELECT member_user_id, debt_to_company_usd, updated_at, created_at FROM member_profiles
     WHERE user_id = $1 AND COALESCE(debt_to_company_usd, 0) > 0.0001`,
    [userId]
  )).rows;

  for (const m of members) {
    items.push(
      itemBase(
        `mem-${encodeURIComponent(m.member_user_id)}`,
        'receivable',
        'member_debt_to_company',
        m.updated_at || m.created_at,
        m.debt_to_company_usd,
        'USD',
        `مستخدم — دين على العضو`,
        `المعرف: ${m.member_user_id}`,
        'دين مسجّل على العضو لصالح الشركة.',
        'member_profiles.debt_to_company_usd.',
        '/member-directory',
        m
      )
    );
  }

  const retRows = (await db.query(
    `SELECT id, entity_type, entity_id, amount, currency, payables_settled, net_amount, disposition, target_fund_id, notes, created_at
     FROM financial_returns WHERE user_id = $1 AND cancelled_at IS NULL
     ORDER BY created_at DESC LIMIT 150`,
    [userId]
  )).rows;

  for (const r of retRows) {
    const net = r.net_amount != null ? parseFloat(r.net_amount) : Math.max(0, parseFloat(r.amount) - (parseFloat(r.payables_settled) || 0));
    const dispAr = r.disposition === 'transfer_to_fund' ? 'ترحيل لصندوق' : 'يبقى لدى الكيان';
    /** ترحيل لصندوق = حركة نقدية داخلية، لا تُعرَض ضمن «دين لنا» */
    const bucket = r.disposition === 'transfer_to_fund' ? 'transfer' : 'receivable';
    const title =
      r.disposition === 'transfer_to_fund'
        ? `مرتجع — ترحيل نقدي (${dispAr})`
        : `مرتجع — يبقى لدى الكيان (دين لنا صافٍ)`;
    items.push(
      itemBase(
        `fr-${r.id}`,
        bucket,
        'financial_return',
        r.created_at,
        r.amount,
        r.currency || 'USD',
        title,
        r.notes || `إجمالي ${r.amount} — تسوية دين علينا: ${r.payables_settled || 0} — صافٍ: ${net}`,
        'تسجيل مرتجع مالي مع خصم دين علينا إن وُجد.',
        'جدول financial_returns + قيود الدفتر المرتبطة.',
        r.entity_type === 'fund' ? `/funds/${r.entity_id}` : `/transfer-companies`,
        r
      )
    );
  }

  items.sort((a, b) => {
    const ta = a.occurredAt ? new Date(a.occurredAt).getTime() : 0;
    const tb = b.occurredAt ? new Date(b.occurredAt).getTime() : 0;
    return tb - ta;
  });

  const rawBucket = String(opts.bucket || 'all').toLowerCase().trim();
  const allowedBuckets = new Set(['all', 'payable', 'receivable', 'obligation', 'transfer']);
  const bucketFilter = allowedBuckets.has(rawBucket) ? rawBucket : 'all';
  if (bucketFilter === 'payable') items = items.filter((i) => i.bucket === 'payable');
  else if (bucketFilter === 'receivable') items = items.filter((i) => i.bucket === 'receivable');
  else if (bucketFilter === 'obligation') items = items.filter((i) => i.bucket === 'obligation');
  else if (bucketFilter === 'transfer') items = items.filter((i) => i.bucket === 'transfer');

  const totalObligationUsd =
    (breakdown.totalDebts || 0) + (breakdown.fxSpreadSumUsd || 0);

  return {
    breakdown,
    receivablesSummary: {
      totalUsd: recv.totalUsd,
      returnsPendingUsd: recv.returnsPendingUsd,
    },
    totals: {
      /** إجمالي التزامات من الحاسبة + فرق تصريف */
      totalObligationUsd,
      totalDebtsFromBreakdown: breakdown.totalDebts,
      fxSpreadSumUsd: breakdown.fxSpreadSumUsd,
      payablesSumUsd: breakdown.payablesSumUsd,
      receivablesToUsUsd: recv.totalUsd,
    },
    items: items.slice(0, limit),
    bucketFilter,
  };
}

module.exports = { buildFinancialMovementFeed };
