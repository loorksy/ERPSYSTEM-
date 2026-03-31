(function() {
  'use strict';
  var currentFundId = null;
  var fundLedgerById = {};
  var fundLedgerModalRow = null;

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

  /** شريط علوي ملون — نفس بطاقات الاعتمادات والوكالات الفرعية */
  var fundsCardBarColors = [
    'bg-indigo-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-violet-500',
    'bg-sky-500',
    'bg-orange-500',
    'bg-teal-500',
  ];

  function fundsEmptyStateHtml(kind, msg) {
    if (kind === 'loading') {
      return (
        '<div class="col-span-full acc-approvals-empty text-slate-400 text-center">' +
        '<i class="fas fa-spinner fa-spin text-3xl text-indigo-400" aria-hidden="true"></i>' +
        '<span class="text-sm font-medium">جاري التحميل...</span></div>'
      );
    }
    if (kind === 'error') {
      return (
        '<div class="col-span-full acc-approvals-empty text-slate-600 text-center">' +
        '<i class="fas fa-circle-exclamation text-4xl text-red-400" aria-hidden="true"></i>' +
        '<p class="text-red-600 font-medium text-sm">' + escHtml(msg || 'حدث خطأ') + '</p></div>'
      );
    }
    return (
      '<div class="col-span-full acc-approvals-empty text-slate-500 text-center">' +
      '<span class="inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-slate-100 text-slate-300">' +
      '<i class="fas fa-piggy-bank text-4xl" aria-hidden="true"></i></span>' +
      '<p class="font-medium text-slate-600">لا توجد صناديق</p>' +
      '<p class="text-xs text-slate-400 max-w-sm leading-relaxed mx-auto">أضف صندوقاً من زر «إضافة صندوق» أو عدّل الصندوق الرئيسي.</p></div>'
    );
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
    box.innerHTML = fundsEmptyStateHtml('loading');
    apiCall('/api/funds/list').then(function(res) {
      if (!res.success) {
        box.innerHTML = fundsEmptyStateHtml('error', res.message || '');
        return;
      }
      var list = res.funds || [];
      if (list.length === 0) {
        box.innerHTML = fundsEmptyStateHtml('empty');
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
          ? '<p class="mt-2 border-t border-slate-100 pt-2 text-[11px] font-semibold leading-snug text-rose-700">دين علينا: ' +
            escHtml(
              (Number(f.openPayablesUsd) || 0).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }) + ' USD'
            ) +
            '</p>'
          : '';
        var bar = fundsCardBarColors[idx % fundsCardBarColors.length];
        return (
          '<div class="funds-list-card group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg" onclick="fundsOpenDetail(' +
          f.id +
          ')">' +
          '<div class="' +
          bar +
          ' h-1 w-full"></div>' +
          '<div class="p-4">' +
          '<div class="flex items-start justify-between gap-2">' +
          '<h5 class="min-w-0 flex-1 text-base font-bold leading-snug text-slate-900 sm:text-[1.05rem]">' +
          escHtml(f.name || '') +
          '</h5>' +
          '<button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]" ' +
          'onclick="event.stopPropagation(); fundsDownloadLedgerPdfFor(' +
          f.id +
          ')" title="تنزيل PDF"><i class="fas fa-file-pdf text-red-500"></i></button>' +
          '</div>' +
          '<p class="mt-2 font-mono text-[11px] text-slate-500 sm:text-xs">' +
          escHtml(metaStr) +
          '</p>' +
          '<div class="mt-3 flex flex-wrap items-end justify-between gap-2 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50 to-white px-3 py-2.5">' +
          '<span class="text-xs font-semibold text-slate-500">الرصيد</span>' +
          '<span class="text-lg font-bold tabular-nums" style="color:' +
          textColor +
          '">' +
          (balStr || '0.00') +
          '</span></div>' +
          debtLine +
          '</div></div>'
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
    var numDisp = document.getElementById('fundDetailNumberDisplay');
    var locDisp = document.getElementById('fundDetailLocationDisplay');
    if (numDisp) numDisp.textContent = f.fund_number || '—';
    if (locDisp) locDisp.textContent = [f.country || '—', f.region_syria || ''].filter(Boolean).join(' · ');
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
    var ledger = res.ledger || [];
    var isMainOrProfit =
      Number(f.is_main) === 1 ||
      String(f.name || '').trim() === 'صندوق الربح' ||
      Number(f.exclude_from_dashboard) === 1;
    var hasOpening = ledger.some(function(l) {
      return String(l.type || '') === 'opening_reference';
    });
    var hasReturn = ledger.some(function(l) {
      return /return_/.test(String(l.type || ''));
    });
    var hideCashBalance = isMainOrProfit && pay > 0.0001 && hasOpening && hasReturn;
    var balDebt = pay > 0.0001;
    var balSection = document.getElementById('fundDetailBalancesSection');
    var balEl = document.getElementById('fundDetailBalances');
    if (balEl) {
      if (hideCashBalance) {
        if (balSection) balSection.classList.add('hidden');
        balEl.innerHTML = '';
      } else {
        if (balSection) balSection.classList.remove('hidden');
        var rows = (res.balances || []).map(function(b) {
          var amt = (b.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
          var cur = b.currency || '';
          var isDebtUsd = balDebt && cur === 'USD';
          var curCls = isDebtUsd ? 'text-red-700' : 'text-indigo-700';
          var amtCls = isDebtUsd ? 'text-red-950' : 'text-slate-900';
          return (
            '<div role="listitem" class="flex items-baseline justify-between gap-3 border-b border-indigo-100/50 py-2.5 last:border-0 last:pb-0 first:pt-0">' +
            '<span class="shrink-0 text-sm font-bold uppercase tracking-wide tabular-nums ' +
            curCls +
            '">' +
            cur +
            '</span>' +
            '<span dir="ltr" class="min-w-0 text-end text-2xl font-bold tabular-nums tracking-tight sm:text-3xl ' +
            amtCls +
            '">' +
            amt +
            '</span></div>'
          );
        });
        balEl.innerHTML =
          rows.length > 0
            ? rows.join('')
            : '<p class="py-1 text-center text-sm text-slate-500 sm:text-start">—</p>';
      }
    }
    fundLedgerById = {};
    (res.ledger || []).forEach(function(l) {
      if (l.id != null) fundLedgerById[l.id] = l;
    });
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
      var rowClick = l.id ? ' role="button" tabindex="0" onclick="fundsOpenLedgerRow(' + l.id + ')"' : '';
      var rowHover = l.id ? ' cursor-pointer rounded-lg -mx-1 px-1 hover:bg-white/90 transition-colors' : '';
      return '<div class="flex flex-col gap-1 border-b border-slate-100 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between ' + border + rowHover + '"' + rowClick + '>' +
        '<div class="min-w-0 pr-1"><span class="text-sm font-semibold text-slate-800">' + (l.labelAr || l.type || '') + '</span>' +
        (noteLine ? '<span class="mt-0.5 block text-[0.7rem] leading-snug text-slate-500">' + escHtml(noteLine) + '</span>' : '') + '</div>' +
        '<div class="shrink-0 text-left sm:min-w-[9rem]"><span class="font-bold tabular-nums text-slate-900">' +
        (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + escHtml(l.currency || '') + '</span>' +
        '<span class="mt-0.5 block text-[0.65rem] text-slate-500">بعد: ' + after + '</span></div></div>';
    }).join('') || '<p class="py-10 text-center text-sm text-slate-400">لا سجل حركات بعد</p>';
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

  window.fundsOpenLedgerRow = function(id) {
    var l = fundLedgerById[id];
    if (!l) return;
    fundLedgerModalRow = l;
    var titleEl = document.getElementById('fundLedgerMoveModalTitle');
    var bodyEl = document.getElementById('fundLedgerMoveModalBody');
    var btn = document.getElementById('fundLedgerMoveModalCancelBtn');
    if (titleEl) titleEl.textContent = l.labelAr || l.type || 'حركة';
    if (bodyEl) {
      var parts = [];
      parts.push(
        '<p><span class="font-semibold text-slate-600">المبلغ:</span> ' +
          (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) +
          ' ' +
          escHtml(l.currency || '') +
          '</p>'
      );
      var noteLine = l.displayNotes || l.notes || '';
      if (noteLine) {
        parts.push('<p class="break-words"><span class="font-semibold text-slate-600">الوصف:</span> ' + escHtml(noteLine) + '</p>');
      }
      if (l.type) parts.push('<p class="text-xs text-slate-500">النوع: ' + escHtml(l.type) + '</p>');
      if (l.created_at) {
        try {
          parts.push('<p class="text-xs text-slate-500">' + escHtml(new Date(l.created_at).toLocaleString('ar-SY')) + '</p>');
        } catch (_) {}
      }
      if (l.cancelled_at) parts.push('<p class="text-amber-800 font-semibold text-sm">هذه الحركة ملغاة</p>');
      bodyEl.innerHTML = parts.join('');
    }
    if (btn) btn.classList.toggle('hidden', !l.canCancel);
    var modal = document.getElementById('fundLedgerMoveModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  };

  window.fundsCloseLedgerModal = function() {
    fundLedgerModalRow = null;
    var modal = document.getElementById('fundLedgerMoveModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  };

  window.fundsConfirmCancelLedger = function() {
    if (!fundLedgerModalRow || !currentFundId || !fundLedgerModalRow.id || !fundLedgerModalRow.canCancel) return;
    if (!window.confirm('إلغاء هذه الحركة واسترجاع الأرصدة والالتزامات المرتبطة بها؟')) return;
    apiCall('/api/funds/' + currentFundId + '/ledger/' + fundLedgerModalRow.id + '/cancel', { method: 'POST' }).then(function(res) {
      toast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        fundsCloseLedgerModal();
        fundsReloadDetail();
      }
    });
  };

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

  window.fundsDownloadLedgerPdfFor = function(fundId) {
    if (!fundId) return;
    window.open('/api/reports/pdf/fund-ledger?fundId=' + encodeURIComponent(fundId), '_blank');
  };

  window.fundsCloseDetail = function() {
    window.location.href = '/funds';
  };
  function fundsToggleReturnTarget() {
    var d = document.getElementById('fundReturnDisposition');
    var rts = document.getElementById('fundReturnTarget');
    var wrap = document.getElementById('fundReturnTargetWrap');
    if (!d || !rts) return;
    var show = d.value === 'transfer_to_fund';
    if (wrap) {
      wrap.classList.toggle('hidden', !show);
    } else {
      rts.classList.toggle('hidden', !show);
    }
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
