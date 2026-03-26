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
    apiCall('/api/funds/list').then(function(res) {
      if (!res.success) {
        box.innerHTML = '<p class="text-red-500 col-span-full text-center">' + (res.message || 'فشل') + '</p>';
        return;
      }
      var list = res.funds || [];
      if (list.length === 0) {
        box.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">لا توجد صناديع</p>';
        return;
      }
      box.innerHTML = list.map(function(f) {
        var bal = (f.balances || []).map(function(b) {
          return (b.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (b.currency || '');
        }).join(' | ');
        var main = f.is_main ? '<span class="text-amber-600 text-xs font-bold">رئيسي</span>' : '';
        return '<div class="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm hover:shadow-md cursor-pointer" onclick="fundsOpenDetail(' + f.id + ')">' +
          '<h5 class="font-bold text-slate-800">' + (f.name || '') + ' ' + main + '</h5>' +
          '<p class="text-xs text-slate-500 mt-1">' + (f.fund_number || '') + ' · ' + (f.country || '') + '</p>' +
          '<p class="text-sm font-semibold text-indigo-600 mt-2">' + (bal || '0') + '</p></div>';
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

  window.fundsOpenDetail = function(id) {
    currentFundId = id;
    apiCall('/api/funds/' + id).then(function(res) {
      if (!res.success) return toast(res.message || 'فشل', 'error');
      var f = res.fund;
      document.getElementById('fundDetailTitle').textContent = f.name || '';
      document.getElementById('fundDetailMeta').innerHTML =
        '<p><strong>الرقم:</strong> ' + (f.fund_number || '-') + '</p>' +
        '<p><strong>الدولة:</strong> ' + (f.country || '-') + ' ' + (f.region_syria || '') + '</p>';
      document.getElementById('fundDetailBalances').innerHTML = (res.balances || []).map(function(b) {
        return '<span class="px-3 py-1 rounded-lg bg-slate-100 text-slate-800">' +
          (b.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (b.currency || '') + '</span>';
      }).join(' ');
      document.getElementById('fundDetailLedger').innerHTML = (res.ledger || []).map(function(l) {
        return '<div class="py-2 border-b border-slate-50 flex justify-between"><span>' + (l.type || '') + '</span><span>' +
          (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (l.currency || '') + '</span></div>';
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
      document.getElementById('fundDetailModal').classList.remove('hidden');
      document.getElementById('fundDetailModal').classList.add('flex');
    });
  };
  window.fundsCloseDetail = function() {
    document.getElementById('fundDetailModal').classList.add('hidden');
    document.getElementById('fundDetailModal').classList.remove('flex');
    currentFundId = null;
  };
  window.fundsSetMain = function() {
    if (!currentFundId) return;
    apiCall('/api/funds/' + currentFundId + '/set-main', { method: 'POST', body: '{}' }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      fundsLoadList();
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
        fundsOpenDetail(currentFundId);
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
      if (res.success) fundsOpenDetail(currentFundId);
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
    toast('افتح صندوقاً من القائمة، ثم استخدم قسم «تسجيل المرتجع» في نافذة التفاصيل.', 'success');
    var el = document.getElementById('fundsCards');
    if (el) setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 200);
  }

  document.addEventListener('DOMContentLoaded', function() {
    fillCountries();
    fundsLoadList();
    applyFabDeepLink();
  });
})();
