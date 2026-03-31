(function() {
  var currentId = null;
  var currentPinned = false;
  var accBulkStagingItems = [];
  /** معرف المعتمد عند فتح «إضافة مبلغ» أو «تحويل» من بطاقة القائمة */
  var accShortcutModalId = null;
  /** تُملأ من accPopulateDetail / accOpenShortcut لاستخدام نافذة خصم «دين لنا» */
  var accDetailBalanceReceivable = 0;
  var accListModalReceivable = 0;
  var accReceivableOffsetPending = null;
  var accReceivableOffsetSelectedMode = 'defer';

  function accDeferSettlementStorageKey(entityId) {
    return 'accDeferSettlement_' + (entityId != null ? String(entityId) : '');
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function accCloseSidebarIfOpen() {
    if (typeof window.closeSidebar === 'function') window.closeSidebar();
  }

  function accNeedsReceivableOffsetModal(kind, rec, amountStr) {
    if (kind !== 'debt_payable' && kind !== 'debt_payable_no_fund') return false;
    var g = parseFloat(String(amountStr != null ? amountStr : '').replace(/,/g, ''));
    if (isNaN(g) || g <= 0) return false;
    return (Number(rec) || 0) > 0.0001;
  }

  function accApplyReceivableOffsetBtnStyles(mode) {
    var styles = {
      defer: 'border-slate-200 bg-white hover:border-indigo-300',
      full: 'border-slate-200 bg-white hover:border-emerald-300',
      custom: 'border-slate-200 bg-white hover:border-amber-300',
    };
    var sel = {
      defer: 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200',
      full: 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200',
      custom: 'border-amber-500 bg-amber-50 ring-1 ring-amber-200',
    };
    ['defer', 'full', 'custom'].forEach(function(m) {
      var el = document.getElementById(
        m === 'defer' ? 'accReceivableOffsetBtnDefer' : m === 'full' ? 'accReceivableOffsetBtnFull' : 'accReceivableOffsetBtnCustom'
      );
      if (!el) return;
      el.className =
        'rounded-xl border-2 px-4 py-3 text-right text-sm font-bold text-slate-800 transition ' +
        (mode === m ? sel[m] : styles[m]);
    });
    var wrap = document.getElementById('accReceivableOffsetCustomWrap');
    var err = document.getElementById('accReceivableOffsetErr');
    if (err) {
      err.classList.add('hidden');
      err.textContent = '';
    }
    if (wrap) wrap.classList.toggle('hidden', mode !== 'custom');
  }

  function accCloseReceivableOffsetModal() {
    var modal = document.getElementById('accReceivableOffsetModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.setAttribute('aria-hidden', 'true');
    }
    accReceivableOffsetPending = null;
  }

  function wireAccReceivableOffsetModal() {
    var modal = document.getElementById('accReceivableOffsetModal');
    if (!modal || modal.dataset.accRecvOffBound) return;
    modal.dataset.accRecvOffBound = '1';
    function setMode(m) {
      accReceivableOffsetSelectedMode = m;
      accApplyReceivableOffsetBtnStyles(m);
    }
    var bd = document.getElementById('accReceivableOffsetBtnDefer');
    var bf = document.getElementById('accReceivableOffsetBtnFull');
    var bc = document.getElementById('accReceivableOffsetBtnCustom');
    if (bd) bd.addEventListener('click', function() { setMode('defer'); });
    if (bf) bf.addEventListener('click', function() { setMode('full'); });
    if (bc) bc.addEventListener('click', function() { setMode('custom'); });
    var sub = document.getElementById('accReceivableOffsetSubmit');
    if (sub) {
      sub.addEventListener('click', function() {
        var p = accReceivableOffsetPending;
        if (!p) return;
        var mode = accReceivableOffsetSelectedMode;
        var body = Object.assign({}, p.baseBody);
        body.receivableOffsetMode = mode;
        if (mode === 'custom') {
          var inp = document.getElementById('accReceivableOffsetCustomInput');
          var raw = inp && inp.value !== '' ? parseFloat(inp.value) : NaN;
          var maxC = Math.min(Number(p.rec) || 0, Number(p.amount) || 0);
          if (isNaN(raw) || raw <= 0) {
            var err = document.getElementById('accReceivableOffsetErr');
            if (err) {
              err.textContent = 'أدخل مبلغ الخصم أو اختر خياراً آخر.';
              err.classList.remove('hidden');
            }
            return;
          }
          if (raw > maxC + 0.001) {
            var err2 = document.getElementById('accReceivableOffsetErr');
            if (err2) {
              err2.textContent = 'الخصم لا يتجاوز ' + accFmtMoney(maxC) + '.';
              err2.classList.remove('hidden');
            }
            return;
          }
          body.receivableOffsetUsd = raw;
        }
        apiCall(p.url, { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
          if (res && res.success && p.entityId != null) {
            try {
              var dk = accDeferSettlementStorageKey(p.entityId);
              if (mode === 'defer') sessionStorage.setItem(dk, '1');
              else sessionStorage.removeItem(dk);
            } catch (e) {}
          }
          accCloseReceivableOffsetModal();
          if (typeof p.onDone === 'function') p.onDone(res);
        });
      });
    }
  }

  function accOpenReceivableOffsetModal(opts) {
    wireAccReceivableOffsetModal();
    var modal = document.getElementById('accReceivableOffsetModal');
    if (!modal) {
      if (opts && typeof opts.onDone === 'function') {
        var body = Object.assign({}, opts.baseBody, { receivableOffsetMode: 'defer' });
        apiCall(opts.url, { method: 'POST', body: JSON.stringify(body) }).then(opts.onDone);
      }
      return;
    }
    accReceivableOffsetPending = opts;
    accReceivableOffsetSelectedMode = 'defer';
    accSyncCurrencyUi();
    var recD = document.getElementById('accReceivableOffsetRecDisplay');
    var amtD = document.getElementById('accReceivableOffsetAmtDisplay');
    var maxH = document.getElementById('accReceivableOffsetMaxHint');
    var cinp = document.getElementById('accReceivableOffsetCustomInput');
    if (recD) recD.textContent = accFmtMoney(opts.rec);
    if (amtD) amtD.textContent = accFmtMoney(opts.amount);
    var mx = Math.round(Math.min(Number(opts.rec) || 0, Number(opts.amount) || 0) * 100) / 100;
    if (maxH) maxH.textContent = accFmtMoney(mx);
    if (cinp) {
      cinp.value = mx > 0 ? String(mx) : '';
      cinp.setAttribute('max', String(mx));
    }
    accApplyReceivableOffsetBtnStyles('defer');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.setAttribute('aria-hidden', 'false');
  }

  window.accCloseReceivableOffsetModal = accCloseReceivableOffsetModal;

  var accConfirmCallback = null;

  function wireAccConfirmModal() {
    var modal = document.getElementById('accConfirmModal');
    if (!modal || modal.dataset.accConfirmBound) return;
    modal.dataset.accConfirmBound = '1';
    var ok = document.getElementById('accConfirmOk');
    var cancel = document.getElementById('accConfirmCancel');
    if (ok) ok.addEventListener('click', function() { accConfirmFinish(true); });
    if (cancel) cancel.addEventListener('click', function() { accConfirmFinish(false); });
    modal.addEventListener('click', function(e) {
      if (e.target === modal) accConfirmFinish(false);
    });
  }

  function accConfirmFinish(confirmed) {
    var cb = accConfirmCallback;
    accConfirmCallback = null;
    var modal = document.getElementById('accConfirmModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'flex-col');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (typeof cb === 'function') cb(confirmed);
  }

  function accConfirmOpen(opts, callback) {
    opts = opts || {};
    accConfirmCallback = callback;
    wireAccConfirmModal();
    var titleEl = document.getElementById('accConfirmTitle');
    var msgEl = document.getElementById('accConfirmMessage');
    var iconWrap = document.getElementById('accConfirmIcon');
    var okBtn = document.getElementById('accConfirmOk');
    var cancelBtn = document.getElementById('accConfirmCancel');
    if (titleEl) titleEl.textContent = opts.title || 'تأكيد';
    if (msgEl) msgEl.textContent = opts.message || '';
    var danger = opts.variant === 'danger';
    var save = opts.variant === 'save' || opts.variant === 'primary';
    if (iconWrap) {
      iconWrap.className =
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ' +
        (danger
          ? 'bg-red-50 text-red-600 border-red-100'
          : save
            ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
            : 'bg-indigo-50 text-indigo-600 border-indigo-100');
      var ic = iconWrap.querySelector('i');
      if (ic) {
        ic.setAttribute('aria-hidden', 'true');
        ic.className = danger ? 'fas fa-trash-alt text-lg' : save ? 'fas fa-save text-lg' : 'fas fa-circle-question text-lg';
      }
    }
    if (okBtn) {
      okBtn.className =
        'w-full sm:w-auto px-6 py-3 rounded-xl font-bold text-sm text-white shadow-md transition-colors ' +
        (danger ? 'bg-red-600 hover:bg-red-700 shadow-red-200/50' : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200/50');
      okBtn.textContent = opts.okText || 'نعم';
    }
    if (cancelBtn) cancelBtn.textContent = opts.cancelText || 'لا';
    var modal = document.getElementById('accConfirmModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'flex-col');
      modal.setAttribute('aria-hidden', 'false');
    }
  }

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

  var accCardBarColors = [
    'bg-indigo-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-violet-500',
    'bg-sky-500',
    'bg-orange-500',
    'bg-teal-500',
  ];

  function accFmtMoney(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    var v = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(v)) v = 0;
    var s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var sym = window.currencySymbol;
    return sym && sym !== '' ? s + ' ' + sym : s;
  }

  function accSyncCurrencyUi() {
    var sym = window.currencySymbol;
    if (sym === undefined || sym === null) sym = '$';
    document.querySelectorAll('.acc-currency-sym').forEach(function(el) {
      el.textContent = sym || '';
    });
  }

  function accLedgerTypeLabel(t) {
    var m = {
      debt_to_us: 'دين لنا',
      debt_to_them: 'دين علينا',
      debt_to_them_no_fund: 'لهم — مطلوب دفع (بدون صندوق)',
      salary: 'راتب',
      payable_discount_profit: 'ربح خصم (علينا/لهم)',
      transfer: 'تحويل / تسليم',
      delivery: 'تسليم — تصفير علينا',
      deferred_reserve_sync: 'مزامنة احتياطي مؤجل',
      receivable_settlement: 'تسوية بين دين لنا وعلينا',
      receivable_offset_from_credit: 'خصم من دين لنا (بموجب ائتمان)',
    };
    return m[t] || t || '';
  }

  function accLedgerSignedHtml(l) {
    var t = l.entry_type || '';
    var dir = l.direction || '';
    var amt = Number(l.amount) || 0;
    var absFmt = escHtml(accFmtMoney(Math.abs(amt)));
    var pos = 'text-emerald-600';
    var neg = 'text-red-600';
    if (t === 'debt_to_us') {
      return '<span class="font-bold tabular-nums ' + neg + '">−' + absFmt + '</span>';
    }
    if (t === 'debt_to_them' || t === 'debt_to_them_no_fund') {
      return '<span class="font-bold tabular-nums ' + pos + '">+' + absFmt + '</span>';
    }
    if (t === 'payable_discount_profit') {
      return '<span class="font-bold tabular-nums ' + pos + '">+' + absFmt + '</span>';
    }
    if (t === 'salary') {
      if (dir === 'to_us') {
        return '<span class="font-bold tabular-nums ' + pos + '">+' + absFmt + '</span>';
      }
      return '<span class="font-bold tabular-nums ' + neg + '">−' + absFmt + '</span>';
    }
    if (t === 'transfer') {
      return '<span class="font-bold tabular-nums ' + neg + '">−' + absFmt + '</span>';
    }
    if (t === 'delivery') {
      return '<span class="font-bold tabular-nums ' + neg + '">−' + absFmt + '</span>';
    }
    if (t === 'deferred_reserve_sync') {
      if (dir === 'from_us') {
        return '<span class="font-bold tabular-nums ' + neg + '">−' + absFmt + '</span>';
      }
      if (dir === 'to_us') {
        return '<span class="font-bold tabular-nums ' + pos + '">+' + absFmt + '</span>';
      }
      return '<span class="font-semibold tabular-nums text-slate-700">' + absFmt + '</span>';
    }
    if (t === 'receivable_settlement') {
      return (
        '<span class="font-bold tabular-nums text-indigo-700">' +
        escHtml(accFmtMoney(amt)) +
        '</span> <span class="text-[10px] text-slate-500">(يُنقص لنا وعلينا)</span>'
      );
    }
    if (t === 'receivable_offset_from_credit') {
      return (
        '<span class="font-bold tabular-nums text-amber-800">−' +
        absFmt +
        '</span> <span class="text-[10px] text-slate-500">(من دين لنا)</span>'
      );
    }
    return '<span class="font-semibold tabular-nums text-slate-800">' + escHtml(accFmtMoney(amt)) + '</span>';
  }

  function accNetBalanceClass(net) {
    var n = Number(net) || 0;
    if (n > 0.0001) return 'text-emerald-700';
    if (n < -0.0001) return 'text-red-600';
    return 'text-slate-600';
  }

  function accLedgerRowHtml(l) {
    var label = escHtml(accLedgerTypeLabel(l.entry_type || ''));
    var signed = accLedgerSignedHtml(l);
    var balAfter =
      l.balance_after != null && !isNaN(Number(l.balance_after))
        ? '<span class="font-bold tabular-nums ' +
          accNetBalanceClass(l.balance_after) +
          '">' +
          escHtml(accFmtMoney(l.balance_after)) +
          '</span>'
        : '<span class="text-slate-400">—</span>';
    var note = l.notes ? '<p class="mt-0.5 line-clamp-2 text-[11px] text-slate-500">' + escHtml(l.notes) + '</p>' : '';
    var dt = l.created_at
      ? '<span class="mt-1 block text-[10px] text-slate-400">' + escHtml(String(l.created_at).replace('T', ' ').slice(0, 19)) + '</span>'
      : '';
    return (
      '<div class="border-b border-slate-100 bg-white px-1 py-3 last:border-b-0 hover:bg-slate-50/80 sm:px-2">' +
      '<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">' +
      '<div class="min-w-0 flex-1">' +
      '<span class="text-sm font-medium text-slate-800">' +
      label +
      '</span>' +
      note +
      dt +
      '</div>' +
      '<div class="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end sm:text-left">' +
      '<div class="text-xs text-slate-500">المبلغ</div>' +
      signed +
      '<div class="mt-1 text-[11px] text-slate-500">الصافي بعد الحركة</div>' +
      balAfter +
      '</div></div></div>'
    );
  }

  function accSyncBulkStep() {
    var modal = document.getElementById('accBulkModal');
    if (!modal) return;
    var reviewing = accBulkStagingItems.length > 0;
    modal.setAttribute('data-acc-step', reviewing ? 'review' : 'import');
    var st = document.getElementById('accBulkStaging');
    if (st) {
      if (reviewing) st.classList.remove('hidden');
      else st.classList.add('hidden');
    }
  }

  function accScrollBulkModalToStaging() {
    var body = document.getElementById('accBulkModalBody');
    var st = document.getElementById('accBulkStaging');
    if (!body || !st) return;
    var rect = st.getBoundingClientRect();
    var bodyRect = body.getBoundingClientRect();
    var top = rect.top - bodyRect.top + body.scrollTop;
    body.scrollTop = Math.max(0, top - 4);
  }

  function accResetBulkStagingTableScroll() {
    var wrap = document.querySelector('#accBulkStagingTable .acc-bulk-scroll');
    if (wrap) wrap.scrollLeft = 0;
    var body = document.getElementById('accBulkModalBody');
    if (body) body.scrollTop = 0;
  }

  function accBulkReviewKindCodeToRow(code) {
    if (code === 'debt_payable') return { amountKind: 'debt_payable', salaryDirection: 'to_them' };
    if (code === 'debt_payable_no_fund') return { amountKind: 'debt_payable_no_fund', salaryDirection: 'to_them' };
    return { amountKind: 'debt_receivable', salaryDirection: 'to_us' };
  }

  function accRowToBulkReviewKindCode(row) {
    if (row.amountKind === 'debt_payable') return 'debt_payable';
    if (row.amountKind === 'debt_payable_no_fund') return 'debt_payable_no_fund';
    return 'debt_receivable';
  }

  function accApplyBulkReviewKindToItems() {
    var sel = document.getElementById('accBulkReviewKind');
    if (!sel || !accBulkStagingItems.length) return;
    var r = accBulkReviewKindCodeToRow(sel.value || 'debt_receivable');
    accBulkStagingItems.forEach(function(it) {
      it.amountKind = r.amountKind;
      it.salaryDirection = r.salaryDirection;
      if (r.amountKind === 'debt_receivable') it.discountPct = '';
    });
  }

  function accSyncBulkReviewKindSelect() {
    var sel = document.getElementById('accBulkReviewKind');
    if (!sel || !accBulkStagingItems.length) return;
    sel.value = accRowToBulkReviewKindCode(accBulkStagingItems[0]);
  }

  function accShowStagingFromPreview(preview) {
    var valid = (preview || []).filter(function(r) { return r.valid; });
    if (!valid.length) {
      toast('لا توجد صفوف صالحة', 'error');
      return;
    }
    accBulkStagingItems = valid.map(function(r) {
      return {
        lineIndex: r.lineIndex,
        code: r.code,
        name: r.name,
        amount: r.amount,
        parentRef: r.parentRef || '',
        discountPct: '',
        salaryDirection: 'to_us',
        amountKind: 'debt_receivable',
        selected: true,
      };
    });
    accSyncBulkReviewKindSelect();
    accApplyBulkReviewKindToItems();
    accRenderStagingTable();
    var st = document.getElementById('accBulkStaging');
    if (st) st.classList.remove('hidden');
    accSyncBulkStep();
    accResetBulkStagingTableScroll();
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        accScrollBulkModalToStaging();
        accResetBulkStagingTableScroll();
      });
    });
  }

  function accRenderStagingTable() {
    var tb = document.getElementById('accBulkStagingTable');
    if (!tb) return;
    var badge = document.getElementById('accBulkStagingBadge');
    var badgeText = badge && badge.querySelector('.acc-bulk-badge-text');
    if (badgeText) badgeText.textContent = accBulkStagingItems.length + ' صف';
    else if (badge) badge.textContent = accBulkStagingItems.length + ' صف';
    if (!accBulkStagingItems.length) {
      tb.innerHTML = '';
      return;
    }

    function lineNum(row, idx) {
      return row.lineIndex != null ? row.lineIndex : idx + 1;
    }

    var rows = accBulkStagingItems.map(function(row, idx) {
      var ln = lineNum(row, idx);
      var discVal = row.discountPct !== '' && row.discountPct != null && row.discountPct !== undefined ? escHtml(String(row.discountPct)) : '';
      var rowBg = agencyCardColors[idx % agencyCardColors.length];
      return (
        '<tr class="acc-bulk-tr acc-bulk-tr-palette transition-colors relative" style="background:' + rowBg + '">' +
        '<td class="acc-bulk-td acc-bulk-cell-num p-3 align-middle text-slate-400 text-xs sm:w-10 text-center" data-label="#"><span class="acc-bulk-val">' + escHtml(ln) + '</span></td>' +
        '<td class="acc-bulk-td acc-bulk-cell-name p-3 align-middle" data-label="المعتمد">' +
          '<div class="acc-bulk-val acc-bulk-card-main">' +
            '<div class="acc-bulk-card-title">' +
            '<span class="acc-bulk-card-name">' +
            escHtml(row.name) +
            '</span>' +
            (row.code
              ? '<span class="acc-bulk-card-code">' + escHtml(row.code) + '</span>'
              : '') +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td class="acc-bulk-td acc-bulk-cell-amt p-3 align-middle" data-label="المبلغ"><span class="acc-bulk-val acc-bulk-amt-value tabular-nums">' +
        escHtml(accFmtMoney(parseFloat(String(row.amount != null ? row.amount : '').replace(/,/g, '')) || 0)) +
        '</span></td>' +
        '<td class="acc-bulk-td acc-bulk-cell-disc p-3 align-middle" data-label="خصم %">' +
        '<input type="number" min="0" max="100" step="0.1" class="acc-bulk-disc w-full sm:w-24 px-3 py-2 sm:py-1.5 rounded-lg border border-slate-200 text-sm text-center focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none" data-idx="' + idx + '" value="' + discVal + '" placeholder="—"></td>' +
        '<td class="acc-bulk-td acc-bulk-cell-act p-3 align-middle text-left sm:w-12" data-label="إجراء">' +
        '<button type="button" class="acc-bulk-del-btn w-full sm:w-8 sm:h-8 inline-flex items-center justify-center rounded-lg py-2 sm:py-0 text-sm font-semibold sm:font-normal" data-acc-delete="' + idx + '" title="حذف الصف"><span class="sm:hidden ml-2">حذف</span><i class="fas fa-trash-alt pointer-events-none text-sm"></i></button></td></tr>'
      );
    }).join('');

    var colgroup =
      '<colgroup><col style="width:6%"><col style="width:32%"><col style="width:16%"><col style="width:14%"><col style="width:12%"></colgroup>';

    var thead =
      '<thead class="acc-bulk-thead">' +
      '<tr class="border-b border-slate-200 bg-slate-50 text-slate-600">' +
      '<th class="p-3 text-xs font-bold text-center">#</th>' +
      '<th class="p-3 text-xs font-bold text-right">المعتمد</th>' +
      '<th class="p-3 text-xs font-bold text-right">المبلغ</th>' +
      '<th class="p-3 text-xs font-extrabold text-slate-800 text-center">خصم %</th>' +
      '<th class="p-3 text-xs font-extrabold text-slate-800 text-center">إجراء</th>' +
      '</tr></thead>';

    var rk = document.getElementById('accBulkReviewKind');
    var showDisc = !rk || rk.value !== 'debt_receivable';
    var debtClass = ' acc-bulk-debt-mode' + (showDisc ? '' : ' acc-bulk-no-disc');
    tb.innerHTML =
      '<div class="acc-bulk-scroll w-full min-w-0 overflow-x-auto">' +
      '<table class="acc-bulk-review w-full min-w-0 sm:min-w-[640px] text-right border-collapse text-sm' + debtClass + '">' +
      colgroup +
      thead +
      '<tbody class="acc-bulk-tbody">' + rows + '</tbody></table></div>';
  }

  function wireAccBulkStagingDelegation() {
    var c = document.getElementById('accBulkStagingTable');
    if (!c || c.dataset.accBulkBound) return;
    c.dataset.accBulkBound = '1';
    c.addEventListener('input', function(e) {
      var t = e.target;
      if (!t.classList.contains('acc-bulk-disc')) return;
      var idx = parseInt(t.getAttribute('data-idx'), 10);
      if (isNaN(idx) || !accBulkStagingItems[idx]) return;
      accBulkStagingItems[idx].discountPct = t.value;
    });
    c.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-acc-delete]');
      if (!btn) return;
      e.preventDefault();
      var idx = parseInt(btn.getAttribute('data-acc-delete'), 10);
      if (isNaN(idx) || !accBulkStagingItems[idx]) return;
      var row = accBulkStagingItems[idx];
      var nm = row.name != null ? String(row.name).trim() : '';
      var cd = row.code != null ? String(row.code).trim() : '';
      var display = nm || cd || 'هذا الصف';
      display = display.replace(/«/g, '\u2039').replace(/»/g, '\u203a');
      accConfirmOpen(
        {
          title: 'حذف معتمد',
          message: 'هل أنت متأكد من حذف المعتمد «' + display + '»؟',
          variant: 'danger',
          okText: 'نعم، احذف',
          cancelText: 'لا',
        },
        function(confirmed) {
          if (confirmed) window.accRemoveStagingRow(idx);
        }
      );
    });
  }

  window.accRemoveStagingRow = function(idx) {
    accBulkStagingItems.splice(idx, 1);
    if (!accBulkStagingItems.length) {
      accClearBulkStaging();
      return;
    }
    accRenderStagingTable();
  };

  window.accClearBulkStaging = function() {
    accBulkStagingItems = [];
    var st = document.getElementById('accBulkStaging');
    if (st) st.classList.add('hidden');
    var tb = document.getElementById('accBulkStagingTable');
    if (tb) tb.innerHTML = '';
    accSyncBulkStep();
  };

  function accCommitBulkExecute() {
    accApplyBulkReviewKindToItems();
    var picked = accBulkStagingItems;
    if (!picked.length) return;
    var rk = document.getElementById('accBulkReviewKind');
    var skipDisc = rk && rk.value === 'debt_receivable';
    var cid = document.getElementById('accBulkCycle').value;
    var items = picked.map(function(r) {
      var it = {
        code: r.code,
        name: r.name,
        amount: r.amount,
        parentRef: r.parentRef,
        salaryDirection: r.salaryDirection,
        amountKind: r.amountKind === 'debt_to_us' ? 'debt_receivable' : r.amountKind,
      };
      if (!skipDisc && r.discountPct !== '' && r.discountPct != null && String(r.discountPct).trim() !== '') {
        it.discountPct = r.discountPct;
      }
      it.receivableOffsetMode = 'defer';
      return it;
    });
    apiCall('/api/accreditations/bulk-balance-commit', {
      method: 'POST',
      body: JSON.stringify({ cycleId: cid || null, items: items, defaultBrokeragePct: null }),
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accClearBulkStaging();
        accCloseBulk();
        var f = document.getElementById('accBulkFile');
        if (f) f.value = '';
        accBulkClearFileNameDisplay();
        var p = document.getElementById('accBulkPaste');
        if (p) p.value = '';
        var u = document.getElementById('accBulkSheetUrl');
        if (u) u.value = '';
        accLoad();
      }
    });
  }

  window.accCommitBulk = function() {
    if (!accBulkStagingItems.length) {
      toast('لا توجد صفوف', 'error');
      return;
    }
    accApplyBulkReviewKindToItems();
    var n = accBulkStagingItems.length;
    accConfirmOpen(
      {
        title: 'تأكيد الحفظ',
        message:
          'هل أنت متأكد من حفظ الأرصدة واعتمادها؟\n\n' +
          'سيتم تنفيذ العملية على ' +
          (n === 1 ? 'صف واحد' : n + ' صفوف') +
          '. لن تُعاد مراجعة الملف أو الملفات المستوردة بعد التنفيذ.',
        variant: 'save',
        okText: 'نعم، احفظ',
        cancelText: 'لا',
      },
      function(confirmed) {
        if (!confirmed) return;
        accCommitBulkExecute();
      }
    );
  };

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(function(r) { return r.json(); });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }

  function accApprovalsEmptyStateHtml(kind, msg) {
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
      '<i class="fas fa-clipboard-list text-4xl" aria-hidden="true"></i></span>' +
      '<p class="font-medium text-slate-600">لا يوجد معتمدون</p>' +
      '<p class="text-xs text-slate-400 max-w-sm leading-relaxed mx-auto">أضف معتمداً من زر «إضافة معتمد» أو استورد أرصدة من «رفع أرصدة».</p></div>'
    );
  }

  window.accLoad = function() {
    var box = document.getElementById('accCards');
    if (!box) return;
    box.innerHTML = accApprovalsEmptyStateHtml('loading');
    apiCall('/api/accreditations/list').then(function(res) {
      if (!res.success) {
        box.innerHTML = accApprovalsEmptyStateHtml('error', res.message || '');
        return;
      }
      var list = res.list || [];
      if (list.length === 0) {
        box.innerHTML = accApprovalsEmptyStateHtml('empty');
        return;
      }
      box.innerHTML = list.map(function(a, idx) {
        var net = Number(a.balance_amount) || 0;
        var textColor = '#64748b';
        if (net > 0.0001) textColor = '#047857';
        else if (net < -0.0001) textColor = '#b91c1c';
        var bar = accCardBarColors[idx % accCardBarColors.length];
        var pinHtml = a.pinned
          ? '<span class="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-amber-200 bg-amber-100 text-amber-700 shadow-sm" title="مثبت"><i class="fas fa-thumbtack text-xs"></i></span>'
          : '';
        var settleHide = false;
        try {
          settleHide = sessionStorage.getItem(accDeferSettlementStorageKey(a.id)) === '1';
        } catch (e) {}
        var settleHint =
          !settleHide &&
          (Number(a.balance_payable) || 0) > 0.0001 &&
          (Number(a.balance_receivable) || 0) > 0.0001
            ? '<span class="absolute left-2 top-2 z-10 max-w-[calc(100%-5rem)] truncate rounded-lg border border-amber-300 bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-900 shadow-sm" title="يوجد دين لنا ودين علينا — يحتاج تسوية من ملف المعتمد">تسوية</span>'
            : '';
        return (
          '<div class="acc-list-card group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg" onclick="accOpen(' +
          a.id +
          ')">' +
          '<div class="' +
          bar +
          ' h-1 w-full"></div>' +
          '<div class="p-4">' +
          pinHtml +
          settleHint +
          '<div class="flex items-start justify-between gap-2">' +
          '<h5 class="min-w-0 flex-1 text-base font-bold leading-snug text-slate-900 sm:text-[1.05rem]">' +
          escHtml(a.name || '') +
          '</h5>' +
          '</div>' +
          '<p class="mt-2 font-mono text-[11px] text-slate-500 sm:text-xs">كود: ' +
          escHtml(a.code || '—') +
          '</p>' +
          '<div class="mt-3 flex flex-wrap items-end justify-between gap-2 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50 to-white px-3 py-2.5">' +
          '<span class="text-xs font-semibold text-slate-500">الصافي</span>' +
          '<span class="text-lg font-bold tabular-nums" style="color:' +
          textColor +
          '">' +
          escHtml(accFmtMoney(net)) +
          '</span></div>' +
          '<div class="acc-card-shortcuts mt-3 flex gap-2 border-t border-slate-100 pt-3" onclick="event.stopPropagation()">' +
          '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white shadow-md shadow-emerald-600/20 transition hover:bg-emerald-700 active:scale-[0.99] sm:text-xs" onclick="accOpenShortcut(' +
          a.id +
          ',\'add\')"><i class="fas fa-plus-circle text-[0.7rem]"></i>إضافة مبلغ</button>' +
          '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-slate-600 bg-slate-700 px-3 py-2 text-[11px] font-bold text-white shadow-sm transition hover:bg-slate-800 active:scale-[0.99] sm:text-xs" onclick="accOpenShortcut(' +
          a.id +
          ',\'transfer\')"><i class="fas fa-right-left text-[0.7rem]"></i>تحويل</button>' +
          '</div></div></div>'
        );
      }).join('');
    });
  };

  window.accOpenAdd = function() {
    accCloseSidebarIfOpen();
    document.getElementById('accAddModal').classList.remove('hidden');
    document.getElementById('accAddModal').classList.add('flex', 'flex-col');
  };
  window.accCloseAdd = function() {
    document.getElementById('accAddModal').classList.add('hidden');
    document.getElementById('accAddModal').classList.remove('flex', 'flex-col');
  };

  /** @returns {Promise<string>} قيمة المحدد بعد التعبئة (آخر دورة إن طُلب defaultLatest) */
  function fillCycleSelect(selId, opts) {
    opts = opts || {};
    var sel = document.getElementById(selId);
    if (!sel) return Promise.resolve('');
    return apiCall('/api/sub-agencies/cycles/list').then(function(c) {
      var cycles = c.cycles || [];
      var cur = opts.keepSelection ? sel.value : '';
      sel.innerHTML = '<option value="">— دورة (اختياري) —</option>';
      cycles.forEach(function(x) {
        sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
      });
      if (opts.defaultLatest && cycles.length > 0) {
        sel.value = String(cycles[0].id);
      } else if (cur) {
        sel.value = cur;
      }
      return sel.value || '';
    });
  }

  function accDelRowHtml(a) {
    var name = escHtml(a.name || '');
    var code = escHtml(a.code || '');
    var bal = accFmtMoney(a.balance_amount || 0);
    return (
      '<label class="acc-del-row flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 p-3 rounded-xl border border-slate-100 bg-white cursor-pointer hover:border-indigo-100 hover:bg-indigo-50/40 transition-colors shadow-sm text-center sm:text-right">' +
      '<input type="checkbox" class="acc-del-cb h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" value="' + a.id + '" checked>' +
      '<span class="flex-1 min-w-0 text-sm text-slate-800">' + name + (code ? ' <span class="text-slate-400 text-xs font-mono">' + code + '</span>' : '') + '</span>' +
      '<span class="shrink-0 text-sm font-bold text-emerald-600 tabular-nums">' + bal + '</span>' +
      '</label>'
    );
  }

  function accRefreshDeliveryList(cycleId) {
    var listEl = document.getElementById('accDelList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="py-10 text-center text-sm text-slate-500">جاري التحميل…</p>';
    accSyncDelSelectAll();
    var url = '/api/accreditations/with-balance';
    if (cycleId) url += '?cycleId=' + encodeURIComponent(cycleId);
    apiCall(url).then(function(res) {
      if (!listEl) return;
      if (!res.success || !(res.list || []).length) {
        listEl.innerHTML = '<p class="py-10 text-center text-sm text-slate-500">لا يوجد معتمدون برصيد' + (cycleId ? ' له نشاط في الدورة المختارة' : '') + '</p>';
        accSyncDelSelectAll();
        return;
      }
      listEl.innerHTML = (res.list || []).map(accDelRowHtml).join('');
      accSyncDelSelectAll();
    });
  }

  function accSyncDelSelectAll() {
    var boxes = document.querySelectorAll('#accDelList .acc-del-cb');
    var sa = document.getElementById('accDelSelectAll');
    if (!sa) return;
    if (!boxes.length) {
      sa.checked = false;
      sa.indeterminate = false;
      sa.disabled = true;
      return;
    }
    sa.disabled = false;
    var n = boxes.length;
    var c = document.querySelectorAll('#accDelList .acc-del-cb:checked').length;
    sa.checked = c === n && n > 0;
    sa.indeterminate = c > 0 && c < n;
  }

  function wireAccDeliverySelectAll() {
    var sa = document.getElementById('accDelSelectAll');
    if (!sa || sa.dataset.accDelSaBound) return;
    sa.dataset.accDelSaBound = '1';
    sa.addEventListener('change', function() {
      if (sa.disabled) return;
      document.querySelectorAll('#accDelList .acc-del-cb').forEach(function(cb) {
        cb.checked = sa.checked;
      });
    });
  }

  function wireAccDelListDelegation() {
    var list = document.getElementById('accDelList');
    if (!list || list.dataset.accDelDelegBound) return;
    list.dataset.accDelDelegBound = '1';
    list.addEventListener('change', function(e) {
      if (!e.target.classList.contains('acc-del-cb')) return;
      accSyncDelSelectAll();
    });
  }

  function accSyncBulkSourceButtons() {
    var sel = document.getElementById('accBulkSourceMethod');
    var v = sel && sel.value ? sel.value : 'file';
    document.querySelectorAll('.acc-bulk-src-btn').forEach(function(btn) {
      var k = btn.getAttribute('data-acc-source');
      var on = k === v;
      btn.classList.toggle('acc-bulk-src-btn--active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function accSyncBulkSourcePanels() {
    var sel = document.getElementById('accBulkSourceMethod');
    var v = sel && sel.value ? sel.value : 'file';
    var panels = {
      file: document.getElementById('accBulkPanelFile'),
      paste: document.getElementById('accBulkPanelPaste'),
      sheet: document.getElementById('accBulkPanelSheet'),
    };
    Object.keys(panels).forEach(function(k) {
      var el = panels[k];
      if (!el) return;
      el.classList.toggle('hidden', k !== v);
    });
    accSyncBulkSourceButtons();
  }
  window.accSyncBulkSourcePanels = accSyncBulkSourcePanels;

  function wireAccBulkSourceMethod() {
    var sel = document.getElementById('accBulkSourceMethod');
    if (!sel || sel.dataset.accBulkMethodBound) return;
    sel.dataset.accBulkMethodBound = '1';
    sel.addEventListener('change', accSyncBulkSourcePanels);
    document.querySelectorAll('.acc-bulk-src-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var k = btn.getAttribute('data-acc-source');
        if (!k || !sel || sel.value === k) return;
        sel.value = k;
        accSyncBulkSourcePanels();
      });
    });
  }

  function accBulkClearFileNameDisplay() {
    var el = document.getElementById('accBulkFileName');
    if (el) {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function accBulkUpdateFileNameDisplay() {
    var input = document.getElementById('accBulkFile');
    var el = document.getElementById('accBulkFileName');
    if (!el || !input) return;
    if (input.files && input.files[0]) {
      el.textContent = input.files[0].name;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function wireAccBulkDropzone() {
    var dz = document.getElementById('accBulkDropzone');
    var input = document.getElementById('accBulkFile');
    if (!dz || !input || dz.dataset.accBulkDzBound) return;
    dz.dataset.accBulkDzBound = '1';
    input.addEventListener('change', accBulkUpdateFileNameDisplay);
    ['dragenter', 'dragover'].forEach(function(ev) {
      dz.addEventListener(ev, function(e) {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('acc-bulk-dropzone-drag');
      });
    });
    dz.addEventListener('dragleave', function(e) {
      if (e.relatedTarget && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('acc-bulk-dropzone-drag');
    });
    dz.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('acc-bulk-dropzone-drag');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      try {
        var dt = new DataTransfer();
        dt.items.add(files[0]);
        input.files = dt.files;
      } catch (err) {}
      accBulkUpdateFileNameDisplay();
    });
  }

  window.accOpenBulk = function() {
    accCloseSidebarIfOpen();
    accClearBulkStaging();
    accBulkClearFileNameDisplay();
    fillCycleSelect('accBulkCycle', { defaultLatest: true, keepSelection: false });
    var method = document.getElementById('accBulkSourceMethod');
    if (method) method.value = 'file';
    var rk = document.getElementById('accBulkReviewKind');
    if (rk) rk.value = 'debt_receivable';
    accSyncBulkSourcePanels();
    accSyncBulkStep();
    var modal = document.getElementById('accBulkModal');
    var body = document.getElementById('accBulkModalBody');
    if (body) body.scrollTop = 0;
    modal.classList.remove('hidden');
    modal.classList.add('flex', 'flex-col');
  };
  window.accCloseBulk = function() {
    var modal = document.getElementById('accBulkModal');
    var body = document.getElementById('accBulkModalBody');
    if (body) body.scrollTop = 0;
    modal.classList.add('hidden');
    modal.classList.remove('flex', 'flex-col');
  };
  window.accSubmitBulk = function() {
    var f = document.getElementById('accBulkFile');
    if (!f || !f.files || !f.files[0]) {
      toast('اختر ملفاً', 'error');
      return;
    }
    var fd = new FormData();
    fd.append('file', f.files[0]);
    fetch('/api/accreditations/bulk-balance-parse-file', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.success) {
          toast(res.message || 'فشل', 'error');
          return;
        }
        accShowStagingFromPreview(res.preview || []);
        toast('راجع الصفوف ثم اضغط حفظ الكل', 'success');
      });
  };

  window.accSubmitBulkText = function() {
    var t = document.getElementById('accBulkPaste');
    var txt = t && t.value ? t.value.trim() : '';
    if (!txt) {
      toast('الصق النص أولاً', 'error');
      return;
    }
    apiCall('/api/accreditations/bulk-balance-parse-text', {
      method: 'POST',
      body: JSON.stringify({ csvText: txt }),
    }).then(function(res) {
      if (!res.success) {
        toast(res.message || 'فشل', 'error');
        return;
      }
      accShowStagingFromPreview(res.preview || []);
      toast('راجع الصفوف ثم اضغط حفظ الكل', 'success');
    });
  };

  window.accSubmitBulkSheetUrl = function() {
    var u = document.getElementById('accBulkSheetUrl');
    var sn = document.getElementById('accBulkSheetName');
    var url = u && u.value ? u.value.trim() : '';
    if (!url) {
      toast('أدخل رابط الجدول', 'error');
      return;
    }
    apiCall('/api/accreditations/bulk-balance-parse-sheet-url', {
      method: 'POST',
      body: JSON.stringify({
        sheetUrl: url,
        sheetName: sn && sn.value ? sn.value.trim() : null,
      }),
    }).then(function(res) {
      if (!res.success) {
        toast(res.message || 'فشل', 'error');
        return;
      }
      var extra = res.sheetTitleUsed ? ' — ' + res.sheetTitleUsed : '';
      accShowStagingFromPreview(res.preview || []);
      toast('تمت المعاينة' + extra, 'success');
    });
  };

  window.accOpenDelivery = function() {
    accCloseSidebarIfOpen();
    document.getElementById('accDeliveryModal').classList.remove('hidden');
    document.getElementById('accDeliveryModal').classList.add('flex', 'flex-col');
    fillCycleSelect('accDelCycle').then(function() {
      var sel = document.getElementById('accDelCycle');
      accRefreshDeliveryList(sel && sel.value ? sel.value : '');
    });
  };
  window.accCloseDelivery = function() {
    document.getElementById('accDeliveryModal').classList.add('hidden');
    document.getElementById('accDeliveryModal').classList.remove('flex', 'flex-col');
  };
  window.accSubmitDelivery = function() {
    var boxes = document.querySelectorAll('.acc-del-cb:checked');
    var ids = [];
    boxes.forEach(function(b) { ids.push(parseInt(b.value, 10)); });
    if (!ids.length) {
      toast('حدّد معتمداً واحداً على الأقل', 'error');
      return;
    }
    var cid = document.getElementById('accDelCycle').value || null;
    apiCall('/api/accreditations/delivery-settle', {
      method: 'POST',
      body: JSON.stringify({ cycleId: cid, accreditationIds: ids })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseDelivery();
        accLoad();
      }
    });
  };

  function accApplyUrlOpenParam() {
    var params = new URLSearchParams(window.location.search);
    var open = params.get('open');
    var addP = document.getElementById('accAddAmountPanel');
    var tfP = document.getElementById('accTransferPanel');
    if (!addP || !tfP) return;
    addP.classList.add('hidden');
    tfP.classList.add('hidden');
    if (open === 'add') {
      addP.classList.remove('hidden');
      tfP.classList.add('hidden');
      var ak = document.getElementById('accAmountKind');
      if (ak) ak.value = 'debt_receivable';
      accAmountKindChange();
      accSyncCurrencyUi();
      try {
        history.replaceState({}, '', window.location.pathname);
      } catch (err) {}
    } else if (open === 'transfer') {
      tfP.classList.remove('hidden');
      addP.classList.add('hidden');
      accTfTypeChange();
      try {
        history.replaceState({}, '', window.location.pathname);
      } catch (err2) {}
    }
  }

  function accPopulateDetail(id) {
    currentId = id;
    apiCall('/api/accreditations/' + id).then(function(res) {
      if (!res.success) return;
      var e = res.entity;
      currentPinned = !!e.pinned;
      accDetailBalanceReceivable = Number(e.balance_receivable) || 0;
      var titleEl = document.getElementById('accDetailTitle');
      if (titleEl) titleEl.textContent = e.name || '';
      var pinBtn = document.getElementById('accPinBtn');
      if (pinBtn) {
        pinBtn.textContent = currentPinned ? 'مثبت' : 'تثبيت';
        pinBtn.className =
          'inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-bold transition ' +
          (currentPinned
            ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-600'
            : 'border-amber-200 bg-amber-100 text-amber-900 hover:bg-amber-200');
      }
      accSyncCurrencyUi();
      var sp = document.getElementById('accSettlementPanel');
      var hideSettleAfterDefer = false;
      try {
        hideSettleAfterDefer = sessionStorage.getItem(accDeferSettlementStorageKey(id)) === '1';
      } catch (e) {}
      if (sp) {
        if (hideSettleAfterDefer) {
          sp.classList.add('hidden');
          sp.removeAttribute('data-max-settlement');
        } else if (res.settlementPending && (Number(res.maxSettlement) || 0) > 0.0001) {
          sp.classList.remove('hidden');
          var payV = Number(e.balance_payable) || 0;
          var recV = Number(e.balance_receivable) || 0;
          var mx = Math.round((Number(res.maxSettlement) || 0) * 100) / 100;
          sp.setAttribute('data-max-settlement', String(mx));
          var ex = document.getElementById('accSettlementExplain');
          if (ex) {
            ex.textContent =
              'دين لنا على المعتمد: ' +
              accFmtMoney(recV) +
              ' — علينا له: ' +
              accFmtMoney(payV) +
              '. يمكنك عند «إضافة مبلغ» من نوع علينا/لهم اختيار خصم من «دين لنا» من النافذة، أو تنفيذ تسوية متقابلة هنا (حتى ' +
              accFmtMoney(mx) +
              ').';
          }
          var maxEl = document.getElementById('accSettlementMax');
          if (maxEl) maxEl.textContent = accFmtMoney(mx);
          var sAmt = document.getElementById('accSettlementAmt');
          if (sAmt) {
            sAmt.setAttribute('max', String(mx));
            sAmt.value = '';
          }
        } else {
          sp.classList.add('hidden');
          sp.removeAttribute('data-max-settlement');
        }
      }
      document.getElementById('accLedger').innerHTML = (res.ledger || []).map(accLedgerRowHtml).join('') ||
        '<p class="py-6 text-center text-sm text-slate-400">لا توجد حركات</p>';
      document.getElementById('accAddAmountPanel').classList.add('hidden');
      document.getElementById('accTransferPanel').classList.add('hidden');
      Promise.all([
        apiCall('/api/sub-agencies/cycles/list'),
        apiCall('/api/funds/list?forAccreditationTransfer=1'),
        apiCall('/api/transfer-companies/list'),
      ]).then(function(results) {
        var c = results[0];
        var f = results[1];
        var t = results[2];
        var sel = document.getElementById('accCycle');
        if (sel) {
          sel.innerHTML = '<option value="">— دورة —</option>';
          ((c && c.cycles) || []).forEach(function(x) {
            sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
          });
        }
        var sf = document.getElementById('accTfFund');
        if (sf) {
          sf.innerHTML = '<option value="">— صندوق —</option>';
          ((f && f.funds) || []).forEach(function(x) {
            sf.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
          });
        }
        var sc = document.getElementById('accTfCompany');
        if (sc) {
          sc.innerHTML = '<option value="">— شركة —</option>';
          ((t && t.companies) || []).forEach(function(x) {
            sc.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
          });
        }
        accApplyUrlOpenParam();
        accCloseSidebarIfOpen();
      });
    });
  }

  window.accReloadDetail = function() {
    if (currentId) accPopulateDetail(currentId);
  };

  window.accOpen = function(id) {
    window.location.href = '/approvals/' + id;
  };

  function accFillListModalSelects() {
    return Promise.all([
      apiCall('/api/sub-agencies/cycles/list'),
      apiCall('/api/funds/list?forAccreditationTransfer=1'),
      apiCall('/api/transfer-companies/list'),
    ]).then(function(results) {
      var c = results[0];
      var f = results[1];
      var t = results[2];
      var sel = document.getElementById('accListCycle');
      if (sel) {
        sel.innerHTML = '<option value="">— دورة —</option>';
        ((c && c.cycles) || []).forEach(function(x) {
          sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
        });
      }
      var sf = document.getElementById('accListTfFund');
      if (sf) {
        sf.innerHTML = '<option value="">— صندوق —</option>';
        ((f && f.funds) || []).forEach(function(x) {
          sf.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
        });
      }
      var sc = document.getElementById('accListTfCompany');
      if (sc) {
        sc.innerHTML = '<option value="">— شركة —</option>';
        ((t && t.companies) || []).forEach(function(x) {
          sc.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
        });
      }
    });
  }

  window.accOpenShortcut = function(id, kind) {
    accCloseSidebarIfOpen();
    accShortcutModalId = id;
    var k = kind === 'transfer' ? 'transfer' : 'add';
    apiCall('/api/accreditations/' + id).then(function(res) {
      if (!res.success || !res.entity) {
        toast(res.message || 'تعذر تحميل المعتمد', 'error');
        accShortcutModalId = null;
        return;
      }
      var name = res.entity.name || '';
      accListModalReceivable = Number(res.entity.balance_receivable) || 0;
      var sub = document.getElementById(k === 'add' ? 'accListAddAmountModalSubtitle' : 'accListTransferModalSubtitle');
      if (sub) sub.textContent = name;
      accFillListModalSelects().then(function() {
        accSyncCurrencyUi();
        if (k === 'add') {
          var ak = document.getElementById('accListAddAmountKind');
          if (ak) ak.value = 'debt_receivable';
          if (typeof window.accListAmountKindChange === 'function') window.accListAmountKindChange();
          var amtIn = document.getElementById('accListAmt');
          if (amtIn) amtIn.value = '';
          var dp = document.getElementById('accListDiscountPct');
          if (dp) dp.value = '';
          var mAdd = document.getElementById('accListAddAmountModal');
          if (mAdd) {
            mAdd.classList.remove('hidden');
            mAdd.classList.add('flex');
          }
        } else {
          var tf = document.getElementById('accListTfType');
          if (tf) tf.value = 'manual';
          if (typeof window.accListTfTypeChange === 'function') window.accListTfTypeChange();
          var tfa = document.getElementById('accListTfAmt');
          if (tfa) tfa.value = '';
          var mTf = document.getElementById('accListTransferModal');
          if (mTf) {
            mTf.classList.remove('hidden');
            mTf.classList.add('flex');
          }
        }
      });
    });
  };

  window.accCloseListAddAmountModal = function() {
    accShortcutModalId = null;
    var m = document.getElementById('accListAddAmountModal');
    if (m) {
      m.classList.add('hidden');
      m.classList.remove('flex');
    }
  };

  window.accCloseListTransferModal = function() {
    accShortcutModalId = null;
    var m = document.getElementById('accListTransferModal');
    if (m) {
      m.classList.add('hidden');
      m.classList.remove('flex');
    }
  };

  window.accListAmountKindChange = function() {
    var ak = document.getElementById('accListAddAmountKind');
    var wrap = document.getElementById('accListDiscountWrap');
    var lbl = document.getElementById('accListDiscountLabel');
    if (!ak || !wrap) return;
    var v = ak.value;
    if (v === 'debt_receivable') {
      wrap.classList.add('hidden');
      var dpin = document.getElementById('accListDiscountPct');
      if (dpin) dpin.value = '';
    } else {
      wrap.classList.remove('hidden');
      if (lbl) {
        lbl.textContent =
          v === 'debt_payable_no_fund'
            ? 'خصم % (اختياري — لهم: صافي في مطلوب دفع فقط؛ الخصم كربح؛ بدون صندوق رئيسي)'
            : 'خصم % (اختياري — علينا: صافي في الصندوق ومطلوب دفع؛ الخصم كربح)';
      }
    }
  };

  window.accListTfTypeChange = function() {
    var t = document.getElementById('accListTfType');
    if (!t) return;
    var v = t.value;
    var ff = document.getElementById('accListTfFund');
    if (ff) ff.classList.toggle('hidden', v !== 'fund');
    var cc = document.getElementById('accListTfCompany');
    if (cc) cc.classList.toggle('hidden', v !== 'company');
    var sh = document.getElementById('accListTfShipHint');
    if (sh) sh.classList.toggle('hidden', v !== 'shipping');
    var mw = document.getElementById('accListTfModeWrap');
    if (mw) mw.classList.toggle('hidden', v !== 'fund' && v !== 'company');
    if (v === 'fund' || v === 'company') {
      var mainR = document.getElementById('accListTfModeMainFund');
      if (mainR) mainR.checked = true;
    }
  };

  window.accListSubmitAmount = function() {
    var id = accShortcutModalId;
    if (!id) return;
    var kind = document.getElementById('accListAddAmountKind')
      ? document.getElementById('accListAddAmountKind').value
      : 'debt_receivable';
    var body = {
      amountKind: kind,
      amount: document.getElementById('accListAmt').value,
      cycleId: document.getElementById('accListCycle').value || null,
    };
    var dp = document.getElementById('accListDiscountPct');
    if (kind !== 'debt_receivable' && dp && dp.value !== '' && dp.value != null) body.discountPct = dp.value;
    var rec = accListModalReceivable;
    if (accNeedsReceivableOffsetModal(kind, rec, body.amount)) {
      accOpenReceivableOffsetModal({
        rec: rec,
        amount: parseFloat(String(body.amount).replace(/,/g, '')),
        baseBody: body,
        url: '/api/accreditations/' + id + '/add-amount',
        entityId: id,
        onDone: function(res) {
          toast(res.message || '', res.success ? 'success' : 'error');
          if (res.success) {
            accCloseListAddAmountModal();
            accLoad();
          }
        },
      });
      return;
    }
    apiCall('/api/accreditations/' + id + '/add-amount', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseListAddAmountModal();
        accLoad();
      }
    });
  };

  window.accListSubmitTransfer = function() {
    var id = accShortcutModalId;
    if (!id) return;
    var t = document.getElementById('accListTfType').value;
    var body = {
      transferType: t === 'fund' ? 'fund' : t === 'company' ? 'company' : 'manual',
      amount: document.getElementById('accListTfAmt').value,
      fundId: document.getElementById('accListTfFund').value,
      companyId: document.getElementById('accListTfCompany').value,
    };
    if (t === 'fund' || t === 'company') {
      var rm = document.querySelector('input[name="accListTfMode"]:checked');
      body.transferMode = rm ? rm.value : 'main_fund';
    }
    apiCall('/api/accreditations/' + id + '/transfer', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
      var msg = res.message || '';
      if (!res.success && res.code === 'INSUFFICIENT_MAIN') {
        msg = msg || 'رصيد الصندوق الرئيسي غير كافٍ.';
      }
      toast(msg, res.success ? 'success' : 'error');
      if (res.success) {
        accCloseListTransferModal();
        accLoad();
      }
    });
  };
  window.accCloseDetail = function() {
    window.location.href = '/approvals';
  };

  window.accAmountKindChange = function() {
    var ak = document.getElementById('accAmountKind');
    var wrap = document.getElementById('accDiscountWrap');
    var lbl = document.getElementById('accDiscountLabel');
    if (!ak || !wrap) return;
    var v = ak.value;
    if (v === 'debt_receivable') {
      wrap.classList.add('hidden');
      var dpin = document.getElementById('accDiscountPct');
      if (dpin) dpin.value = '';
    } else {
      wrap.classList.remove('hidden');
      if (lbl) {
        lbl.textContent =
          v === 'debt_payable_no_fund'
            ? 'خصم % (اختياري — لهم: صافي في مطلوب دفع فقط؛ الخصم كربح؛ بدون صندوق رئيسي)'
            : 'خصم % (اختياري — علينا: صافي في الصندوق ومطلوب دفع؛ الخصم كربح)';
      }
    }
  };

  window.accShowAddAmount = function() {
    document.getElementById('accAddAmountPanel').classList.toggle('hidden');
    var ak = document.getElementById('accAmountKind');
    if (ak) ak.value = 'debt_receivable';
    accAmountKindChange();
    accSyncCurrencyUi();
  };
  window.accShowTransfer = function() {
    document.getElementById('accTransferPanel').classList.toggle('hidden');
    accTfTypeChange();
  };
  window.accTfTypeChange = function() {
    var t = document.getElementById('accTfType').value;
    document.getElementById('accTfFund').classList.toggle('hidden', t !== 'fund');
    document.getElementById('accTfCompany').classList.toggle('hidden', t !== 'company');
    document.getElementById('accTfShipHint').classList.toggle('hidden', t !== 'shipping');
    var mw = document.getElementById('accTfModeWrap');
    if (mw) mw.classList.toggle('hidden', t !== 'fund' && t !== 'company');
    if (t === 'fund' || t === 'company') {
      var mainR = document.getElementById('accTfModeMainFund');
      if (mainR) mainR.checked = true;
    }
  };

  window.accSubmitSettlement = function() {
    if (!currentId) return;
    var inp = document.getElementById('accSettlementAmt');
    var sp = document.getElementById('accSettlementPanel');
    var raw = inp && inp.value !== '' ? parseFloat(inp.value) : NaN;
    var amt = Math.round(raw * 100) / 100;
    var mxAttr = sp && sp.getAttribute('data-max-settlement');
    var mx = mxAttr != null && mxAttr !== '' ? parseFloat(mxAttr) : NaN;
    if (!inp || isNaN(amt) || amt <= 0) {
      toast('أدخل مبلغ تسوية صالحاً (رقمين عشريين كحد أقصى).', 'error');
      return;
    }
    if (!isNaN(mx) && amt > mx + 0.001) {
      toast('المبلغ يتجاوز الحد الأقصى للتسوية (' + accFmtMoney(mx) + ').', 'error');
      return;
    }
    var cyc = document.getElementById('accCycle');
    apiCall('/api/accreditations/' + currentId + '/settle-receivable-payable', {
      method: 'POST',
      body: JSON.stringify({
        amount: amt,
        cycleId: cyc && cyc.value ? cyc.value : null,
      }),
    }).then(function(r) {
      toast(r.message || '', r.success ? 'success' : 'error');
      if (r.success) {
        try {
          if (currentId) sessionStorage.removeItem(accDeferSettlementStorageKey(currentId));
        } catch (e) {}
        accReloadDetail();
      }
    });
  };

  window.accSubmitAmount = function() {
    if (!currentId) return;
    var kind = document.getElementById('accAmountKind') ? document.getElementById('accAmountKind').value : 'debt_receivable';
    var body = {
      amountKind: kind,
      amount: document.getElementById('accAmt').value,
      cycleId: document.getElementById('accCycle').value || null,
    };
    var dp = document.getElementById('accDiscountPct');
    if (kind !== 'debt_receivable' && dp && dp.value !== '' && dp.value != null) body.discountPct = dp.value;
    var rec = accDetailBalanceReceivable;
    if (accNeedsReceivableOffsetModal(kind, rec, body.amount)) {
      accOpenReceivableOffsetModal({
        rec: rec,
        amount: parseFloat(String(body.amount).replace(/,/g, '')),
        baseBody: body,
        url: '/api/accreditations/' + currentId + '/add-amount',
        entityId: currentId,
        onDone: function(res) {
          toast(res.message || '', res.success ? 'success' : 'error');
          if (res.success) accReloadDetail();
        },
      });
      return;
    }
    apiCall('/api/accreditations/' + currentId + '/add-amount', {
      method: 'POST',
      body: JSON.stringify(body)
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) accReloadDetail();
    });
  };

  window.accSubmitTransfer = function() {
    if (!currentId) return;
    var t = document.getElementById('accTfType').value;
    var body = {
      transferType: t === 'fund' ? 'fund' : t === 'company' ? 'company' : 'manual',
      amount: document.getElementById('accTfAmt').value,
      fundId: document.getElementById('accTfFund').value,
      companyId: document.getElementById('accTfCompany').value
    };
    if (t === 'fund' || t === 'company') {
      var rm = document.querySelector('input[name="accTfMode"]:checked');
      body.transferMode = rm ? rm.value : 'main_fund';
    }
    apiCall('/api/accreditations/' + currentId + '/transfer', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
      var msg = res.message || '';
      if (!res.success && res.code === 'INSUFFICIENT_MAIN') {
        msg = msg || 'رصيد الصندوق الرئيسي غير كافٍ.';
      }
      toast(msg, res.success ? 'success' : 'error');
      if (res.success) accReloadDetail();
    });
  };

  window.accTogglePin = function() {
    if (!currentId) return;
    apiCall('/api/accreditations/' + currentId + '/pin', {
      method: 'POST',
      body: JSON.stringify({ pinned: !currentPinned })
    }).then(function(res) {
      if (res.success) {
        currentPinned = !currentPinned;
        if (document.getElementById('accCards')) accLoad();
        else accReloadDetail();
      }
    });
  };

  document.getElementById('accAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    apiCall('/api/accreditations/add', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('accName').value,
        code: document.getElementById('accCode').value
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseAdd();
        accLoad();
      }
    });
  });

  function wireAccBulkReviewKind() {
    var rk = document.getElementById('accBulkReviewKind');
    if (!rk || rk.dataset.accBulkBound) return;
    rk.dataset.accBulkBound = '1';
    rk.addEventListener('change', function() {
      accApplyBulkReviewKindToItems();
      accRenderStagingTable();
    });
  }

  function wireAccDeliveryCycle() {
    var sel = document.getElementById('accDelCycle');
    if (!sel || sel.dataset.accDelBound) return;
    sel.dataset.accDelBound = '1';
    sel.addEventListener('change', function() {
      accRefreshDeliveryList(sel.value || '');
    });
  }

  var accNavIds = [];
  var accNavIndex = -1;

  function accNavUpdateState() {
    var prevBtn = document.getElementById('accNavPrev');
    var nextBtn = document.getElementById('accNavNext');
    if (!prevBtn || !nextBtn) return;
    var hasPrev = accNavIndex > 0;
    var hasNext = accNavIndex >= 0 && accNavIndex < accNavIds.length - 1;
    prevBtn.disabled = !hasPrev;
    nextBtn.disabled = !hasNext;
  }

  function accNavGo(delta) {
    if (accNavIndex < 0 || !accNavIds.length) return;
    var n = accNavIndex + delta;
    if (n < 0 || n >= accNavIds.length) return;
    window.location.href = '/approvals/' + accNavIds[n];
  }

  function initAccProfileNav() {
    var page = document.getElementById('accDetailPage');
    var zone = document.querySelector('.acc-detail-page');
    var prevBtn = document.getElementById('accNavPrev');
    var nextBtn = document.getElementById('accNavNext');
    if (!page || !page.dataset.accreditationId || !zone || !prevBtn || !nextBtn) return;

    var cur = parseInt(page.dataset.accreditationId, 10);
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    apiCall('/api/accreditations/list').then(function(res) {
      if (!res.success || !res.list || !res.list.length) return;
      accNavIds = res.list.map(function(a) {
        return a.id;
      });
      accNavIndex = accNavIds.indexOf(cur);
      accNavUpdateState();
    });

    prevBtn.addEventListener('click', function() {
      accNavGo(-1);
    });
    nextBtn.addEventListener('click', function() {
      accNavGo(1);
    });

    var touchStartX = 0;
    var touchStartY = 0;
    var touchDeny = false;

    zone.addEventListener(
      'touchstart',
      function(e) {
        if (window.innerWidth >= 1024) return;
        var el = e.target;
        if (el.closest && el.closest('input, textarea, select, button, a, label, #accLedger')) {
          touchDeny = true;
          return;
        }
        touchDeny = false;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      },
      { passive: true }
    );

    zone.addEventListener(
      'touchend',
      function(e) {
        if (window.innerWidth >= 1024) return;
        if (touchDeny) return;
        if (!e.changedTouches || !e.changedTouches.length) return;
        var dx = e.changedTouches[0].clientX - touchStartX;
        var dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx > 0) accNavGo(-1);
        else accNavGo(1);
      },
      { passive: true }
    );
  }

  document.addEventListener('DOMContentLoaded', function() {
    wireAccReceivableOffsetModal();
    var accDetailPg = document.getElementById('accDetailPage');
    if (accDetailPg && accDetailPg.dataset.accreditationId) {
      initAccProfileNav();
      fetch('/settings/currency', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success && d.symbol !== undefined) window.currencySymbol = d.symbol;
          accSyncCurrencyUi();
        })
        .catch(function() {
          accSyncCurrencyUi();
        })
        .finally(function() {
          accPopulateDetail(parseInt(accDetailPg.dataset.accreditationId, 10));
        });
      accAmountKindChange();
      return;
    }
    wireAccBulkStagingDelegation();
    wireAccBulkSourceMethod();
    wireAccBulkDropzone();
    wireAccBulkReviewKind();
    wireAccDeliveryCycle();
    wireAccDeliverySelectAll();
    wireAccDelListDelegation();
    accSyncBulkSourcePanels();
    fetch('/settings/currency', { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success && d.symbol !== undefined) window.currencySymbol = d.symbol;
        accSyncCurrencyUi();
        if (accBulkStagingItems.length) accRenderStagingTable();
      })
      .catch(function() {
        accSyncCurrencyUi();
      })
      .finally(function() {
        accLoad();
      });
    accAmountKindChange();
  });
})();
