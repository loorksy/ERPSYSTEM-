(function() {
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }
  function esc(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** عرض اسم العملة للواجهة فقط (القيم المرسلة للخادم تبقى كما هي في النموذج) */
  function currencyAr(c) {
    var x = String(c == null ? '' : c).toUpperCase();
    if (x === 'USD') return 'دولار';
    if (x === 'TRY') return 'ليرة تركية';
    if (x === 'SYP') return 'ليرة سورية';
    return c ? esc(c) : '';
  }

  function statCard(iconClass, iconBg, label, value, valueClass) {
    return (
      '<div class="min-w-0 rounded-xl border border-slate-200/90 bg-white p-3.5 shadow-sm ring-1 ring-slate-900/[0.03] sm:p-4">' +
      '<div class="flex items-start justify-between gap-2">' +
      '<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ' +
      iconBg +
      '"><i class="' +
      iconClass +
      ' text-sm"></i></span>' +
      '</div>' +
      '<p class="mt-2 text-[0.65rem] font-medium leading-snug text-slate-500">' +
      esc(label) +
      '</p>' +
      '<p class="mt-1 font-mono text-base font-bold tabular-nums sm:text-lg ' +
      (valueClass || 'text-slate-900') +
      '">' +
      fmt(value) +
      '</p>' +
      '</div>'
    );
  }

  function loadOverview() {
    fetch('/api/debts/overview', { credentials: 'same-origin' })
      .then(function(r) {
        return r.json();
      })
      .then(function(d) {
        if (!d.success) {
          document.getElementById('debtsSummary').innerHTML =
            '<div class="col-span-full rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">' +
            esc(d.message || 'فشل التحميل') +
            '</div>';
          return;
        }
        var totalEl = document.getElementById('debtsTotalObligations');
        if (totalEl) totalEl.textContent = fmt(d.totalDebts);

        var sum = document.getElementById('debtsSummary');
        var accPay = d.accreditationPayableUsd != null ? d.accreditationPayableUsd : d.accreditationDebtTotal;
        var epAcc = d.entityPayablesFromAccTransferUsd != null ? d.entityPayablesFromAccTransferUsd : 0;
        var epOther = d.entityPayablesOtherUsd != null ? d.entityPayablesOtherUsd : 0;
        var fxV = d.fxSpreadSumUsd != null ? d.fxSpreadSumUsd : 0;
        var fxCard =
          fxV > 0.0001
            ? statCard('fas fa-chart-line', 'bg-teal-100 text-teal-800', 'فرق التصريف', fxV, 'text-teal-900')
            : '';
        sum.innerHTML =
          statCard('fas fa-truck-fast', 'bg-sky-100 text-sky-700', 'الشحن (بيع دين)', d.shippingDebt, 'text-sky-800') +
          statCard('fas fa-certificate', 'bg-violet-100 text-violet-800', 'المعتمدون — مطلوب دفع', accPay, 'text-violet-900') +
          statCard('fas fa-database', 'bg-slate-100 text-slate-700', 'ديون مسجّلة — إجمالي بالدولار', d.payablesSumUsd, 'text-slate-900') +
          statCard('fas fa-stamp', 'bg-violet-50 text-violet-900', 'من تحويل معتمد (دين علينا)', epAcc, 'text-violet-950') +
          statCard('fas fa-ellipsis-h', 'bg-slate-50 text-slate-600', 'ديون مسجّلة — أخرى (يدوي، شحن، …)', epOther, 'text-slate-800') +
          fxCard +
          statCard('fas fa-building', 'bg-red-100 text-red-700', 'شركات التحويل (رصيد سالب)', d.companyDebtFromBalance, 'text-red-800') +
          statCard('fas fa-piggy-bank', 'bg-amber-100 text-amber-800', 'الصناديق (رصيد سالب)', d.fundDebtFromBalance, 'text-amber-900');

        var comp = document.getElementById('debtsCompanies');
        if (comp) {
          comp.innerHTML = (d.negativeCompanies || []).length
            ? (d.negativeCompanies || [])
                .map(function(c) {
                  return (
                    '<a href="/debts/company/' +
                    c.id +
                    '" class="group flex items-center justify-between gap-3 px-4 py-4 transition hover:bg-gradient-to-l hover:from-red-50/90 hover:to-transparent">' +
                    '<div class="flex min-w-0 items-center gap-3">' +
                    '<span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-100 text-red-700 shadow-sm transition group-hover:bg-red-600 group-hover:text-white"><i class="fas fa-building"></i></span>' +
                    '<div class="min-w-0">' +
                    '<p class="font-bold text-slate-900 truncate">' +
                    esc(c.name || '') +
                    '</p>' +
                    '<p class="text-xs text-slate-500 mt-0.5">شركة تحويل</p>' +
                    '</div></div>' +
                    '<div class="flex shrink-0 items-center gap-2">' +
                    '<span class="font-mono text-sm font-bold tabular-nums text-rose-700">' +
                    fmt(c.balance_amount) +
                    ' ' +
                    currencyAr(c.balance_currency || 'USD') +
                    '</span>' +
                    '<span class="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-400 transition group-hover:bg-red-100 group-hover:text-red-600"><i class="fas fa-chevron-left text-xs"></i></span>' +
                    '</div></a>'
                  );
                })
                .join('')
            : '<p class="px-4 py-8 text-center text-sm text-slate-400">لا توجد شركات برصيد سالب حالياً</p>';
        }
        var fd = document.getElementById('debtsFunds');
        if (fd) {
          fd.innerHTML = (d.negativeFunds || []).length
            ? (d.negativeFunds || [])
                .map(function(f) {
                  return (
                    '<a href="/debts/fund/' +
                    f.id +
                    '" class="group flex items-center justify-between gap-3 px-4 py-4 transition hover:bg-gradient-to-l hover:from-amber-50/90 hover:to-transparent">' +
                    '<div class="flex min-w-0 items-center gap-3">' +
                    '<span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 shadow-sm transition group-hover:bg-amber-600 group-hover:text-white"><i class="fas fa-piggy-bank"></i></span>' +
                    '<div class="min-w-0">' +
                    '<p class="font-bold text-slate-900 truncate">' +
                    esc(f.name || '') +
                    '</p>' +
                    '<p class="text-xs text-slate-500 mt-0.5">صندوق</p>' +
                    '</div></div>' +
                    '<div class="flex shrink-0 items-center gap-2">' +
                    '<span class="font-mono text-sm font-bold tabular-nums text-amber-800">' +
                    fmt(f.amount) +
                    ' ' +
                    currencyAr(f.currency || '') +
                    '</span>' +
                    '<span class="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-400 transition group-hover:bg-amber-100 group-hover:text-amber-700"><i class="fas fa-chevron-left text-xs"></i></span>' +
                    '</div></a>'
                  );
                })
                .join('')
            : '<p class="px-4 py-8 text-center text-sm text-slate-400">لا توجد صناديق برصيد سالب</p>';
        }
        var pay = document.getElementById('debtsPayables');
        if (pay) {
          pay.innerHTML = (d.payablesList || []).length
            ? (d.payablesList || [])
                .map(function(p) {
                  var kind = p.entity_type === 'fund' ? 'صندوق' : 'شركة تحويل';
                  return (
                    '<div class="flex flex-col gap-2 rounded-xl border border-violet-200/80 bg-violet-50/30 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">' +
                    '<div class="flex items-start gap-2.5 min-w-0">' +
                    '<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-[0.65rem] font-bold text-violet-800">#' +
                    esc(String(p.entity_id)) +
                    '</span>' +
                    '<div class="min-w-0">' +
                    '<p class="text-sm font-semibold text-slate-900">' +
                    kind +
                    '</p>' +
                    (p.notes
                      ? '<p class="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">' + esc(p.notes) + '</p>'
                      : '') +
                    '</div></div>' +
                    '<div class="flex shrink-0 items-center justify-end border-t border-violet-100 pt-2 sm:border-0 sm:pt-0 sm:pl-3">' +
                    '<span class="inline-flex min-w-[7rem] items-center justify-center rounded-lg bg-white px-3 py-2 font-mono text-sm font-bold tabular-nums text-violet-900 ring-1 ring-violet-200/80">' +
                    fmt(p.amount) +
                    ' ' +
                    currencyAr(p.currency || '') +
                    '</span>' +
                    '</div></div>'
                  );
                })
                .join('')
            : '<p class="py-8 text-center text-sm text-slate-400">لا توجد مديونيات يدوية مسجّلة</p>';
        }
      })
      .catch(function() {
        var sum = document.getElementById('debtsSummary');
        if (sum)
          sum.innerHTML =
            '<div class="col-span-full rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">فشل التحميل</div>';
      });
  }

  function fillEntitySelects() {
    var typeSel = document.getElementById('debtRegEntityType');
    var idSel = document.getElementById('debtRegEntityId');
    if (!typeSel || !idSel) return;
    function refill() {
      var t = typeSel.value;
      idSel.innerHTML = '<option value="">— اختر الكيان —</option>';
      var url = t === 'fund' ? '/api/funds/list' : '/api/transfer-companies/list';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          return r.json();
        })
        .then(function(d) {
          var arr = t === 'fund' ? d.funds || [] : d.companies || [];
          arr.forEach(function(x) {
            idSel.innerHTML += '<option value="' + x.id + '">' + esc(x.name || '') + '</option>';
          });
        });
    }
    typeSel.addEventListener('change', refill);
    refill();
  }

  function initIndex() {
    loadOverview();
    fillEntitySelects();
    var btn = document.getElementById('debtRegSubmit');
    if (btn) {
      btn.addEventListener('click', function() {
        var et = document.getElementById('debtRegEntityType').value;
        var eid = document.getElementById('debtRegEntityId').value;
        var amt = parseFloat(document.getElementById('debtRegAmount').value);
        if (!eid || isNaN(amt) || amt <= 0) {
          toast('اختر الكيان وأدخل مبلغاً صالحاً', 'error');
          return;
        }
        fetch('/api/debts/register', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entityType: et,
            entityId: eid,
            amount: amt,
            currency: document.getElementById('debtRegCurrency').value,
            notes: document.getElementById('debtRegNotes').value,
            settlementMode: document.getElementById('debtRegSettlement')
              ? document.getElementById('debtRegSettlement').value
              : 'payable',
          }),
        })
          .then(function(r) {
            return r.json();
          })
          .then(function(d) {
            if (d.success) {
              toast(d.message || 'تم', 'success');
              loadOverview();
              document.getElementById('debtRegAmount').value = '';
            } else toast(d.message || 'فشل', 'error');
          });
      });
    }
  }

  function initCompany() {
    var id = window.__DEBT_PAGE__ && window.__DEBT_PAGE__.id;
    if (!id) return;
    var body = document.getElementById('debtCompanyBody');
    if (!body) return;
    var title = document.getElementById('debtCompanyTitle');
    Promise.all([
      fetch('/api/transfer-companies/' + id, { credentials: 'same-origin' }).then(function(r) {
        return r.json();
      }),
      fetch('/api/returns/for-entity?entityType=transfer_company&entityId=' + id, { credentials: 'same-origin' }).then(
        function(r) {
          return r.json();
        }
      ),
    ]).then(function(results) {
      var res = results[0];
      var ret = results[1];
      if (!res.success || !res.company) {
        body.innerHTML =
          '<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">غير موجود</div>';
        return;
      }
      var c = res.company;
      if (title) title.textContent = c.name || 'شركة';
      var html =
        '<div class="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">' +
        '<p class="text-xs font-semibold text-slate-500 mb-1">الرصيد الحالي</p>' +
        '<p class="font-mono text-3xl font-bold tabular-nums text-indigo-700">' +
        fmt(c.balance_amount) +
        ' ' +
        currencyAr(c.balance_currency || 'USD') +
        '</p></div>';

      html +=
        '<div class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">' +
        '<div class="border-b border-slate-100 bg-slate-50 px-5 py-3"><h4 class="text-sm font-bold text-slate-800">سجل الشركة</h4></div>' +
        '<div class="divide-y divide-slate-100 max-h-96 overflow-y-auto">';
      (res.ledger || []).forEach(function(l) {
        html +=
          '<div class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">' +
          '<span class="text-sm text-slate-700 min-w-0">' +
          esc(l.notes || '—') +
          '</span>' +
          '<span class="font-mono text-sm font-semibold tabular-nums text-slate-900 shrink-0">' +
          fmt(l.amount) +
          ' ' +
          currencyAr(l.currency || '') +
          '</span></div>';
      });
      if (!(res.ledger || []).length) {
        html += '<p class="px-4 py-8 text-center text-sm text-slate-400">لا حركات</p>';
      }
      html += '</div></div>';

      html +=
        '<div class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">' +
        '<div class="border-b border-slate-100 bg-slate-50 px-5 py-3"><h4 class="text-sm font-bold text-slate-800">المرتجعات</h4></div>' +
        '<div class="p-4 space-y-2">';
      if (ret.success && (ret.returns || []).length) {
        (ret.returns || []).forEach(function(rw) {
          html +=
            '<div class="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-sm">' +
            '<span class="font-mono font-semibold">' +
            fmt(rw.amount) +
            ' ' +
            currencyAr(rw.currency || '') +
            '</span>' +
            ' <span class="text-slate-600">' +
            esc(rw.disposition || '') +
            '</span>' +
            (rw.notes ? ' <span class="text-slate-500">— ' + esc(rw.notes) + '</span>' : '') +
            '</div>';
        });
      } else {
        html += '<p class="text-center text-sm text-slate-400 py-4">لا سجلات</p>';
      }
      html += '</div></div>';
      body.innerHTML = html;
    })
      .catch(function() {
        if (body)
          body.innerHTML =
            '<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">فشل تحميل البيانات</div>';
      });
  }

  function initFund() {
    var id = window.__DEBT_PAGE__ && window.__DEBT_PAGE__.id;
    if (!id) return;
    var body = document.getElementById('debtFundBody');
    if (!body) return;
    var title = document.getElementById('debtFundTitle');
    Promise.all([
      fetch('/api/funds/' + id, { credentials: 'same-origin' }).then(function(r) {
        return r.json();
      }),
      fetch('/api/returns/for-entity?entityType=fund&entityId=' + id, { credentials: 'same-origin' }).then(function(r) {
        return r.json();
      }),
    ]).then(function(results) {
      var res = results[0];
      var ret = results[1];
      if (!res.success || !res.fund) {
        body.innerHTML =
          '<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">غير موجود</div>';
        return;
      }
      var f = res.fund;
      if (title) title.textContent = f.name || 'صندوق';
      var html =
        '<div class="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-indigo-50/40 p-5 shadow-sm mb-6">' +
        '<p class="text-xs font-semibold text-slate-500 mb-3">أرصدة العملات</p>' +
        '<div class="flex flex-wrap gap-2">';
      (res.balances || []).forEach(function(b) {
        html +=
          '<span class="inline-flex items-center rounded-xl border border-indigo-200 bg-white px-4 py-2 font-mono text-sm font-semibold tabular-nums text-indigo-900 shadow-sm">' +
          fmt(b.amount) +
          ' ' +
          currencyAr(b.currency || '') +
          '</span>';
      });
      html +=
        '</div></div><div class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">' +
        '<div class="border-b border-slate-100 bg-slate-50 px-5 py-3"><h4 class="text-sm font-bold text-slate-800">سجل الصندوق</h4></div>' +
        '<div class="divide-y divide-slate-100 max-h-80 overflow-y-auto">';
      (res.ledger || []).forEach(function(l) {
        html +=
          '<div class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">' +
          '<span class="text-sm text-slate-700">' +
          esc((l.type || '') + ' ' + (l.notes || '')) +
          '</span>' +
          '<span class="font-mono text-sm font-semibold tabular-nums">' +
          fmt(l.amount) +
          ' ' +
          currencyAr(l.currency || '') +
          '</span></div>';
      });
      if (!(res.ledger || []).length) {
        html += '<p class="px-4 py-8 text-center text-sm text-slate-400">لا حركات</p>';
      }
      html +=
        '</div></div><div class="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">' +
        '<div class="border-b border-slate-100 bg-slate-50 px-5 py-3"><h4 class="text-sm font-bold text-slate-800">المرتجعات</h4></div><div class="p-4 space-y-2">';
      if (ret.success && (ret.returns || []).length) {
        (ret.returns || []).forEach(function(rw) {
          html +=
            '<div class="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-sm font-mono">' +
            fmt(rw.amount) +
            ' — ' +
            esc(rw.disposition || '') +
            '</div>';
        });
      } else {
        html += '<p class="text-center text-sm text-slate-400 py-4">لا سجلات</p>';
      }
      html += '</div></div>';
      body.innerHTML = html;
    })
      .catch(function() {
        if (body)
          body.innerHTML =
            '<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700">فشل تحميل البيانات</div>';
      });
  }

  document.addEventListener('DOMContentLoaded', function() {
    var p = window.__DEBT_PAGE__;
    if (!p) return;
    if (p.mode === 'index') initIndex();
    else if (p.mode === 'company') initCompany();
    else if (p.mode === 'fund') initFund();
  });
})();
