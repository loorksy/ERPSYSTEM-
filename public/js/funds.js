(function() {
  'use strict';
  var currentFundId = null;

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    opts = opts || {};
    var init = Object.assign({ credentials: 'same-origin' }, opts);
    if (init.body && typeof init.body === 'string' && !init.headers) {
      init.headers = { 'Content-Type': 'application/json' };
    }
    return fetch(url, init).then(function(r) { return r.json(); });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function fundsPrimaryBalanceAmount(balances) {
    if (!balances || !balances.length) return 0;
    var usd = balances.find(function(b) {
      return (b.currency || '').toUpperCase() === 'USD';
    });
    if (usd) return Number(usd.amount) || 0;
    return Number(balances[0].amount) || 0;
  }

  /** نفس تدرجات بطاقات الوكالات الفرعية */
  var agencyCardColors = [
    'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 50%, #a5b4fc 100%)',
    'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 50%, #6ee7b7 100%)',
    'linear-gradient(135deg, #fef3c7 0%, #fde68a 50%, #fcd34d 100%)',
    'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 50%, #f9a8d4 100%)',
    'linear-gradient(135deg, #cffafe 0%, #a5f3fc 50%, #67e8f9 100%)',
    'linear-gradient(135deg, #ede9fe 0%, #ddd6fe 50%, #c4b5fd 100%)',
    'linear-gradient(135deg, #fed7aa 0%, #fdba74 50%, #fb923c 100%)',
    'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 50%, #93c5fd 100%)',
  ];

  function fillCountries() {
    var sel = document.getElementById('fundAddCountry');
    if (!sel || !window.FUNDS_COUNTRIES) return;
    sel.innerHTML = window.FUNDS_COUNTRIES.map(function(c) {
      return '<option value="' + c + '">' + c + '</option>';
    }).join('');
  }

  window.fundsSyriaGov = function(country) {
    var w = document.getElementById('fundSyriaGovWrap');
    if (!w) return;
    if (country === 'سوريا') {
      w.classList.remove('hidden');
      var g = document.getElementById('fundAddSyriaGov');
      g.innerHTML = (window.FUNDS_SYRIA_GOV || []).map(function(x) {
        return '<option value="' + x + '">' + x + '</option>';
      }).join('');
    } else {
      w.classList.add('hidden');
    }
  };

  window.fundsLoadList = function() {
    var box = document.getElementById('fundsCards');
    if (!box) return;
    box.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">جاري التحميل...</p>';
    apiCall('/api/funds/list').then(function(res) {
      if (!res.success) {
        box.innerHTML =
          '<p class="text-red-500 col-span-full text-center py-12">' + escHtml(res.message || 'فشل') + '</p>';
        return;
      }
      var list = res.funds || [];
      if (list.length === 0) {
        box.innerHTML =
          '<p class="text-slate-400 col-span-full text-center py-12">لا توجد صناديق</p>';
        return;
      }
      box.innerHTML = list.map(function(f, idx) {
        var balStr = (f.balances || [])
          .map(function(b) {
            var amt = Number(b.amount) || 0;
            var num = amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return escHtml(num + ' ' + (b.currency || ''));
          })
          .join(' | ');
        var primaryAmt = fundsPrimaryBalanceAmount(f.balances || []);
        var textColor = '#64748b';
        if (primaryAmt > 0.0001) textColor = '#047857';
        else if (primaryAmt < -0.0001) textColor = '#b91c1c';
        var metaParts = [];
        if (f.is_main) metaParts.push('رئيسي');
        if (f.fund_number) metaParts.push(String(f.fund_number));
        if (f.country) metaParts.push(String(f.country));
        var metaStr = metaParts.length ? metaParts.join(' · ') : '—';
        var debt = (f.openPayablesUsd || 0) > 0.0001;
        var debtLine = debt
          ? '<p class="agency-meta mt-2 pt-2 border-t border-white/40" style="color:#b91c1c;font-weight:600">دين علينا: ' +
            escHtml(
              (Number(f.openPayablesUsd) || 0).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }) + ' USD'
            ) +
            '</p>'
          : '';
        var bg = agencyCardColors[idx % agencyCardColors.length];
        return (
          '<div class="agency-card fund-card relative" style="background:' +
          bg +
          '; color:#1e293b;" onclick="fundsOpenDetail(' +
          f.id +
          ')">' +
          '<h5>' +
          escHtml(f.name || '') +
          '</h5>' +
          '<p class="agency-meta">' +
          escHtml(metaStr) +
          '</p>' +
          '<p class="agency-balance" style="color:' +
          textColor +
          '">رصيد: ' +
          (balStr || '0.00') +
          '</p>' +
          debtLine +
          '</div>'
        );
      }).join('');
    });
    apiCall('/api/funds/transfer-companies/list').then(function(res) {
      var sel = document.getElementById('fundAddTc');
      if (!sel) return;
      sel.innerHTML = '<option value="">— لا يوجد —</option>';
      (res.list || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || '') + '</option>';
      });
    });
  };

  window.fundsOpenAdd = function() {
    fillCountries();
    document.getElementById('fundAddModal').classList.remove('hidden');
    document.getElementById('fundAddModal').classList.add('flex');
    fundsSyriaGov(document.getElementById('fundAddCountry').value);
  };
  window.fundsCloseAdd = function() {
    document.getElementById('fundAddModal').classList.add('hidden');
    document.getElementById('fundAddModal').classList.remove('flex');
  };

  function fundsApplyDetailResponse(res) {
    if (!res.success) return toast(res.message || 'فشل', 'error');
    var id = currentFundId;
    var f = res.fund;
    var titleEl = document.getElementById('fundDetailTitle');
    if (titleEl) titleEl.textContent = f.name || '';
    document.getElementById('fundDetailMeta').innerHTML =
      '<p><strong>الرقم:</strong> ' + (f.fund_number || '-') + '</p>' +
      '<p><strong>الدولة:</strong> ' + (f.country || '-') + ' ' + (f.region_syria || '') + '</p>';
    var payBox = document.getElementById('fundDetailPayables');
    var pay = res.openPayablesUsd != null ? res.openPayablesUsd : 0;
    if (payBox) {
      if (pay > 0.0001) {
        payBox.classList.remove('hidden');
        payBox.textContent = 'دين علينا تجاه هذا الصندوق: ' + pay.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD';
      } else {
        payBox.classList.add('hidden');
        payBox.textContent = '';
      }
    }
    var balDebt = pay > 0.0001;
    document.getElementById('fundDetailBalances').innerHTML = (res.balances || []).map(function(b) {
      var cls = balDebt && (b.currency || '') === 'USD' ? 'bg-red-50 text-red-800 border border-red-100' : 'bg-slate-100 text-slate-800';
      return '<span class="px-3 py-1 rounded-lg ' + cls + '">' +
        (b.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (b.currency || '') + '</span>';
    }).join(' ');
    document.getElementById('fundDetailLedger').innerHTML = (res.ledger || []).map(function(l) {
      var cat = l.colorCategory || 'balance';
      var border = 'border-s-[3px] border-s-[#047857]';
      if (cat === 'refund') border = 'border-s-[3px] border-s-[#b91c1c]';
      else if (cat === 'debt') border = 'border-s-[3px] border-s-[#c2410c]';
      else if (cat === 'payout') border = 'border-s-[3px] border-s-[#9a3412]';
      var after = l.balanceAfterUsd != null && !isNaN(l.balanceAfterUsd)
        ? l.balanceAfterUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD'
        : '—';
      var noteLine = (l.displayNotes || l.notes || '');
      return '<div class="py-2.5 px-2 -mx-2 rounded-lg flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 border-b border-slate-50 ' + border + '">' +
        '<div class="min-w-0"><span class="text-sm font-medium text-slate-800">' + (l.labelAr || l.type || '') + '</span>' +
        '<span class="block text-[0.7rem] text-slate-500 truncate">' + noteLine + '</span></div>' +
        '<div class="text-left shrink-0"><span class="font-semibold tabular-nums">' +
        (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (l.currency || '') + '</span>' +
        '<span class="block text-[0.65rem] text-slate-500">الرصيد بعد: ' + after + '</span></div></div>';
    }).join('') || '<p class="text-slate-400">لا سجل</p>';
    apiCall('/api/funds/list').then(function(r2) {
      var sel = document.getElementById('fundTransferTo');
      if (!sel) return;
      sel.innerHTML = '<option value="">— صندوق مقصد —</option>';
      (r2.funds || []).forEach(function(x) {
        if (x.id !== id) sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
      });
      var rts = document.getElementById('fundReturnTarget');
      if (rts) {
        rts.innerHTML = '<option value="">— صندوق مقصد —</option>';
        (r2.funds || []).forEach(function(x) {
          if (x.id !== id) rts.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
        });
      }
      fundsToggleReturnTarget();
    });
  }

  window.fundsReloadDetail = function() {
    if (!currentFundId) return;
    apiCall('/api/funds/' + currentFundId).then(fundsApplyDetailResponse);
  };

  window.fundsOpenDetail = function(id) {
    window.location.href = '/funds/' + id;
  };
  window.fundsDownloadLedgerPdf = function() {
    if (!currentFundId) return;
    window.open('/api/reports/pdf/fund-ledger?fundId=' + encodeURIComponent(currentFundId), '_blank');
  };

  window.fundsCloseDetail = function() {
    window.location.href = '/funds';
  };
  window.fundsSetMain = function() {
    if (!currentFundId) return;
    apiCall('/api/funds/' + currentFundId + '/set-main', { method: 'POST', body: '{}' }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (document.getElementById('fundsCards')) fundsLoadList();
      fundsReloadDetail();
      if (typeof window.homeLoadStats === 'function') window.homeLoadStats();
    });
  };
  function fundsToggleReturnTarget() {
    var d = document.getElementById('fundReturnDisposition');
    var rts = document.getElementById('fundReturnTarget');
    if (!d || !rts) return;
    if (d.value === 'transfer_to_fund') rts.classList.remove('hidden');
    else rts.classList.add('hidden');
  }
  document.getElementById('fundReturnDisposition')?.addEventListener('change', fundsToggleReturnTarget);

  window.fundsSubmitReturn = function() {
    if (!currentFundId) return;
    var amt = parseFloat(document.getElementById('fundReturnAmt').value);
    if (isNaN(amt) || amt <= 0) return toast('أدخل مبلغاً صالحاً', 'error');
    var disp = document.getElementById('fundReturnDisposition').value;
    var body = {
      entityType: 'fund',
      entityId: currentFundId,
      amount: amt,
      currency: document.getElementById('fundReturnCur').value,
      disposition: disp,
      notes: document.getElementById('fundReturnNotes').value || null,
    };
    if (disp === 'transfer_to_fund') {
      var tid = document.getElementById('fundReturnTarget').value;
      if (!tid) return toast('اختر صندوق المقصد', 'error');
      body.targetFundId = tid;
    }
    apiCall('/api/returns', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
      toast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        document.getElementById('fundReturnAmt').value = '';
        fundsReloadDetail();
      }
    });
  };

  window.fundsDoTransfer = function() {
    if (!currentFundId) return;
    var to = document.getElementById('fundTransferTo').value;
    var amt = parseFloat(document.getElementById('fundTransferAmt').value);
    if (!to || isNaN(amt) || amt <= 0) return toast('اختر صندوقاً ومبلغاً', 'error');
    apiCall('/api/funds/' + currentFundId + '/transfer', {
      method: 'POST',
      body: JSON.stringify({ toFundId: to, amount: amt, currency: 'USD' })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) fundsReloadDetail();
    });
  };

  document.getElementById('fundAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    var refs = [];
    var a1 = parseFloat(document.getElementById('fundRefAmt1').value);
    var c1 = document.getElementById('fundRefCur1').value;
    if (!isNaN(a1) && a1 !== 0) refs.push({ amount: a1, currency: c1 });
    var a2 = parseFloat(document.getElementById('fundRefAmt2').value);
    var c2 = document.getElementById('fundRefCur2').value;
    if (c2 && !isNaN(a2) && a2 !== 0) refs.push({ amount: a2, currency: c2 });
    var country = document.getElementById('fundAddCountry').value;
    var sy = country === 'سوريا' ? document.getElementById('fundAddSyriaGov').value : null;
    apiCall('/api/funds/add', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('fundAddName').value,
        fundNumber: document.getElementById('fundAddNumber').value,
        transferCompanyId: document.getElementById('fundAddTc').value || null,
        country: country,
        regionSyria: sy,
        referenceBalances: refs
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        fundsCloseAdd();
        fundsLoadList();
      }
    });
  });

  window.fundsEditMain = function() {
    apiCall('/api/funds/list').then(function(res) {
      var main = (res.funds || []).find(function(f) { return f.is_main; });
      if (main) {
        document.getElementById('fundMainEditName').value = main.name || '';
        document.getElementById('fundMainEditNumber').value = main.fund_number || '';
      }
      document.getElementById('fundEditMainModal').classList.remove('hidden');
      document.getElementById('fundEditMainModal').classList.add('flex');
    });
  };
  window.fundsCloseEditMain = function() {
    document.getElementById('fundEditMainModal').classList.add('hidden');
    document.getElementById('fundEditMainModal').classList.remove('flex');
  };
  window.fundsSubmitEditMain = function() {
    apiCall('/api/funds/update-main', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('fundMainEditName').value,
        fundNumber: document.getElementById('fundMainEditNumber').value
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        fundsCloseEditMain();
        fundsLoadList();
        if (typeof window.homeLoadStats === 'function') window.homeLoadStats();
      }
    });
  };

  function applyFabDeepLink() {
    var fab = '';
    try {
      fab = new URLSearchParams(window.location.search).get('fab') || '';
    } catch (_) {}
    if (fab !== 'return') return;
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete('fab');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    } catch (_) {}
    toast('افتح ملف صندوق من قائمة الصناديق، ثم استخدم قسم «تسجيل المرتجع».', 'success');
    var el = document.getElementById('fundsCards');
    if (el) setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 200);
  }

  document.addEventListener('DOMContentLoaded', function() {
    var fp = document.getElementById('fundDetailPage');
    if (fp && fp.dataset.fundId) {
      currentFundId = parseInt(fp.dataset.fundId, 10);
      apiCall('/api/funds/' + currentFundId).then(fundsApplyDetailResponse);
      return;
    }
    fillCountries();
    fundsLoadList();
    applyFabDeepLink();
  });
})();
