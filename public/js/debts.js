(function() {
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }

  function loadOverview() {
    fetch('/api/debts/overview', { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) {
          document.getElementById('debtsSummary').innerHTML = '<p class="text-red-500">' + (d.message || 'فشل') + '</p>';
          return;
        }
        var sum = document.getElementById('debtsSummary');
        sum.innerHTML =
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">إجمالي</p><p class="text-lg font-bold text-red-600">' + fmt(d.totalDebts) + '</p></div>' +
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">شحن</p><p class="text-lg font-bold">' + fmt(d.shippingDebt) + '</p></div>' +
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">اعتمادات</p><p class="text-lg font-bold">' + fmt(d.accreditationDebtTotal) + '</p></div>' +
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">مسجّل يدوياً</p><p class="text-lg font-bold">' + fmt(d.payablesSumUsd) + '</p></div>' +
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">شركات (سالب)</p><p class="text-lg font-bold">' + fmt(d.companyDebtFromBalance) + '</p></div>' +
          '<div class="bg-white rounded-xl p-4 border border-slate-100"><p class="text-xs text-slate-500">صناديع (سالب)</p><p class="text-lg font-bold">' + fmt(d.fundDebtFromBalance) + '</p></div>';

        var comp = document.getElementById('debtsCompanies');
        if (comp) {
          comp.innerHTML = (d.negativeCompanies || []).length
            ? (d.negativeCompanies || []).map(function(c) {
              return '<a href="/debts/company/' + c.id + '" class="block p-3 rounded-xl bg-red-50 border border-red-100 hover:border-red-200">' +
                '<span class="font-semibold">' + (c.name || '') + '</span> — ' + fmt(c.balance_amount) + ' ' + (c.balance_currency || 'USD') + '</a>';
            }).join('')
            : '<p class="text-slate-400 text-sm">لا يوجد</p>';
        }
        var fd = document.getElementById('debtsFunds');
        if (fd) {
          fd.innerHTML = (d.negativeFunds || []).length
            ? (d.negativeFunds || []).map(function(f) {
              return '<a href="/debts/fund/' + f.id + '" class="block p-3 rounded-xl bg-amber-50 border border-amber-100 hover:border-amber-200">' +
                '<span class="font-semibold">' + (f.name || '') + '</span> — ' + fmt(f.amount) + ' ' + (f.currency || '') + '</a>';
            }).join('')
            : '<p class="text-slate-400 text-sm">لا يوجد</p>';
        }
        var pay = document.getElementById('debtsPayables');
        if (pay) {
          pay.innerHTML = (d.payablesList || []).length
            ? (d.payablesList || []).map(function(p) {
              return '<div class="p-2 rounded-lg bg-slate-50 border border-slate-100">' + (p.entity_type === 'fund' ? 'صندوق' : 'شركة') + ' #' + p.entity_id + ' — ' + fmt(p.amount) + ' ' + (p.currency || '') + (p.notes ? ' — ' + p.notes : '') + '</div>';
            }).join('')
            : '<p class="text-slate-400 text-sm">لا يوجد</p>';
        }
      })
      .catch(function() {
        var sum = document.getElementById('debtsSummary');
        if (sum) sum.innerHTML = '<p class="text-red-500">فشل التحميل</p>';
      });
  }

  function fillEntitySelects() {
    var typeSel = document.getElementById('debtRegEntityType');
    var idSel = document.getElementById('debtRegEntityId');
    if (!typeSel || !idSel) return;
    function refill() {
      var t = typeSel.value;
      idSel.innerHTML = '<option value="">— اختر —</option>';
      var url = t === 'fund' ? '/api/funds/list' : '/api/transfer-companies/list';
      fetch(url, { credentials: 'same-origin' }).then(function(r) { return r.json(); }).then(function(d) {
        var arr = t === 'fund' ? (d.funds || []) : (d.companies || []);
        arr.forEach(function(x) {
          idSel.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
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
          }),
        }).then(function(r) { return r.json(); }).then(function(d) {
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
    var title = document.getElementById('debtCompanyTitle');
    Promise.all([
      fetch('/api/transfer-companies/' + id, { credentials: 'same-origin' }).then(function(r) { return r.json(); }),
      fetch('/api/returns/for-entity?entityType=transfer_company&entityId=' + id, { credentials: 'same-origin' }).then(function(r) { return r.json(); }),
    ]).then(function(results) {
      var res = results[0];
      var ret = results[1];
      if (!res.success || !res.company) {
        body.innerHTML = '<p class="text-red-500">غير موجود</p>';
        return;
      }
      var c = res.company;
      if (title) title.textContent = c.name || 'شركة';
      var html = '<p class="text-lg font-bold text-indigo-700">' + fmt(c.balance_amount) + ' ' + (c.balance_currency || 'USD') + '</p>';
      html += '<h4 class="font-bold mt-4">سجل الشركة</h4><div class="space-y-2 text-sm">';
      (res.ledger || []).forEach(function(l) {
        html += '<div class="flex justify-between py-2 border-b border-slate-100"><span>' + (l.notes || '') + '</span><span>' + fmt(l.amount) + ' ' + (l.currency || '') + '</span></div>';
      });
      html += '</div>';
      html += '<h4 class="font-bold mt-4">المرتجعات</h4><div class="space-y-2 text-sm">';
      if (ret.success && (ret.returns || []).length) {
        (ret.returns || []).forEach(function(rw) {
          html += '<div class="p-2 rounded-lg bg-slate-50">' + fmt(rw.amount) + ' ' + (rw.currency || '') + ' — ' + (rw.disposition || '') + (rw.notes ? ' — ' + rw.notes : '') + '</div>';
        });
      } else html += '<p class="text-slate-400">لا سجلات</p>';
      html += '</div>';
      body.innerHTML = html;
    });
  }

  function initFund() {
    var id = window.__DEBT_PAGE__ && window.__DEBT_PAGE__.id;
    if (!id) return;
    var body = document.getElementById('debtFundBody');
    var title = document.getElementById('debtFundTitle');
    Promise.all([
      fetch('/api/funds/' + id, { credentials: 'same-origin' }).then(function(r) { return r.json(); }),
      fetch('/api/returns/for-entity?entityType=fund&entityId=' + id, { credentials: 'same-origin' }).then(function(r) { return r.json(); }),
    ]).then(function(results) {
      var res = results[0];
      var ret = results[1];
      if (!res.success || !res.fund) {
        body.innerHTML = '<p class="text-red-500">غير موجود</p>';
        return;
      }
      var f = res.fund;
      if (title) title.textContent = f.name || 'صندوق';
      var html = '<div class="flex flex-wrap gap-2 mb-2">';
      (res.balances || []).forEach(function(b) {
        html += '<span class="px-3 py-1 rounded-lg bg-indigo-50 text-indigo-800 text-sm">' + fmt(b.amount) + ' ' + (b.currency || '') + '</span>';
      });
      html += '</div><h4 class="font-bold mt-4">سجل الصندوق</h4><div class="space-y-2 text-sm max-h-80 overflow-y-auto">';
      (res.ledger || []).forEach(function(l) {
        html += '<div class="flex justify-between py-2 border-b border-slate-100"><span>' + (l.type || '') + ' ' + (l.notes || '') + '</span><span>' + fmt(l.amount) + ' ' + (l.currency || '') + '</span></div>';
      });
      html += '</div><h4 class="font-bold mt-4">المرتجعات</h4><div class="space-y-2 text-sm">';
      if (ret.success && (ret.returns || []).length) {
        (ret.returns || []).forEach(function(rw) {
          html += '<div class="p-2 rounded-lg bg-slate-50">' + fmt(rw.amount) + ' — ' + (rw.disposition || '') + '</div>';
        });
      } else html += '<p class="text-slate-400">لا سجلات</p>';
      html += '</div>';
      body.innerHTML = html;
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
