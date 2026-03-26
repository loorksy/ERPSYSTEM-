/**
 * إجراء سريع (+): صادر / وارد مع قوائم فرعية ونماذج مرتبطة بالـ API.
 */
(function () {
  var qaContext = null;

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    opts = opts || {};
    var init = Object.assign({ credentials: 'same-origin' }, opts);
    if (init.body && typeof init.body === 'string' && !init.headers) {
      init.headers = { 'Content-Type': 'application/json' };
    }
    return fetch(url, init).then(function (r) { return r.json(); });
  }

  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }

  function loadContext() {
    return apiCall('/api/quick-action/context').then(function (d) {
      qaContext = d.success ? d : null;
      return qaContext;
    }).catch(function () {
      qaContext = null;
      return null;
    });
  }

  function showCascade(html) {
    var ov = document.getElementById('qaCascadeOverlay');
    var panel = document.getElementById('qaCascadePanel');
    if (!ov || !panel) return;
    panel.innerHTML = html;
    ov.classList.remove('hidden');
    ov.classList.add('flex');
    ov.setAttribute('aria-hidden', 'false');
  }

  function hideCascade() {
    var ov = document.getElementById('qaCascadeOverlay');
    if (!ov) return;
    ov.classList.add('hidden');
    ov.classList.remove('flex');
    ov.setAttribute('aria-hidden', 'true');
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function cashWarningHtml() {
    if (!qaContext || !qaContext.cashBlocked) return '';
    return '<div class="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">' +
      '<strong>تنبيه:</strong> رصيد الصندوق الرئيسي ورصيد الشحن (كمية) غير متاحين للصرف النقدي. ' +
      'عند الصرف لشركة أو صندوق يمكنك تفعيل «تسجيل كدين علينا» بدل الخصم من الرئيسي.</div>';
  }

  function openOutMenu() {
    loadContext().then(function () {
      showCascade(
        '<div class="flex justify-between items-center mb-4">' +
        '<h3 class="text-lg font-bold text-slate-800">صادر</h3>' +
        '<button type="button" class="text-slate-400 hover:text-slate-600" id="qaCloseX" aria-label="إغلاق"><i class="fas fa-times"></i></button></div>' +
        cashWarningHtml() +
        '<p class="text-xs text-slate-500 mb-3">اختر نوع الصرف (يُخصم من الصندوق الرئيسي ما لم يُفعّل دين علينا).</p>' +
        '<div class="space-y-2">' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="out-ship">شحن <span class="text-slate-400 text-xs">(نموذج بيع)</span></button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="out-sub">وكالة فرعية <span class="text-slate-400 text-xs">(مكافأة)</span></button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="out-co">شركة تحويل</button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="out-fund">صندوق</button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="out-exp">مصروف</button>' +
        '<p class="pt-2 text-center"><a href="/transfer-companies" class="text-xs text-amber-700 font-semibold hover:underline">مرتجع — شركات التحويل</a></p>' +
        '</div>'
      );
      bindOutItems();
      document.getElementById('qaCloseX').addEventListener('click', hideCascade);
    });
  }

  function openInMenu() {
    loadContext().then(function () {
      showCascade(
        '<div class="flex justify-between items-center mb-4">' +
        '<h3 class="text-lg font-bold text-slate-800">وارد</h3>' +
        '<button type="button" class="text-slate-400 hover:text-slate-600" id="qaCloseX2" aria-label="إغلاق"><i class="fas fa-times"></i></button></div>' +
        '<div class="space-y-2">' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="in-ship">شحن <span class="text-slate-400 text-xs">(شراء + تبديل راتب)</span></button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="in-debt">دين</button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="in-acc">اعتماد</button>' +
        '<button type="button" class="qa-item w-full py-3 px-4 rounded-xl border border-slate-200 text-right font-semibold hover:bg-slate-50" data-qa="in-fx">فرق تصريف</button>' +
        '</div>'
      );
      bindInItems();
      document.getElementById('qaCloseX2').addEventListener('click', hideCascade);
    });
  }

  function bindOutItems() {
    document.querySelectorAll('#qaCascadePanel .qa-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-qa');
        if (k === 'out-ship') {
          hideCascade();
          window.location.href = '/shipping?fab=out';
          return;
        }
        if (k === 'out-sub') return formSubReward();
        if (k === 'out-co') return formCompanyPayout();
        if (k === 'out-fund') return formFundReceive();
        if (k === 'out-exp') return formExpense();
      });
    });
  }

  function bindInItems() {
    document.querySelectorAll('#qaCascadePanel .qa-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-qa');
        if (k === 'in-ship') {
          hideCascade();
          window.location.href = '/shipping?fab=in&qaFocus=swap';
          return;
        }
        if (k === 'in-debt') {
          hideCascade();
          window.location.href = '/debts';
          return;
        }
        if (k === 'in-acc') return formAccIncoming();
        if (k === 'in-fx') return formFxSpread();
      });
    });
  }

  function formSubReward() {
    apiCall('/api/sub-agencies/list').then(function (d) {
      var opts = (d.agencies || []).map(function (a) {
        return '<option value="' + a.id + '">' + esc(a.name) + '</option>';
      }).join('');
      showCascade(
        '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">مكافأة وكالة فرعية</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
        cashWarningHtml() +
        '<p class="text-xs text-slate-500 mb-2">يُخصم من الصندوق الرئيسي ويُسجّل كمصروف. إن كانت الوكالة لها مستحقات لصالحكم، راجع سجل الوكالة من قسم الوكالات الفرعية.</p>' +
        '<label class="block text-sm font-medium mb-1">الوكالة</label><select id="qaSubId" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200"><option value="">— اختر —</option>' + opts + '</select>' +
        '<label class="block text-sm font-medium mb-1">المبلغ (USD)</label><input type="number" id="qaSubAmt" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<label class="block text-sm font-medium mb-1">ملاحظات</label><input type="text" id="qaSubNotes" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
        '<button type="button" id="qaSubGo" class="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold">تسجيل</button>'
      );
      document.getElementById('qaBack').addEventListener('click', openOutMenu);
      document.getElementById('qaSubGo').addEventListener('click', function () {
        var id = document.getElementById('qaSubId').value;
        var amt = parseFloat(document.getElementById('qaSubAmt').value);
        if (!id || isNaN(amt) || amt <= 0) { toast('بيانات غير صالحة', 'error'); return; }
        apiCall('/api/sub-agencies/' + id + '/reward', {
          method: 'POST',
          body: JSON.stringify({ amount: amt, notes: document.getElementById('qaSubNotes').value })
        }).then(function (r) {
          toast(r.message || '', r.success ? 'success' : 'error');
          if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
        });
      });
    });
  }

  function formCompanyPayout() {
    apiCall('/api/transfer-companies/list').then(function (d) {
      var opts = (d.companies || []).map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      }).join('');
      var payCb = qaContext && qaContext.cashBlocked ? 'checked' : '';
      showCascade(
        '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">صرف لشركة تحويل</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
        cashWarningHtml() +
        '<label class="block text-sm font-medium mb-1">الشركة</label><select id="qaCoId" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200"><option value="">— اختر —</option>' + opts + '</select>' +
        '<label class="block text-sm font-medium mb-1">المبلغ (USD)</label><input type="number" id="qaCoAmt" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<label class="inline-flex items-center gap-2 mb-2 text-sm"><input type="checkbox" id="qaCoPayable" ' + payCb + '> تسجيل كدين علينا (بدون خصم من الصندوق الرئيسي)</label>' +
        '<input type="text" id="qaCoNotes" placeholder="ملاحظات" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
        '<button type="button" id="qaCoGo" class="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold">تنفيذ</button>'
      );
      document.getElementById('qaBack').addEventListener('click', openOutMenu);
      document.getElementById('qaCoGo').addEventListener('click', function () {
        var id = document.getElementById('qaCoId').value;
        var amt = parseFloat(document.getElementById('qaCoAmt').value);
        var payable = document.getElementById('qaCoPayable').checked;
        if (!id || isNaN(amt) || amt <= 0) { toast('بيانات غير صالحة', 'error'); return; }
        apiCall('/api/transfer-companies/' + id + '/payout-from-main', {
          method: 'POST',
          body: JSON.stringify({ amount: amt, notes: document.getElementById('qaCoNotes').value, mode: payable ? 'payable' : 'main' })
        }).then(function (r) {
          if (r.code === 'INSUFFICIENT_MAIN' && !payable) {
            toast(r.message || '', 'error');
            return;
          }
          toast(r.message || '', r.success ? 'success' : 'error');
          if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
        });
      });
    });
  }

  function formFundReceive() {
    apiCall('/api/funds/list').then(function (d) {
      var opts = (d.funds || []).filter(function (f) { return !f.is_main; }).map(function (f) {
        return '<option value="' + f.id + '">' + esc(f.name) + '</option>';
      }).join('');
      var payCb = qaContext && qaContext.cashBlocked ? 'checked' : '';
      showCascade(
        '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">صرف لصندوق</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
        cashWarningHtml() +
        '<label class="block text-sm font-medium mb-1">الصندوق (غير الرئيسي)</label><select id="qaFdId" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200"><option value="">— اختر —</option>' + opts + '</select>' +
        '<label class="block text-sm font-medium mb-1">المبلغ (USD)</label><input type="number" id="qaFdAmt" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<label class="inline-flex items-center gap-2 mb-2 text-sm"><input type="checkbox" id="qaFdPayable" ' + payCb + '> تسجيل كدين علينا (بدون خصم من الرئيسي)</label>' +
        '<input type="text" id="qaFdNotes" placeholder="ملاحظات" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
        '<button type="button" id="qaFdGo" class="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold">تنفيذ</button>'
      );
      document.getElementById('qaBack').addEventListener('click', openOutMenu);
      document.getElementById('qaFdGo').addEventListener('click', function () {
        var id = document.getElementById('qaFdId').value;
        var amt = parseFloat(document.getElementById('qaFdAmt').value);
        var payable = document.getElementById('qaFdPayable').checked;
        if (!id || isNaN(amt) || amt <= 0) { toast('بيانات غير صالحة', 'error'); return; }
        apiCall('/api/funds/' + id + '/receive-from-main', {
          method: 'POST',
          body: JSON.stringify({ amount: amt, notes: document.getElementById('qaFdNotes').value, mode: payable ? 'payable' : 'main' })
        }).then(function (r) {
          if (r.code === 'INSUFFICIENT_MAIN' && !payable) {
            toast(r.message || '', 'error');
            return;
          }
          toast(r.message || '', r.success ? 'success' : 'error');
          if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
        });
      });
    });
  }

  function formExpense() {
    showCascade(
      '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">مصروف</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
      cashWarningHtml() +
      '<label class="block text-sm font-medium mb-1">المبلغ (USD)</label><input type="number" id="qaExAmt" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
      '<label class="inline-flex items-center gap-2 mb-2 text-sm"><input type="checkbox" id="qaExMain" checked> خصم من الصندوق الرئيسي</label>' +
      '<input type="text" id="qaExNotes" placeholder="ملاحظات" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
      '<button type="button" id="qaExGo" class="w-full py-3 rounded-xl bg-rose-600 text-white font-semibold">تسجيل مصروف</button>'
    );
    document.getElementById('qaBack').addEventListener('click', openOutMenu);
    document.getElementById('qaExGo').addEventListener('click', function () {
      var amt = parseFloat(document.getElementById('qaExAmt').value);
      var debitMain = document.getElementById('qaExMain').checked;
      if (isNaN(amt) || amt <= 0) { toast('مبلغ غير صالح', 'error'); return; }
      apiCall('/api/expenses/add', {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          notes: document.getElementById('qaExNotes').value,
          debitMainFund: debitMain
        })
      }).then(function (r) {
        toast(r.message || '', r.success ? 'success' : 'error');
        if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
      });
    });
  }

  function formAccIncoming() {
    apiCall('/api/accreditations/list').then(function (d) {
      var opts = (d.list || []).map(function (a) {
        return '<option value="' + a.id + '">' + esc(a.name) + ' (' + esc(a.code) + ')</option>';
      }).join('');
      showCascade(
        '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">وارد — اعتماد</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
        '<p class="text-xs text-slate-500 mb-2">إضافة مبلغ باتجاه إلينا: يزيد رصيد الصندوق الرئيسي (بعد الوساطة) ويخفض دين المعتمد إن كان مديناً.</p>' +
        '<label class="block text-sm font-medium mb-1">المعتمد</label><select id="qaAcId" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200"><option value="">— اختر —</option>' + opts + '</select>' +
        '<label class="block text-sm font-medium mb-1">المبلغ</label><input type="number" id="qaAcAmt" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<label class="block text-sm font-medium mb-1">نسبة الوساطة %</label><input type="number" id="qaAcBr" step="0.1" value="0" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<input type="text" id="qaAcNotes" placeholder="ملاحظات" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
        '<button type="button" id="qaAcGo" class="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">تسجيل</button>'
      );
      document.getElementById('qaBack').addEventListener('click', openInMenu);
      document.getElementById('qaAcGo').addEventListener('click', function () {
        var id = document.getElementById('qaAcId').value;
        var amt = parseFloat(document.getElementById('qaAcAmt').value);
        if (!id || isNaN(amt) || amt <= 0) { toast('بيانات غير صالحة', 'error'); return; }
        apiCall('/api/accreditations/' + id + '/add-amount', {
          method: 'POST',
          body: JSON.stringify({
            salaryDirection: 'to_us',
            amount: amt,
            brokeragePct: document.getElementById('qaAcBr').value,
            notes: document.getElementById('qaAcNotes').value
          })
        }).then(function (r) {
          toast(r.message || '', r.success ? 'success' : 'error');
          if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
        });
      });
    });
  }

  function formFxSpread() {
    apiCall('/api/fx-spread/list').then(function (d) {
      var cyc = (d.cycles || []).map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      }).join('');
      showCascade(
        '<div class="flex justify-between items-center mb-3"><h3 class="font-bold">فرق تصريف → صافي الربح</h3><button type="button" class="text-slate-400" id="qaBack"><i class="fas fa-arrow-right"></i></button></div>' +
        '<label class="block text-sm font-medium mb-1">الدورة (اختياري)</label><select id="qaFxCyc" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200"><option value="">— —</option>' + cyc + '</select>' +
        '<label class="block text-sm font-medium mb-1">العملة</label><input type="text" id="qaFxCur" value="TRY" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200">' +
        '<label class="block text-sm font-medium mb-1">المبلغ بالدولار</label><input type="number" id="qaFxAmtUsd" step="0.01" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200" placeholder="1000">' +
        '<label class="block text-sm font-medium mb-1">السعر المثبت (وحدة/USD)</label><input type="number" id="qaFxIn" step="0.0001" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200" placeholder="45">' +
        '<label class="block text-sm font-medium mb-1">سعر الشراء الفعلي (وحدة/USD)</label><input type="number" id="qaFxOut" step="0.0001" class="w-full mb-2 px-3 py-2 rounded-lg border border-slate-200" placeholder="46">' +
        '<p id="qaFxPrev" class="text-sm text-indigo-700 mb-2 min-h-[1.25rem]"></p>' +
        '<input type="text" id="qaFxNotes" placeholder="ملاحظات" class="w-full mb-3 px-3 py-2 rounded-lg border border-slate-200">' +
        '<button type="button" id="qaFxGo" class="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold">إضافة ربح</button>'
      );
      document.getElementById('qaBack').addEventListener('click', openInMenu);
      function prev() {
        var amtUsd = parseFloat(document.getElementById('qaFxAmtUsd').value);
        var a = parseFloat(document.getElementById('qaFxIn').value);
        var b = parseFloat(document.getElementById('qaFxOut').value);
        var el = document.getElementById('qaFxPrev');
        if (!(amtUsd > 0) || !(a > 0) || !(b > 0)) { el.textContent = ''; return; }
        var profitUsd = amtUsd * Math.abs(b - a) / b;
        el.textContent = 'الربح التقديري: ≈ ' + profitUsd.toFixed(2) + ' USD';
      }
      ['qaFxAmtUsd', 'qaFxIn', 'qaFxOut'].forEach(function (id) {
        var n = document.getElementById(id);
        if (n) n.addEventListener('input', prev);
      });
      document.getElementById('qaFxGo').addEventListener('click', function () {
        var amtUsd = parseFloat(document.getElementById('qaFxAmtUsd').value);
        var fixedRate = parseFloat(document.getElementById('qaFxIn').value);
        var purchaseRate = parseFloat(document.getElementById('qaFxOut').value);
        if (!(amtUsd > 0) || !(fixedRate > 0) || !(purchaseRate > 0)) { toast('أدخل المبلغ والسعرين', 'error'); return; }
        var amountForeign = amtUsd * fixedRate;
        apiCall('/api/fx-spread/add', {
          method: 'POST',
          body: JSON.stringify({
            cycleId: document.getElementById('qaFxCyc').value || null,
            currency: document.getElementById('qaFxCur').value,
            amountForeign: amountForeign,
            internalRate: fixedRate,
            settlementRate: purchaseRate,
            notes: document.getElementById('qaFxNotes').value
          })
        }).then(function (r) {
          toast(r.message || '', r.success ? 'success' : 'error');
          if (r.success) { hideCascade(); if (typeof homeLoadStats === 'function') homeLoadStats(); }
        });
      });
    });
  }

  window.handleQuickActionSub = function (t) {
    if (t === 'qa-out') {
      openOutMenu();
      return true;
    }
    if (t === 'qa-in') {
      openInMenu();
      return true;
    }
    return false;
  };

  document.addEventListener('DOMContentLoaded', function () {
    var ov = document.getElementById('qaCascadeOverlay');
    if (ov) {
      ov.addEventListener('click', function (e) {
        if (e.target === ov) hideCascade();
      });
    }
  });
})();
