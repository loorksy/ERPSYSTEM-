const { adjustFundBalance, getMainFundId } = require('./fundService');
const { insertLedgerEntry, insertNetProfitLedgerAndMirrorFund } = require('./ledgerService');
const { syncNetBalance, applySalaryToThem } = require('./accreditationBalance');
const { splitDebtPayableWithDiscount, roundMoney, parseReceivableOffsetFromBody } = require('./accreditationDebtAmounts');

/**
 * استيراد أرصدة معتمدين من ملف: أعمدة A كود، B اسم، C رصيد، D معتمد رئيسي.
 * بدون وساطة: المبلغ كاملاً يزيد رصيد المعتمد ويُسجَّل في الصندوق الرئيسي (main_cash) مثل السابق.
 * مع brokeragePct (0–100): نسبة الوساطة → صافي الربح، والباقي → الصندوق الرئيسي (نفس منطق إضافة مبلغ يدويًا).
 */
function parseCsvTextToRows(text) {
  if (!text || !String(text).trim()) return [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => line.split(/[,\t]/).map((c) => c.trim()));
}

/**
 * معاينة صفوف الاستيراد (بدون تعديل قاعدة البيانات).
 * @param {any[][]} rows — صف رؤوس + بيانات
 */
function buildBulkPreview(rows) {
  if (!rows || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = row[0] != null ? String(row[0]).trim() : '';
    const name = row[1] != null ? String(row[1]).trim() : '';
    const raw = row[2];
    const bal = parseFloat(String(raw != null ? raw : '').replace(/,/g, ''));
    const parentRef = row[3] != null ? String(row[3]).trim() : '';
    let error = null;
    if (!code) error = 'كود مطلوب';
    else if (isNaN(bal) || bal <= 0) error = 'مبلغ غير صالح';
    out.push({
      lineIndex: i + 1,
      code,
      name,
      amount: bal,
      parentRef,
      valid: !error,
      error,
    });
  }
  return out;
}

/**
 * @param {object[]} items — { code, name?, amount, parentRef?, brokeragePct?, salaryDirection?, amountKind? }
 * @param {string} [amountKind] — 'salary' | 'debt_to_us' لكل صف أو افتراضي
 */
function normalizeBulkAmountKind(k) {
  if (k === 'debt_to_us') return 'debt_receivable';
  if (k === 'debt_payable_no_fund') return 'debt_payable_no_fund';
  return k || 'salary';
}

async function processAccreditationBulkRowsFromItems(db, userId, items, cycleId, defaultBrokeragePct) {
  if (!items || !items.length) {
    return { success: false, message: 'لا توجد صفوف', imported: 0, errors: [] };
  }
  const needsMainFund = items.some((it) => {
    const k = normalizeBulkAmountKind(it.amountKind);
    return k === 'salary' || k === 'debt_payable';
  });
  let mainFundId = null;
  if (needsMainFund) {
    mainFundId = await getMainFundId(db, userId);
    if (!mainFundId) {
      return { success: false, message: 'عيّن صندوقاً رئيسياً أولاً', imported: 0, errors: [] };
    }
  }
  let defPct = parseFloat(defaultBrokeragePct);
  if (isNaN(defPct) || defPct < 0) defPct = 0;
  defPct = Math.min(100, defPct);

  let ok = 0;
  const errs = [];
  const cid = cycleId ? parseInt(cycleId, 10) : null;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const code = it.code != null ? String(it.code).trim() : '';
    const name = it.name != null ? String(it.name).trim() : '';
    const bal = parseFloat(String(it.amount != null ? it.amount : '').replace(/,/g, ''));
    const parentRef = it.parentRef != null ? String(it.parentRef).trim() : '';
    let pct = it.brokeragePct != null && it.brokeragePct !== '' ? parseFloat(it.brokeragePct) : defPct;
    if (isNaN(pct) || pct < 0) pct = 0;
    pct = Math.min(100, pct);
    const salaryDirection = it.salaryDirection === 'to_them' ? 'to_them' : 'to_us';
    const amountKind = normalizeBulkAmountKind(it.amountKind);
    const discRaw = it.discountPct != null && it.discountPct !== '' ? parseFloat(it.discountPct) : null;

    if (!code || isNaN(bal) || bal <= 0) {
      errs.push(`صف ${i + 1}: بيانات غير صالحة`);
      continue;
    }

    let ent = (await db.query(
      'SELECT id, balance_payable, balance_receivable FROM accreditation_entities WHERE user_id = $1 AND (code = $2 OR name = $2) LIMIT 1',
      [userId, code]
    )).rows[0];
    if (!ent && name) {
      const ins = await db.query(
        `INSERT INTO accreditation_entities (user_id, name, code) VALUES ($1, $2, $3) RETURNING id, balance_payable, balance_receivable`,
        [userId, name, code]
      );
      ent = { id: ins.rows[0].id, balance_payable: 0, balance_receivable: 0 };
    }
    if (!ent) {
      errs.push(`صف ${i + 1}: لم يُوجد معتمد`);
      continue;
    }

    let pay = Number(ent.balance_payable) || 0;
    let rec = Number(ent.balance_receivable) || 0;

    if (amountKind === 'debt_receivable') {
      rec += bal;
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_us', $2, 'USD', 'to_us', $3, $4, $5)`,
        [ent.id, bal, cid, (it.notes && String(it.notes).trim()) || 'استيراد — دين لنا', null]
      );
      await db.query(
        'UPDATE accreditation_entities SET balance_receivable = $1 WHERE id = $2',
        [rec, ent.id]
      );
      await syncNetBalance(db, ent.id);
      ok++;
      continue;
    }

    if (amountKind === 'debt_payable') {
      const rec0 = roundMoney(rec);
      const gross = roundMoney(bal);
      const offsetBody = {
        receivableOffsetMode: it.receivableOffsetMode || 'defer',
        receivableOffsetUsd: it.receivableOffsetUsd,
      };
      let offsetUsd = 0;
      try {
        offsetUsd = parseReceivableOffsetFromBody(offsetBody, rec0, gross).s;
      } catch (e) {
        errs.push(`صف ${i + 1}: ${e.message || 'offset'}`);
        continue;
      }
      const remainingGross = roundMoney(gross - offsetUsd);
      if (remainingGross < 0) {
        errs.push(`صف ${i + 1}: المبلغ بعد خصم الدين غير صالح`);
        continue;
      }
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(remainingGross, discRaw);
      const baseMeta = metaJson ? JSON.parse(metaJson) : {};
      const debtMetaObj = {
        ...baseMeta,
        grossInputUsd: gross,
        offsetFromReceivableUsd: offsetUsd,
        remainingGrossAfterOffsetUsd: remainingGross,
      };
      const ledgerMeta = JSON.stringify(debtMetaObj);
      const noteImp =
        (it.notes && String(it.notes).trim()) ||
        (discountAmt > 0
          ? `استيراد — دين علينا (صافي بعد خصم)`
          : offsetUsd > 0
            ? `استيراد — دين علينا (بعد خصم ${offsetUsd.toFixed(2)} من دين لنا)`
            : 'استيراد — دين علينا');
      pay = roundMoney(pay + netAmt);
      rec = roundMoney(rec0 - offsetUsd);

      if (offsetUsd > 0.0001) {
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            ent.id,
            offsetUsd,
            cid,
            `استيراد — خصم من دين لنا (${gross.toFixed(2)})`,
            JSON.stringify({ grossInputUsd: gross, offsetUsd }),
          ]
        );
      }
      if (netAmt <= 0.0001 && discountAmt <= 0.0001) {
        await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
          pay,
          rec,
          ent.id,
        ]);
        await syncNetBalance(db, ent.id);
        ok++;
        continue;
      }
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [ent.id, netAmt, cid, noteImp, ledgerMeta]
      );
      const ledgerId = led.lastInsertRowid != null ? led.lastInsertRowid : led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
        pay,
        rec,
        ent.id,
      ]);
      await syncNetBalance(db, ent.id);
      if (mainFundId && netAmt > 0) {
        await adjustFundBalance(
          db,
          mainFundId,
          'USD',
          netAmt,
          'accreditation_debt_payable',
          'استيراد — دين علينا',
          'accreditation_ledger',
          ledgerId
        );
        await insertLedgerEntry(db, {
          userId,
          bucket: 'main_cash',
          sourceType: 'accreditation_debt_payable',
          amount: netAmt,
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'استيراد — دين علينا',
        });
      }
      if (discountAmt > 0) {
        await insertNetProfitLedgerAndMirrorFund(db, {
          userId,
          bucket: 'net_profit',
          sourceType: 'accreditation_payable_discount',
          amount: discountAmt,
          currency: 'USD',
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'ربح خصم من دين علينا (معتمد)',
        });
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'payable_discount_profit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            ent.id,
            discountAmt,
            cid,
            'ربح خصم من دين علينا',
            JSON.stringify({ linkedDebtLedgerId: ledgerId }),
          ]
        );
      }
      ok++;
      continue;
    }

    if (amountKind === 'debt_payable_no_fund') {
      const rec0 = roundMoney(rec);
      const gross = roundMoney(bal);
      const offsetBody = {
        receivableOffsetMode: it.receivableOffsetMode || 'defer',
        receivableOffsetUsd: it.receivableOffsetUsd,
      };
      let offsetUsd = 0;
      try {
        offsetUsd = parseReceivableOffsetFromBody(offsetBody, rec0, gross).s;
      } catch (e) {
        errs.push(`صف ${i + 1}: ${e.message || 'offset'}`);
        continue;
      }
      const remainingGross = roundMoney(gross - offsetUsd);
      if (remainingGross < 0) {
        errs.push(`صف ${i + 1}: المبلغ بعد خصم الدين غير صالح`);
        continue;
      }
      const { netAmt, discountAmt, metaJson } = splitDebtPayableWithDiscount(remainingGross, discRaw);
      const baseMeta = metaJson ? JSON.parse(metaJson) : {};
      const debtMetaObj = {
        ...baseMeta,
        grossInputUsd: gross,
        offsetFromReceivableUsd: offsetUsd,
        remainingGrossAfterOffsetUsd: remainingGross,
        noMainFund: true,
      };
      const ledgerMeta = JSON.stringify(debtMetaObj);
      const noteImp =
        (it.notes && String(it.notes).trim()) ||
        (discountAmt > 0
          ? `استيراد — لهم (صافي بعد خصم)`
          : offsetUsd > 0
            ? `استيراد — لهم (بعد خصم ${offsetUsd.toFixed(2)} من دين لنا)`
            : 'استيراد — لهم (بدون صندوق رئيسي)');
      pay = roundMoney(pay + netAmt);
      rec = roundMoney(rec0 - offsetUsd);

      if (offsetUsd > 0.0001) {
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            ent.id,
            offsetUsd,
            cid,
            `استيراد — خصم من دين لنا (${gross.toFixed(2)})`,
            JSON.stringify({ grossInputUsd: gross, offsetUsd, noMainFund: true }),
          ]
        );
      }
      if (netAmt <= 0.0001 && discountAmt <= 0.0001) {
        await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
          pay,
          rec,
          ent.id,
        ]);
        await syncNetBalance(db, ent.id);
        ok++;
        continue;
      }
      const led = await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'debt_to_them_no_fund', $2, 'USD', 'to_them', $3, $4, $5) RETURNING id`,
        [ent.id, netAmt, cid, noteImp, ledgerMeta]
      );
      const ledgerId = led.lastInsertRowid != null ? led.lastInsertRowid : led.rows[0]?.id;
      await db.query('UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3', [
        pay,
        rec,
        ent.id,
      ]);
      await syncNetBalance(db, ent.id);
      if (discountAmt > 0) {
        await insertNetProfitLedgerAndMirrorFund(db, {
          userId,
          bucket: 'net_profit',
          sourceType: 'accreditation_payable_discount',
          amount: discountAmt,
          currency: 'USD',
          cycleId: cid,
          refTable: 'accreditation_ledger',
          refId: ledgerId,
          notes: 'ربح خصم من دين لهم (معتمد — بدون صندوق)',
        });
        await db.query(
          `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
           VALUES ($1, 'payable_discount_profit', $2, 'USD', 'to_us', $3, $4, $5)`,
          [
            ent.id,
            discountAmt,
            cid,
            'ربح خصم من دين لهم',
            JSON.stringify({ linkedDebtLedgerId: ledgerId, noMainFund: true }),
          ]
        );
      }
      ok++;
      continue;
    }

    const rec0 = roundMoney(rec);
    const brokerageAmount = pct > 0 ? roundMoney(bal * (pct / 100)) : 0;
    const remainder = roundMoney(bal - brokerageAmount);
    let offsetUsd = 0;
    const offsetBody = {
      receivableOffsetMode: it.receivableOffsetMode || 'defer',
      receivableOffsetUsd: it.receivableOffsetUsd,
    };
    if (salaryDirection === 'to_us') {
      try {
        offsetUsd = parseReceivableOffsetFromBody(offsetBody, rec0, bal, {
          salaryRemainderAfterBrokerage: remainder,
        }).s;
      } catch (e) {
        errs.push(`صف ${i + 1}: ${e.message || 'offset'}`);
        continue;
      }
      pay = roundMoney(pay + bal - offsetUsd);
      rec = roundMoney(rec0 - offsetUsd);
    } else if (rec0 > 0.0001) {
      pay = roundMoney(pay + bal);
      rec = roundMoney(rec0);
    } else {
      const br = applySalaryToThem(pay, rec0, bal);
      pay = roundMoney(br.pay);
      rec = roundMoney(br.rec);
    }
    const fundDepositToUs = salaryDirection === 'to_us' ? roundMoney(remainder - offsetUsd) : 0;

    if (salaryDirection === 'to_us' && offsetUsd > 0.0001) {
      await db.query(
        `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, cycle_id, notes, meta_json)
         VALUES ($1, 'receivable_offset_from_credit', $2, 'USD', 'to_us', $3, $4, $5)`,
        [
          ent.id,
          offsetUsd,
          cid,
          'استيراد — خصم من دين لنا (راتب)',
          JSON.stringify({ grossSalaryUsd: bal, offsetUsd }),
        ]
      );
    }

    const salaryMeta =
      salaryDirection === 'to_us' && offsetUsd > 0.0001
        ? JSON.stringify({
            offsetUsd,
            grossSalaryUsd: bal,
            remainderAfterBrokerageUsd: remainder,
            fundDepositUsd: fundDepositToUs,
          })
        : null;

    const led = await db.query(
      `INSERT INTO accreditation_ledger (accreditation_id, entry_type, amount, currency, direction, brokerage_pct, brokerage_amount, cycle_id, notes, meta_json)
       VALUES ($1, 'salary', $2, 'USD', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        ent.id,
        bal,
        salaryDirection,
        pct > 0 ? pct : null,
        pct > 0 ? brokerageAmount : null,
        cid,
        'استيراد دفعة — ' + (parentRef || ''),
        salaryMeta,
      ]
    );
    const ledgerId = led.lastInsertRowid != null ? led.lastInsertRowid : led.rows[0]?.id;

    await db.query(
      'UPDATE accreditation_entities SET balance_payable = $1, balance_receivable = $2 WHERE id = $3',
      [pay, rec, ent.id]
    );
    await syncNetBalance(db, ent.id);

    if (brokerageAmount > 0) {
      await insertNetProfitLedgerAndMirrorFund(db, {
        userId,
        bucket: 'net_profit',
        sourceType: 'accreditation_brokerage',
        amount: brokerageAmount,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: 'وساطة معتمد — استيراد دفعة',
      });
    }
    if (fundDepositToUs > 0.0001 && salaryDirection === 'to_us' && mainFundId) {
      const fundType = pct > 0 ? 'accreditation_remainder' : 'accreditation_bulk';
      const fundNotes = pct > 0 ? 'باقي بعد الوساطة — استيراد' : 'استيراد رصيد معتمد';
      await adjustFundBalance(db, mainFundId, 'USD', fundDepositToUs, fundType, fundNotes, 'accreditation_ledger', ledgerId);
      await insertLedgerEntry(db, {
        userId,
        bucket: 'main_cash',
        sourceType: pct > 0 ? 'accreditation_remainder' : 'accreditation_bulk_import',
        amount: fundDepositToUs,
        cycleId: cid,
        refTable: 'accreditation_ledger',
        refId: ledgerId,
        notes: pct > 0 ? 'باقي بعد الوساطة — استيراد' : 'استيراد رصيد معتمد',
      });
    }
    ok++;
  }
  return { success: true, message: `تم معالجة ${ok} صف`, imported: ok, errors: errs };
}

async function processAccreditationBulkRows(db, userId, rows, cycleId, brokeragePctOpt) {
  if (!rows || rows.length < 2) {
    return { success: false, message: 'لا توجد بيانات كافية', imported: 0, errors: [] };
  }
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    items.push({
      code: row[0] != null ? String(row[0]).trim() : '',
      name: row[1] != null ? String(row[1]).trim() : '',
      amount: row[2],
      parentRef: row[3] != null ? String(row[3]).trim() : '',
      brokeragePct: brokeragePctOpt,
      salaryDirection: 'to_us',
      amountKind: 'salary',
    });
  }
  return processAccreditationBulkRowsFromItems(db, userId, items, cycleId, brokeragePctOpt);
}

module.exports = {
  processAccreditationBulkRows,
  processAccreditationBulkRowsFromItems,
  parseCsvTextToRows,
  buildBulkPreview,
};
