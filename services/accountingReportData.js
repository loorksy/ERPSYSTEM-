/**
 * تجميع بيانات التقارير المحاسبية (PDF).
 */

const { sumLedgerBucket, sumExpenseEntries, aggregateNetProfitBySource } = require('./ledgerService');
const { computeDebtBreakdown, computeReceivablesToUs } = require('./debtAggregation');
const { getFundTotalsByCurrency, getMainFundSummary, getMainFundUsdBalance } = require('./fundService');
const { sumDeferredTotalAllCycles } = require('./deferredSalaryService');
const { computePaymentDue } = require('./paymentDueService');

const ROW_LIMIT = 600;

async function ensureCycleOwnership(db, userId, cycleId) {
  if (!cycleId) return null;
  const r = await db.query('SELECT id, name FROM financial_cycles WHERE id = $1 AND user_id = $2', [cycleId, userId]);
  return r.rows[0] || null;
}

async function calculateSubAgencyBalance(db, subAgencyId) {
  const rows = (
    await db.query(
      `SELECT type, SUM(amount) as total
       FROM sub_agency_transactions
       WHERE sub_agency_id = $1
       GROUP BY type`,
      [subAgencyId]
    )
  ).rows;
  let balance = 0;
  rows.forEach((r) => {
    const t = r.total || 0;
    if (r.type === 'profit' || r.type === 'reward') balance += t;
    else if (r.type === 'deduction' || r.type === 'due') balance -= t;
  });
  return balance;
}

/**
 * ملخص مطابق تقريباً لـ /dashboard/stats
 */
async function getSummarySnapshot(db, userId, cycleId) {
  const cycles = (await db.query('SELECT id, name FROM financial_cycles WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows;
  const defaultCycleId = cycleId || cycles[0]?.id || null;

  const shipRows = (
    await db.query(`
      SELECT type, item_type, SUM(quantity) as sum_qty
      FROM shipping_transactions
      GROUP BY type, item_type
    `)
  ).rows;
  let goldBalance = 0;
  let crystalBalance = 0;
  shipRows.forEach((r) => {
    const qty = r.sum_qty || 0;
    if (r.item_type === 'gold') {
      if (r.type === 'buy') goldBalance += qty;
      else goldBalance -= qty;
    } else if (r.item_type === 'crystal') {
      if (r.type === 'buy') crystalBalance += qty;
      else crystalBalance -= qty;
    }
  });
  const shippingBalance = goldBalance + crystalBalance;

  const sellAgg = (
    await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'debt' THEN total ELSE 0 END), 0)::float AS revenue_completed,
        COALESCE(SUM(total), 0)::float AS revenue_all,
        COALESCE(SUM(profit_amount), 0)::float AS profit_sum,
        COALESCE(SUM(capital_amount), 0)::float AS capital_sum,
        COALESCE(SUM(CASE WHEN status = 'debt' THEN total ELSE 0 END), 0)::float AS debt_sell
      FROM shipping_transactions WHERE type = 'sell'
    `)
  ).rows[0];
  const totalRevenue = sellAgg?.revenue_all ?? 0;
  const shippingProfit = sellAgg?.profit_sum ?? 0;
  let ledgerNetProfit = 0;
  let totalExpensesLedger = 0;
  try {
    ledgerNetProfit = await sumLedgerBucket(db, userId, 'net_profit', 'USD');
    totalExpensesLedger = await sumLedgerBucket(db, userId, 'expense', 'USD');
  } catch (_) {
    ledgerNetProfit = 0;
    totalExpensesLedger = 0;
  }
  const netProfit = shippingProfit + ledgerNetProfit - totalExpensesLedger;
  const capitalRecovered = sellAgg?.capital_sum ?? 0;
  let shippingDebt = sellAgg?.debt_sell ?? 0;

  let debtBreakdown = {
    shippingDebt: 0,
    accreditationDebtTotal: 0,
    accreditationPayableUsd: 0,
    accreditationReceivableUsd: 0,
    payablesSumUsd: 0,
    entityPayablesFromAccTransferUsd: 0,
    entityPayablesOtherUsd: 0,
    companyDebtFromBalance: 0,
    fundDebtFromBalance: 0,
    fxSpreadSumUsd: 0,
    totalDebts: 0,
  };
  try {
    debtBreakdown = await computeDebtBreakdown(db, userId);
  } catch (_) {
    try {
      const accPay = (
        await db.query(
          `SELECT COALESCE(SUM(balance_payable), 0)::float AS t
           FROM accreditation_entities WHERE user_id = $1 AND COALESCE(balance_payable, 0) > 0.0001`,
          [userId]
        )
      ).rows[0];
      const ap = accPay?.t ?? 0;
      debtBreakdown = {
        shippingDebt,
        accreditationDebtTotal: ap,
        accreditationPayableUsd: ap,
        accreditationReceivableUsd: 0,
        payablesSumUsd: 0,
        entityPayablesFromAccTransferUsd: 0,
        entityPayablesOtherUsd: 0,
        companyDebtFromBalance: 0,
        fundDebtFromBalance: 0,
        fxSpreadSumUsd: 0,
        totalDebts: shippingDebt + ap,
      };
    } catch (__) {
      debtBreakdown = {
        shippingDebt,
        accreditationDebtTotal: 0,
        accreditationPayableUsd: 0,
        accreditationReceivableUsd: 0,
        payablesSumUsd: 0,
        entityPayablesFromAccTransferUsd: 0,
        entityPayablesOtherUsd: 0,
        companyDebtFromBalance: 0,
        fundDebtFromBalance: 0,
        fxSpreadSumUsd: 0,
        totalDebts: shippingDebt,
      };
    }
  }
  shippingDebt = debtBreakdown.shippingDebt;
  const accreditationDebtTotal = debtBreakdown.accreditationDebtTotal;
  const totalDebts = debtBreakdown.totalDebts;

  const fundTotals = await getFundTotalsByCurrency(db, userId);
  let fundUsd = 0;
  fundTotals.forEach((r) => {
    if (r.currency === 'USD') fundUsd += r.total || 0;
  });
  const mainFund = await getMainFundSummary(db, userId);
  const { usd: mainFundUsd } = await getMainFundUsdBalance(db, userId);

  let snapshotCash = 0;
  if (defaultCycleId) {
    const cashSnapshot = (
      await db.query(`SELECT cash_balance FROM cash_box_snapshot WHERE cycle_id = $1 ORDER BY snapshot_at DESC LIMIT 1`, [defaultCycleId])
    ).rows[0];
    snapshotCash = cashSnapshot?.cash_balance ?? 0;
  }

  const deferredBalance = await sumDeferredTotalAllCycles(db, userId);
  const cashBalance = (mainFundUsd || 0) + snapshotCash;

  const cycleRow = defaultCycleId ? cycles.find((c) => c.id === defaultCycleId) : null;

  return {
    cycles,
    cycleId: defaultCycleId,
    cycleName: cycleRow?.name || null,
    cashBalance,
    snapshotCash,
    fundTotals,
    mainFund,
    deferredBalance,
    shippingBalance,
    goldBalance,
    crystalBalance,
    totalRevenue,
    netProfit,
    capitalRecovered,
    totalDebts,
    shippingDebt,
    accreditationDebtTotal,
    accreditationPayableUsd: debtBreakdown.accreditationPayableUsd ?? debtBreakdown.accreditationDebtTotal,
    accreditationReceivableUsd: debtBreakdown.accreditationReceivableUsd ?? 0,
    payablesSumUsd: debtBreakdown.payablesSumUsd,
    companyDebtFromBalance: debtBreakdown.companyDebtFromBalance,
    fundDebtFromBalance: debtBreakdown.fundDebtFromBalance,
    fxSpreadSumUsd: debtBreakdown.fxSpreadSumUsd,
    mainFundUsd,
    fundUsdAll: fundUsd,
    shippingProfit,
    ledgerNetProfit,
    totalExpenses: totalExpensesLedger,
  };
}

async function getSubAgencyReportData(db, userId, subAgencyId, cycleId) {
  const agency = (await db.query(`SELECT id, name, commission_percent, company_percent, created_at FROM shipping_sub_agencies WHERE id = $1`, [subAgencyId])).rows[0];
  if (!agency) return null;
  const balance = await calculateSubAgencyBalance(db, subAgencyId);

  let txQuery = `SELECT id, sub_agency_id, type, amount, notes, cycle_id, member_user_id, shipping_transaction_id, created_at
    FROM sub_agency_transactions WHERE sub_agency_id = $1`;
  const params = [subAgencyId];
  if (cycleId) {
    txQuery += ` AND cycle_id = $2`;
    params.push(cycleId);
  }
  txQuery += ` ORDER BY created_at DESC LIMIT ${ROW_LIMIT + 1}`;
  const txRows = (await db.query(txQuery, params)).rows;
  const truncated = txRows.length > ROW_LIMIT;
  const transactions = truncated ? txRows.slice(0, ROW_LIMIT) : txRows;

  let cycleName = null;
  if (cycleId) {
    const c = await ensureCycleOwnership(db, userId, cycleId);
    cycleName = c?.name || null;
  }

  return {
    agency,
    balance,
    cycleId: cycleId || null,
    cycleName,
    transactions,
    truncated,
  };
}

async function getAccreditationsReportData(db, userId, cycleId) {
  const entities = (
    await db.query(
      `SELECT id, name, code, balance_amount, balance_payable, balance_receivable, pinned, is_primary, created_at
       FROM accreditation_entities WHERE user_id = $1
       ORDER BY is_primary DESC, pinned DESC, name`,
      [userId]
    )
  ).rows;

  let ledgerQuery = `
    SELECT l.id, l.accreditation_id, l.entry_type, l.amount, l.currency, l.direction, l.brokerage_pct, l.brokerage_amount,
           l.cycle_id, l.notes, l.created_at, e.name AS entity_name, e.code AS entity_code
    FROM accreditation_ledger l
    JOIN accreditation_entities e ON e.id = l.accreditation_id AND e.user_id = $1`;
  const lp = [userId];
  if (cycleId) {
    ledgerQuery += ` WHERE l.cycle_id = $2`;
    lp.push(cycleId);
  }
  ledgerQuery += ` ORDER BY l.created_at DESC LIMIT ${ROW_LIMIT + 1}`;
  const ledgerRows = (await db.query(ledgerQuery, lp)).rows;
  const truncated = ledgerRows.length > ROW_LIMIT;
  const ledger = truncated ? ledgerRows.slice(0, ROW_LIMIT) : ledgerRows;

  let cycleName = null;
  if (cycleId) {
    const c = await ensureCycleOwnership(db, userId, cycleId);
    cycleName = c?.name || null;
  }

  return { entities, ledger, truncated, cycleId: cycleId || null, cycleName };
}

async function getTransferCompaniesReportData(db, userId) {
  const companies = (
    await db.query(
      `SELECT id, name, country, region_syria, balance_amount, balance_currency, transfer_types, created_at
       FROM transfer_companies WHERE user_id = $1 ORDER BY name`,
      [userId]
    )
  ).rows;

  const ledgersByCompany = [];
  let totalRows = 0;
  const perCompanyLimit = 200;
  for (const c of companies) {
    if (totalRows >= ROW_LIMIT) break;
    const take = Math.min(perCompanyLimit, ROW_LIMIT - totalRows);
    const rows = (
      await db.query(
        `SELECT id, company_id, amount, currency, notes, created_at
         FROM transfer_company_ledger WHERE company_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [c.id, take + 1]
      )
    ).rows;
    const trunc = rows.length > take;
    const slice = trunc ? rows.slice(0, take) : rows;
    ledgersByCompany.push({ company: c, rows: slice, truncated: trunc });
    totalRows += slice.length;
  }

  return {
    companies,
    ledgersByCompany,
    noteNoCycle: 'دفتر شركات التحويل غير مرتبط بدورة مالية في قاعدة البيانات؛ تُعرض جميع الحركات.',
  };
}

async function getTransferCompanyLedgerReportData(db, userId, companyId) {
  const cid = parseInt(companyId, 10);
  if (!cid) return null;
  const c = (
    await db.query(
      `SELECT id, name, balance_amount, balance_currency FROM transfer_companies WHERE id = $1 AND user_id = $2`,
      [cid, userId]
    )
  ).rows[0];
  if (!c) return null;
  const rows = (
    await db.query(
      `SELECT id, amount, currency, notes, created_at FROM transfer_company_ledger WHERE company_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [cid]
    )
  ).rows;
  return { company: c, rows };
}

async function getFundLedgerReportData(db, userId, fundId) {
  const fid = parseInt(fundId, 10);
  if (!fid) return null;
  const f = (
    await db.query(
      `SELECT id, name, fund_number, is_main FROM funds WHERE id = $1 AND user_id = $2`,
      [fid, userId]
    )
  ).rows[0];
  if (!f) return null;
  const rows = (
    await db.query(
      `SELECT id, type, amount, currency, notes, ref_table, ref_id, created_at FROM fund_ledger WHERE fund_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [fid]
    )
  ).rows;
  return { fund: f, rows };
}

async function getMovementsReportData(db, userId, cycleId) {
  const cycle = cycleId ? await ensureCycleOwnership(db, userId, cycleId) : null;
  if (cycleId && !cycle) return null;

  const p = [];
  let leWhere = 'WHERE user_id = $1';
  p.push(userId);
  if (cycleId) {
    leWhere += ` AND cycle_id = $${p.length + 1}`;
    p.push(cycleId);
  }
  const ledgerEntries = (
    await db.query(
      `SELECT id, bucket, source_type, amount, currency, direction, cycle_id, ref_table, ref_id, notes, created_at
       FROM ledger_entries ${leWhere}
       ORDER BY created_at DESC LIMIT ${ROW_LIMIT + 1}`,
      p
    )
  ).rows;
  let leTrunc = ledgerEntries.length > ROW_LIMIT;
  const ledgerEntriesOut = leTrunc ? ledgerEntries.slice(0, ROW_LIMIT) : ledgerEntries;

  const ap = [userId];
  let accWhere = 'WHERE e.user_id = $1';
  if (cycleId) {
    accWhere += ` AND l.cycle_id = $2`;
    ap.push(cycleId);
  }
  const accLedger = (
    await db.query(
      `SELECT l.id, l.entry_type, l.amount, l.currency, l.cycle_id, l.notes, l.created_at,
              e.name AS entity_name, l.accreditation_id
       FROM accreditation_ledger l
       JOIN accreditation_entities e ON e.id = l.accreditation_id
       ${accWhere}
       ORDER BY l.created_at DESC LIMIT ${ROW_LIMIT + 1}`,
      ap
    )
  ).rows;
  const accTrunc = accLedger.length > ROW_LIMIT;
  const accLedgerOut = accTrunc ? accLedger.slice(0, ROW_LIMIT) : accLedger;

  const tcRows = (
    await db.query(
      `SELECT l.id, l.company_id, l.amount, l.currency, l.notes, l.created_at, c.name AS company_name
       FROM transfer_company_ledger l
       JOIN transfer_companies c ON c.id = l.company_id AND c.user_id = $1
       ORDER BY l.created_at DESC LIMIT ${ROW_LIMIT + 1}`,
      [userId]
    )
  ).rows;
  const tcTrunc = tcRows.length > ROW_LIMIT;
  const transferCompanyLedgerOut = tcTrunc ? tcRows.slice(0, ROW_LIMIT) : tcRows;

  const saParams = [];
  let saWhere = 'WHERE 1=1';
  if (cycleId) {
    saWhere += ` AND t.cycle_id = $1`;
    saParams.push(cycleId);
  }
  const subAgencyTx = (
    await db.query(
      `SELECT t.id, t.sub_agency_id, t.type, t.amount, t.notes, t.cycle_id, t.created_at, a.name AS agency_name
       FROM sub_agency_transactions t
       JOIN shipping_sub_agencies a ON a.id = t.sub_agency_id
       ${saWhere}
       ORDER BY t.created_at DESC LIMIT ${ROW_LIMIT + 1}`,
      saParams
    )
  ).rows;
  const saTrunc = subAgencyTx.length > ROW_LIMIT;
  const subAgencyTxOut = saTrunc ? subAgencyTx.slice(0, ROW_LIMIT) : subAgencyTx;

  const fundLed = (
    await db.query(
      `SELECT fl.id, fl.fund_id, fl.type, fl.amount, fl.currency, fl.notes, fl.ref_table, fl.created_at, f.name AS fund_name
       FROM fund_ledger fl
       JOIN funds f ON f.id = fl.fund_id AND f.user_id = $1
       ORDER BY fl.created_at DESC LIMIT ${ROW_LIMIT + 1}`,
      [userId]
    )
  ).rows;
  const flTrunc = fundLed.length > ROW_LIMIT;
  const fundLedgerOut = flTrunc ? fundLed.slice(0, ROW_LIMIT) : fundLed;

  return {
    cycleId: cycleId || null,
    cycleName: cycle?.name || null,
    ledgerEntries: ledgerEntriesOut,
    ledgerEntriesTruncated: leTrunc,
    accreditationLedger: accLedgerOut,
    accreditationLedgerTruncated: accTrunc,
    transferCompanyLedger: transferCompanyLedgerOut,
    transferCompanyLedgerTruncated: tcTrunc,
    subAgencyTransactions: subAgencyTxOut,
    subAgencyTransactionsTruncated: saTrunc,
    fundLedger: fundLedgerOut,
    fundLedgerTruncated: flTrunc,
    noteTransferAndFundNoCycle:
      'دفتا شركات التحويل والصناديق لا يحتويان عمود دورة؛ تُعرض أحدث الحركات بغض النظر عن الدورة.',
  };
}

async function getComprehensiveReportData(db, userId, cycleId) {
  const summary = await getSummarySnapshot(db, userId, cycleId);
  const acc = await getAccreditationsReportData(db, userId, cycleId || summary.cycleId);
  const companies = await getTransferCompaniesReportData(db, userId);
  const movements = await getMovementsReportData(db, userId, cycleId || summary.cycleId);

  const agencies = (await db.query(`SELECT id, name, commission_percent, company_percent FROM shipping_sub_agencies ORDER BY name`)).rows;
  const agencySnapshots = [];
  for (const ag of agencies.slice(0, 50)) {
    const bal = await calculateSubAgencyBalance(db, ag.id);
    agencySnapshots.push({ ...ag, balance: bal });
  }

  return {
    summary,
    accreditations: acc,
    transferCompanies: companies,
    movements,
    subAgenciesOverview: agencySnapshots,
  };
}

/**
 * نافذة زمنية للدورة: من created_at لهذه الدورة حتى created_at للدورة التالية (أو الآن).
 */
async function getCycleTimeWindow(db, userId, cycleId) {
  const cycle = await ensureCycleOwnership(db, userId, cycleId);
  if (!cycle) return null;
  const list = (
    await db.query(
      `SELECT id, name, created_at FROM financial_cycles WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    )
  ).rows;
  const idx = list.findIndex((c) => c.id === cycleId);
  if (idx < 0) return null;
  const windowStart = list[idx].created_at;
  const windowEnd = idx + 1 < list.length ? list[idx + 1].created_at : new Date();
  return { cycle, windowStart, windowEnd };
}

function aggPick(rows, sourceType) {
  const r = rows.find((x) => x.source_type === sourceType);
  return r ? Number(r.total) || 0 : 0;
}

/**
 * تقرير المطابقة — يقرأ من getSummarySnapshot وcomputeDebtBreakdown وaggregateNetProfitBySource وغيرها دون صيغ جديدة.
 */
async function getReconciliationReportData(db, userId, cycleId) {
  const summary = await getSummarySnapshot(db, userId, cycleId);
  const debt = await computeDebtBreakdown(db, userId);
  const receivables = await computeReceivablesToUs(db, userId);
  const paymentDue = await computePaymentDue(db, userId);
  const netProfitBySource = await aggregateNetProfitBySource(db, userId, 'USD');

  const debtOnUs =
    (Number(debt.accreditationPayableUsd) || 0) + (Number(debt.payablesSumUsd) || 0);

  const debtToUsRow = (
    await db.query(
      `SELECT COALESCE(SUM(balance_receivable), 0)::float AS t
       FROM accreditation_entities WHERE user_id = $1`,
      [userId]
    )
  ).rows[0];
  const debtToUs = Number(debtToUsRow?.t) || 0;

  const totalExpenses = await sumExpenseEntries(db, userId, 'USD');

  const adminBrokerageRow = (
    await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM admin_brokerage_entries WHERE user_id = $1`,
      [userId]
    )
  ).rows[0];
  const adminBrokerageSum = Number(adminBrokerageRow?.t) || 0;

  const subAgencyProfitRow = (
    await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM sub_agency_transactions WHERE type = 'profit'`,
      []
    )
  ).rows[0];
  const subAgencyProfitSum = Number(subAgencyProfitRow?.t) || 0;

  const deferredCountRow = (
    await db.query(
      `SELECT COUNT(DISTINCT member_user_id)::int AS c
       FROM deferred_salary_lines
       WHERE user_id = $1 AND COALESCE(balance_d, 0) > 0.0001`,
      [userId]
    )
  ).rows[0];
  const deferredPersonCount = deferredCountRow?.c ?? 0;

  const profitTransferDiscount = aggPick(netProfitBySource, 'transfer_discount_profit');
  const profitAccreditationBrokerage = aggPick(netProfitBySource, 'accreditation_brokerage');
  const profitAuditYz = aggPick(netProfitBySource, 'audit_management_yz');
  const profitSubAgencyCompany = aggPick(netProfitBySource, 'sub_agency_company_profit');
  const profitFxSpread = aggPick(netProfitBySource, 'fx_spread_profit');
  const shippingProfit = Number(summary.shippingProfit) || 0;

  /** بنود 7–13 بدون ازدواج: ربح الوكالة الفرعية من حركات profit فقط (سطر 10). */
  const totalProfitsSection =
    profitTransferDiscount +
    profitAccreditationBrokerage +
    profitAuditYz +
    subAgencyProfitSum +
    profitFxSpread +
    shippingProfit +
    adminBrokerageSum;

  const netResult = totalProfitsSection - totalExpenses - debtOnUs;

  return {
    cycleId: summary.cycleId,
    cycleName: summary.cycleName,
    lines: {
      mainFundUsd: Number(summary.mainFundUsd) || 0,
      debtOnUs,
      debtToUs,
      totalExpenses,
      paymentDueTotal: Number(paymentDue.totalUsd) || 0,
      deferredBalance: Number(summary.deferredBalance) || 0,
      profitTransferDiscount,
      profitAccreditationBrokerage,
      profitAuditYz,
      profitSubAgencyCompanyLedger: profitSubAgencyCompany,
      profitSubAgencyTransactionsProfit: subAgencyProfitSum,
      profitFxSpread,
      shippingProfit,
      adminBrokerageSum,
      totalProfitsSection,
    },
    settlement: {
      netResult,
      showDeficit: netResult < 0,
      deficitOrSurplusAmount: Math.abs(netResult),
      uncollectedTotal: Number(receivables.totalUsd) || 0,
      weMustPayTotal: debtOnUs,
      paymentDueOnly: Number(paymentDue.totalUsd) || 0,
      deferredBalance: Number(summary.deferredBalance) || 0,
      deferredPersonCount,
      deferredNote: 'وديعة لم يتم تسليمها بعد',
    },
    raw: { summary, debt, receivables, paymentDue },
  };
}

/**
 * صف موحّد للجدول المدمج في PDF.
 * @typedef {{ source: string, created_at: Date|string, fundName?: string, companyName?: string, entityName?: string, agencyName?: string, movementLabelAr: string, directionAr: string, amountSigned: number, flowIn: boolean, amountDisplay: number, badge: string }} UnifiedMovementRow
 */

/**
 * دمج حركات الدورة (cycle_id للجداول التي تدعمه + نافذة زمنية لبقية الجداول).
 */
async function getCycleUnifiedLedgerReportData(db, userId, cycleId) {
  const tw = await getCycleTimeWindow(db, userId, cycleId);
  if (!tw) return null;

  const { windowStart, windowEnd, cycle } = tw;
  const ws = windowStart;
  const we = windowEnd;

  const ledgerEntries = (
    await db.query(
      `SELECT id, bucket, source_type, amount, currency, direction, cycle_id, ref_table, ref_id, notes, created_at
       FROM ledger_entries
       WHERE user_id = $1 AND cycle_id = $2
       ORDER BY created_at ASC`,
      [userId, cycleId]
    )
  ).rows;

  const accLedger = (
    await db.query(
      `SELECT l.id, l.entry_type, l.amount, l.currency, l.direction, l.cycle_id, l.notes, l.created_at,
              e.name AS entity_name
       FROM accreditation_ledger l
       JOIN accreditation_entities e ON e.id = l.accreditation_id AND e.user_id = $1
       WHERE l.cycle_id = $2
       ORDER BY l.created_at ASC`,
      [userId, cycleId]
    )
  ).rows;

  const subAgencyTx = (
    await db.query(
      `SELECT t.id, t.sub_agency_id, t.type, t.amount, t.notes, t.cycle_id, t.created_at, a.name AS agency_name
       FROM sub_agency_transactions t
       JOIN shipping_sub_agencies a ON a.id = t.sub_agency_id
       WHERE t.cycle_id = $1
       ORDER BY t.created_at ASC`,
      [cycleId]
    )
  ).rows;

  const fundLed = (
    await db.query(
      `SELECT fl.id, fl.fund_id, fl.type, fl.amount, fl.currency, fl.notes, fl.ref_table, fl.created_at, f.name AS fund_name
       FROM fund_ledger fl
       JOIN funds f ON f.id = fl.fund_id AND f.user_id = $1
       WHERE fl.created_at >= $2 AND fl.created_at < $3
       ORDER BY fl.created_at ASC`,
      [userId, ws, we]
    )
  ).rows;

  const tcRows = (
    await db.query(
      `SELECT l.id, l.company_id, l.amount, l.currency, l.notes, l.created_at, c.name AS company_name
       FROM transfer_company_ledger l
       JOIN transfer_companies c ON c.id = l.company_id AND c.user_id = $1
       WHERE l.created_at >= $2 AND l.created_at < $3
       ORDER BY l.created_at ASC`,
      [userId, ws, we]
    )
  ).rows;

  const shipRows = (
    await db.query(
      `SELECT id, type, item_type, quantity, unit_price, total, payment_method, status, notes, profit_amount, created_at
       FROM shipping_transactions
       WHERE created_at >= $1 AND created_at < $2
       ORDER BY created_at ASC`,
      [ws, we]
    )
  ).rows;

  const expRows = (
    await db.query(
      `SELECT e.id, e.amount, e.currency, e.category, e.notes, e.created_at
       FROM expense_entries e
       WHERE e.user_id = $1
         AND e.id IN (
           SELECT ref_id FROM ledger_entries
           WHERE user_id = $1 AND cycle_id = $4 AND ref_table = 'expense_entries' AND ref_id IS NOT NULL
           UNION
           SELECT id FROM expense_entries
           WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
         )
       ORDER BY e.created_at ASC`,
      [userId, ws, we, cycleId]
    )
  ).rows;

  /** @type {UnifiedMovementRow[]} */
  const unified = [];

  for (const r of fundLed) {
    unified.push({
      source: 'fund',
      created_at: r.created_at,
      fundName: r.fund_name,
      movementLabelAr: '',
      directionAr: '',
      amountSigned: Number(r.amount) || 0,
      flowIn: (Number(r.amount) || 0) >= 0,
      badge: 'صندوق',
      raw: r,
    });
  }
  for (const r of tcRows) {
    unified.push({
      source: 'tc_ledger',
      created_at: r.created_at,
      companyName: r.company_name,
      movementLabelAr: 'حركة شركة تحويل',
      directionAr: (Number(r.amount) || 0) >= 0 ? 'in' : 'out',
      amountSigned: Math.abs(Number(r.amount) || 0),
      flowIn: (Number(r.amount) || 0) >= 0,
      badge: 'شركة تحويل',
      raw: r,
    });
  }
  for (const r of ledgerEntries) {
    const signed = (Number(r.amount) || 0) * (Number(r.direction) || 1);
    unified.push({
      source: 'ledger_entries',
      created_at: r.created_at,
      movementLabelAr: r.source_type || '',
      directionAr: signed >= 0 ? 'in' : 'out',
      amountSigned: Math.abs(Number(r.amount) || 0),
      flowIn: signed >= 0,
      badge: 'دفتر محاسبي',
      bucket: r.bucket,
      raw: r,
    });
  }
  for (const r of accLedger) {
    const toUs = r.direction === 'to_us' || r.direction === 'from_us';
    unified.push({
      source: 'accreditation',
      created_at: r.created_at,
      entityName: r.entity_name,
      movementLabelAr: r.entry_type || '',
      directionAr: toUs ? 'in' : 'out',
      amountSigned: Math.abs(Number(r.amount) || 0),
      flowIn: toUs,
      badge: 'اعتماد',
      raw: r,
    });
  }
  for (const r of shipRows) {
    const isSell = r.type === 'sell';
    unified.push({
      source: 'shipping',
      created_at: r.created_at,
      movementLabelAr: `${r.type}/${r.payment_method || ''}`,
      directionAr: isSell ? 'in' : 'out',
      amountSigned: Math.abs(Number(r.total) || 0),
      flowIn: isSell,
      badge: 'شحن',
      raw: r,
    });
  }
  for (const r of subAgencyTx) {
    const t = r.type;
    const flowIn = t === 'profit' || t === 'reward';
    unified.push({
      source: 'sub_agency',
      created_at: r.created_at,
      agencyName: r.agency_name,
      movementLabelAr: t || '',
      directionAr: flowIn ? 'in' : 'out',
      amountSigned: Math.abs(Number(r.amount) || 0),
      flowIn,
      badge: 'وكالة فرعية',
      raw: r,
    });
  }
  for (const r of expRows) {
    unified.push({
      source: 'expense',
      created_at: r.created_at,
      movementLabelAr: r.category || 'manual',
      directionAr: 'out',
      amountSigned: Math.abs(Number(r.amount) || 0),
      flowIn: false,
      badge: 'مصاريف',
      raw: r,
    });
  }

  unified.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let running = 0;
  const withRunning = unified.map((row) => {
    running += row.flowIn ? row.amountSigned : -row.amountSigned;
    return { ...row, runningBalance: running };
  });

  const reconciliation = await getReconciliationReportData(db, userId, cycleId);

  return {
    cycleId,
    cycleName: cycle.name,
    windowStart: ws,
    windowEnd: we,
    noteScope:
      'الجداول بدون عمود دورة (صناديق، شركات تحويل، شحن، مصاريف مرتبطة بالنافذة الزمنية) تُفلتر بالتاريخ بين بداية الدورة ونهايتها.',
    rows: withRunning,
    rowCount: withRunning.length,
    truncated: withRunning.length > ROW_LIMIT,
    reconciliation,
  };
}

/** جميع الوكالات الفرعية مع حركات ومكافأة أرباح (بدون منطق حساب جديد). */
async function getAllSubAgenciesBulkReportData(db, userId, cycleId) {
  const agencies = (await db.query(`SELECT id, name, commission_percent, company_percent FROM shipping_sub_agencies ORDER BY name`)).rows;
  const cyc = cycleId ? await ensureCycleOwnership(db, userId, cycleId) : null;
  const out = [];
  for (const ag of agencies) {
    const balance = await calculateSubAgencyBalance(db, ag.id);
    let txQuery = `SELECT id, type, amount, notes, cycle_id, created_at FROM sub_agency_transactions WHERE sub_agency_id = $1`;
    const pr = [ag.id];
    if (cycleId) {
      txQuery += ` AND cycle_id = $2`;
      pr.push(cycleId);
    }
    txQuery += ` ORDER BY created_at DESC LIMIT 301`;
    const transactions = (await db.query(txQuery, pr)).rows;
    const profitSumRow = (
      await db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS t FROM sub_agency_transactions WHERE sub_agency_id = $1 AND type = 'profit'${cycleId ? ' AND cycle_id = $2' : ''}`,
        cycleId ? [ag.id, cycleId] : [ag.id]
      )
    ).rows[0];
    const profitSum = Number(profitSumRow?.t) || 0;
    out.push({
      agency: ag,
      balance,
      profitSum,
      net: balance,
      transactions: transactions.slice(0, 300),
      truncated: transactions.length > 300,
      cycleName: cyc?.name || null,
    });
  }
  return { cycleId: cycleId || null, cycleName: cyc?.name || null, agencies: out };
}

/** جميع الصناديق مع حركة مختصرة */
async function getAllFundsBulkReportData(db, userId) {
  const funds = (
    await db.query(
      `SELECT id, name, fund_number, is_main FROM funds WHERE user_id = $1 ORDER BY is_main DESC, name`,
      [userId]
    )
  ).rows;
  const out = [];
  for (const f of funds) {
    const rows = (
      await db.query(
        `SELECT id, type, amount, currency, notes, created_at FROM fund_ledger WHERE fund_id = $1 ORDER BY created_at DESC LIMIT 201`,
        [f.id]
      )
    ).rows;
    const balRow = (
      await db.query(
        `SELECT COALESCE(amount, 0)::float AS t FROM fund_balances WHERE fund_id = $1 AND currency = 'USD'`,
        [f.id]
      )
    ).rows[0];
    out.push({
      fund: f,
      usdBalance: Number(balRow?.t) || 0,
      rows: rows.slice(0, 200),
      truncated: rows.length > 200,
    });
  }
  return { funds: out };
}

module.exports = {
  ROW_LIMIT,
  ensureCycleOwnership,
  getSummarySnapshot,
  getSubAgencyReportData,
  getAccreditationsReportData,
  getTransferCompaniesReportData,
  getTransferCompanyLedgerReportData,
  getFundLedgerReportData,
  getMovementsReportData,
  getComprehensiveReportData,
  getCycleTimeWindow,
  getReconciliationReportData,
  getCycleUnifiedLedgerReportData,
  getAllSubAgenciesBulkReportData,
  getAllFundsBulkReportData,
};
