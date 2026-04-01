(function() {
  var tcLedgerById = {};
  var tcLedgerModalRow = null;
  var tcCardsOrderedList = [];
  var tcDnDDraggingId = null;
  var TC_CARD_ORDER_STORAGE_KEY = 'erp_transfer_company_card_order_v1';

  var tcCardBarColors = [
    'bg-violet-500',
    'bg-indigo-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-sky-500',
    'bg-teal-500',
    'bg-orange-500',
  ];

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

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
  var defaults = [];
  var tcCurrentId = null;

  function isTcDetailPage() {
    return !!document.getElementById('tcDetailPage');
  }

  function tcGetSavedCardOrderIds() {
    try {
      var raw = localStorage.getItem(TC_CARD_ORDER_STORAGE_KEY);
      if (!raw) return [];
      var o = JSON.parse(raw);
      return Array.isArray(o) ? o.map(function(x) { return parseInt(x, 10); }).filter(function(n) { return !isNaN(n); }) : [];
    } catch (e) {
      return [];
    }
  }

  function tcSaveCardOrderIds(ids) {
    try {
      localStorage.setItem(TC_CARD_ORDER_STORAGE_KEY, JSON.stringify(ids));
    } catch (e) {}
  }

  function tcSortListBySavedOrder(list) {
    if (!list || !list.length) return [];
    var order = tcGetSavedCardOrderIds();
    if (!order.length) return list.slice();
    var map = {};
    list.forEach(function(a) {
      map[a.id] = a;
    });
    var out = [];
    var seen = {};
    order.forEach(function(id) {
      if (map[id]) {
        out.push(map[id]);
        seen[id] = true;
      }
    });
    list.forEach(function(a) {
      if (!seen[a.id]) out.push(a);
    });
    return out;
  }

  function tcReorderCardsById(fromId, toId, insertBefore) {
    var fromIdx = tcCardsOrderedList.findIndex(function(a) { return a.id === fromId; });
    var toIdx = tcCardsOrderedList.findIndex(function(a) { return a.id === toId; });
    if (fromIdx < 0 || toIdx < 0 || fromId === toId) return;
    var item = tcCardsOrderedList.splice(fromIdx, 1)[0];
    toIdx = tcCardsOrderedList.findIndex(function(a) { return a.id === toId; });
    if (toIdx < 0) {
      tcCardsOrderedList.push(item);
    } else if (insertBefore) {
      tcCardsOrderedList.splice(toIdx, 0, item);
    } else {
      tcCardsOrderedList.splice(toIdx + 1, 0, item);
    }
    tcSaveCardOrderIds(tcCardsOrderedList.map(function(a) { return a.id; }));
    tcRenderCards();
  }

  function tcBalanceTextColor(amount) {
    var v = Number(amount) || 0;
    if (v > 0.0001) return '#047857';
    if (v < -0.0001) return '#b91c1c';
    return '#64748b';
  }

  function tcFmtAmount(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function tcEmptyStateHtml(kind, msg) {
    if (kind === 'loading') {
      return (
        '<div class="col-span-full acc-approvals-empty flex flex-col items-center gap-2 py-12 text-center text-slate-400">' +
        '<i class="fas fa-spinner fa-spin text-3xl text-violet-400" aria-hidden="true"></i>' +
        '<span class="text-sm font-medium">جاري التحميل...</span></div>'
      );
    }
    if (kind === 'error') {
      return (
        '<div class="col-span-full acc-approvals-empty py-12 text-center text-slate-600">' +
        '<i class="fas fa-circle-exclamation text-4xl text-red-400" aria-hidden="true"></i>' +
        '<p class="mt-2 text-sm font-medium text-red-600">' + escHtml(msg || 'حدث خطأ') + '</p></div>'
      );
    }
    return (
      '<div class="col-span-full acc-approvals-empty flex flex-col items-center gap-2 py-14 text-center text-slate-500">' +
      '<span class="inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-slate-100 text-slate-300">' +
      '<i class="fas fa-money-bill-wave text-4xl" aria-hidden="true"></i></span>' +
      '<p class="font-medium text-slate-600">لا توجد شركات تحويل</p>' +
      '<p class="max-w-sm text-xs leading-relaxed text-slate-400">أضف شركة من زر «إضافة شركة».</p></div>'
    );
  }

  window.tcGoToCompany = function(id) {
    if (!id) return;
    window.location.href = '/transfer-companies/' + encodeURIComponent(id);
  };

  /** من بطاقة القائمة: فتح الملف مع نافذة جاهزة */
  window.tcGoToCompanyShortcut = function(id, action) {
    if (!id) return;
    var q = action === 'receivable' || action === 'return' ? '?open=' + encodeURIComponent(action === 'receivable' ? 'receivable' : 'return') : '';
    window.location.href = '/transfer-companies/' + encodeURIComponent(id) + q;
  };

  function tcCardHtml(c, idx) {
    var bal = Number(c.balance_amount) || 0;
    var cur = c.balance_currency || 'USD';
    var balStr = tcFmtAmount(bal) + ' ' + cur;
    var payOpen = Number(c.open_payables_usd) || 0;
    var recvForUs = Math.max(0, bal);
    var textColor = tcBalanceTextColor(bal);
    var bar = tcCardBarColors[idx % tcCardBarColors.length];
    var types = (c.transfer_types || []).join('، ');
    if (!types) types = '—';
    var loc = c.country || '';
    if (c.region_syria && String(c.country || '').indexOf('سوريا') !== -1) {
      loc = (loc ? loc + ' · ' : '') + c.region_syria;
    }
    return (
      '<div class="tc-list-card group relative flex flex-row-reverse overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md transition-all hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-lg" data-tc-id="' +
      c.id +
      '">' +
      '<div class="tc-card-drag-handle flex w-9 shrink-0 cursor-grab select-none items-center justify-center border-l border-slate-100 bg-slate-50/90 text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing" draggable="true" title="اسحب لترتيب البطاقات" aria-label="ترتيب البطاقات" role="button" tabindex="0" onclick="event.stopPropagation();">' +
      '<i class="fas fa-grip-vertical pointer-events-none text-sm" aria-hidden="true"></i></div>' +
      '<div class="min-w-0 flex-1 cursor-pointer" onclick="tcGoToCompany(' +
      c.id +
      ')">' +
      '<div class="' +
      bar +
      ' h-1 w-full"></div>' +
      '<div class="relative p-4">' +
      '<div class="flex items-start justify-between gap-2">' +
      '<h5 class="min-w-0 flex-1 text-base font-bold leading-snug text-slate-900 sm:text-[1.05rem]">' +
      escHtml(c.name || '') +
      '</h5>' +
      '<button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]" ' +
      'onclick="event.stopPropagation(); tcDownloadLedgerPdfFor(' +
      c.id +
      ')" title="تنزيل PDF"><i class="fas fa-file-pdf text-red-500"></i></button>' +
      '</div>' +
      '<p class="mt-2 font-mono text-[11px] text-slate-500 sm:text-xs">' +
      escHtml(loc || '—') +
      '</p>' +
      '<div class="mt-3 space-y-2 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50 to-white px-3 py-2.5">' +
      '<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] sm:text-xs">' +
      '<span class="font-semibold text-slate-600">أنواع التحويل</span>' +
      '</div>' +
      '<p class="break-words text-[11px] leading-relaxed text-slate-600">' + escHtml(types) + '</p>' +
      '<div class="border-t border-slate-200/80 pt-2">' +
      '<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] sm:text-xs">' +
      '<span class="font-semibold text-emerald-700">لنا <span class="tabular-nums font-bold">' +
      escHtml(tcFmtAmount(recvForUs) + ' ' + cur) +
      '</span></span>' +
      '<span class="font-semibold text-rose-600">علينا <span class="tabular-nums font-bold">' +
      escHtml(tcFmtAmount(payOpen) + ' USD') +
      '</span></span>' +
      '</div>' +
      '<div class="mt-2 flex items-end justify-between gap-2 border-t border-slate-200/80 pt-2">' +
      '<span class="text-xs font-semibold text-slate-500">رصيد الشركة</span>' +
      '<span class="text-lg font-bold tabular-nums" style="color:' +
      textColor +
      '">' +
      escHtml(balStr) +
      '</span></div></div></div>' +
      '<div class="tc-card-shortcuts mt-3 flex gap-2 border-t border-slate-100 pt-3" onclick="event.stopPropagation()">' +
      '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-2 py-2 text-[11px] font-bold text-white shadow-md shadow-violet-600/20 transition hover:bg-violet-700 active:scale-[0.99] sm:text-xs" onclick="tcGoToCompanyShortcut(' +
      c.id +
      ',\'receivable\')"><i class="fas fa-hand-holding-dollar text-[0.7rem] shrink-0"></i>دين لنا</button>' +
      '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-2 py-2 text-[11px] font-bold text-white shadow-md shadow-emerald-600/20 transition hover:bg-emerald-700 active:scale-[0.99] sm:text-xs" onclick="tcGoToCompanyShortcut(' +
      c.id +
      ',\'return\')"><i class="fas fa-rotate-left text-[0.7rem] shrink-0"></i>مرتجع</button>' +
      '</div></div></div></div>'
    );
  }

  function tcRenderCards() {
    var box = document.getElementById('tcCards');
    if (!box) return;
    var inp = document.getElementById('tcCardsSearch');
    var q = inp && inp.value != null ? String(inp.value).trim().toLowerCase() : '';
    if (!tcCardsOrderedList.length) {
      box.innerHTML = tcEmptyStateHtml('empty');
      return;
    }
    var filtered = tcCardsOrderedList;
    if (q) {
      filtered = tcCardsOrderedList.filter(function(c) {
        var name = (c.name || '').toLowerCase();
        var country = (c.country || '').toLowerCase();
        var reg = (c.region_syria || '').toLowerCase();
        return name.indexOf(q) !== -1 || country.indexOf(q) !== -1 || reg.indexOf(q) !== -1;
      });
    }
    if (!filtered.length) {
      box.innerHTML =
        '<div class="col-span-full acc-approvals-empty rounded-2xl border border-slate-200 bg-white py-14 text-center text-slate-500">' +
        '<i class="fas fa-search mb-2 text-3xl text-slate-300" aria-hidden="true"></i>' +
        '<p class="text-sm font-medium text-slate-600">لا توجد نتائج للبحث</p>' +
        '<p class="mx-auto mt-1 max-w-sm text-xs text-slate-400">جرّب اسماً أو دولة أخرى، أو امسح حقل البحث.</p></div>';
      return;
    }
    box.innerHTML = filtered
      .map(function(c, idx) {
        return tcCardHtml(c, idx);
      })
      .join('');
  }

  function wireTcCardsSearch() {
    var inp = document.getElementById('tcCardsSearch');
    if (!inp || inp.dataset.tcSearchBound) return;
    inp.dataset.tcSearchBound = '1';
    inp.addEventListener('input', function() {
      tcRenderCards();
    });
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        inp.value = '';
        tcRenderCards();
      }
    });
  }

  function wireTcCardsDnD() {
    var box = document.getElementById('tcCards');
    if (!box || box.dataset.tcDndBound) return;
    box.dataset.tcDndBound = '1';
    var dragOverCard = null;
    box.addEventListener('dragstart', function(e) {
      var h = e.target.closest('.tc-card-drag-handle');
      if (!h) return;
      var card = h.closest('.tc-list-card');
      if (!card) return;
      e.stopPropagation();
      tcDnDDraggingId = parseInt(card.getAttribute('data-tc-id'), 10);
      if (isNaN(tcDnDDraggingId)) tcDnDDraggingId = null;
      else {
        e.dataTransfer.setData('text/plain', String(tcDnDDraggingId));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('opacity-60');
      }
    });
    box.addEventListener('dragend', function(e) {
      var h = e.target.closest('.tc-card-drag-handle');
      if (!h) return;
      tcDnDDraggingId = null;
      box.querySelectorAll('.tc-list-card').forEach(function(c) {
        c.classList.remove('opacity-60', 'ring-2', 'ring-violet-400', 'ring-inset');
      });
      dragOverCard = null;
    });
    box.addEventListener('dragover', function(e) {
      var card = e.target.closest('.tc-list-card');
      if (!card || tcDnDDraggingId == null) return;
      var tid = parseInt(card.getAttribute('data-tc-id'), 10);
      if (isNaN(tid) || tid === tcDnDDraggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOverCard && dragOverCard !== card) {
        dragOverCard.classList.remove('ring-2', 'ring-violet-400', 'ring-inset');
      }
      dragOverCard = card;
      card.classList.add('ring-2', 'ring-violet-400', 'ring-inset');
    });
    box.addEventListener('drop', function(e) {
      e.preventDefault();
      box.querySelectorAll('.tc-list-card').forEach(function(c) {
        c.classList.remove('ring-2', 'ring-violet-400', 'ring-inset');
      });
      dragOverCard = null;
      var targetCard = e.target.closest('.tc-list-card');
      if (!targetCard || tcDnDDraggingId == null) return;
      var toId = parseInt(targetCard.getAttribute('data-tc-id'), 10);
      var fromId = tcDnDDraggingId;
      if (isNaN(toId) || fromId === toId) return;
      var rect = targetCard.getBoundingClientRect();
      var insertBefore = e.clientY < rect.top + rect.height / 2;
      tcReorderCardsById(fromId, toId, insertBefore);
    });
  }

  window.tcDownloadLedgerPdfFor = function(id) {
    if (!id) return;
    window.open('/api/reports/pdf/transfer-company-ledger?companyId=' + encodeURIComponent(id), '_blank');
  };

  function loadList() {
    var box = document.getElementById('tcCards');
    if (!box) return;
    wireTcCardsSearch();
    wireTcCardsDnD();
    box.innerHTML = tcEmptyStateHtml('loading');
    apiCall('/api/transfer-companies/list').then(function(res) {
      defaults = res.defaultTransferTypes || [];
      if (!res.success) {
        box.innerHTML = tcEmptyStateHtml('error', res.message || '');
        return;
      }
      var list = res.companies || [];
      if (list.length === 0) {
        tcCardsOrderedList = [];
        box.innerHTML = tcEmptyStateHtml('empty');
        return;
      }
      tcCardsOrderedList = tcSortListBySavedOrder(list);
      tcSaveCardOrderIds(tcCardsOrderedList.map(function(a) { return a.id; }));
      tcRenderCards();
    });
  }

  window.tcOpenAdd = function() {
    if (typeof window.closeSidebar === 'function') window.closeSidebar();
    var sel = document.getElementById('tcCountry');
    if (sel && window.FUNDS_COUNTRIES) {
      sel.innerHTML = window.FUNDS_COUNTRIES.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
    }
    var wrap = document.getElementById('tcTypesWrap');
    if (wrap && defaults.length) {
      wrap.innerHTML = defaults.map(function(t) {
        return '<label class="inline-flex items-center gap-1 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1"><input type="checkbox" class="tcTypeCb" value="' + escHtml(t) + '"> ' + escHtml(t) + '</label>';
      }).join('');
    }
    document.getElementById('tcAddModal').classList.remove('hidden');
    document.getElementById('tcAddModal').classList.add('flex');
  };
  window.tcCloseAdd = function() {
    document.getElementById('tcAddModal').classList.add('hidden');
    document.getElementById('tcAddModal').classList.remove('flex');
  };

  function tcFillReturnFunds() {
    var sel = document.getElementById('tcReturnFundId');
    if (!sel) return;
    apiCall('/api/funds/list').then(function(r) {
      sel.innerHTML = '<option value="">— صندوق —</option>';
      (r.funds || []).forEach(function(f) {
        sel.innerHTML += '<option value="' + f.id + '">' + (f.name || f.id) + '</option>';
      });
    });
  }
  function tcToggleReturnFund() {
    var d = document.getElementById('tcReturnDisposition');
    var wrap = document.getElementById('tcReturnFundWrap');
    var sel = document.getElementById('tcReturnFundId');
    if (!d || !sel) return;
    if (d.value === 'transfer_to_fund') {
      if (wrap) wrap.classList.remove('hidden');
      tcFillReturnFunds();
    } else {
      if (wrap) wrap.classList.add('hidden');
    }
  }

  function tcModalShow(el) {
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    if (typeof window.closeSidebar === 'function') window.closeSidebar();
  }
  function tcModalHide(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
  }

  window.tcOpenReceivableModal = function() {
    tcModalShow(document.getElementById('tcReceivableModal'));
  };
  window.tcCloseReceivableModal = function() {
    tcModalHide(document.getElementById('tcReceivableModal'));
  };
  window.tcOpenReturnModal = function() {
    tcToggleReturnFund();
    tcModalShow(document.getElementById('tcReturnModal'));
  };
  window.tcCloseReturnModal = function() {
    tcModalHide(document.getElementById('tcReturnModal'));
  };

  function tryOpenTcModalFromQuery() {
    if (!isTcDetailPage()) return;
    try {
      var u = new URL(window.location.href);
      var q = u.searchParams.get('open');
      if (q === 'receivable' || q === 'return') {
        if (q === 'receivable') tcOpenReceivableModal();
        else tcOpenReturnModal();
        u.searchParams.delete('open');
        var qs = u.searchParams.toString();
        window.history.replaceState({}, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
      }
    } catch (e) {}
  }

  function tcSetHeaderTitle(name) {
    var t = name || 'ملف شركة تحويل';
    try {
      document.title = 'LorkERP — ' + t;
    } catch (e) {}
    var mh = document.getElementById('mobileHeaderTitle');
    if (mh) mh.textContent = t;
  }

  function applyTcDetailResponse(res) {
    if (!res.success) {
      toast(res.message || 'فشل التحميل', 'error');
      return;
    }
    var c = res.company;
    tcSetHeaderTitle(c.name || 'شركة تحويل');
    var titleEl = document.getElementById('tcDetailTitle');
    if (titleEl) titleEl.textContent = c.name || '—';

    var loc = c.country || '—';
    if (c.region_syria && String(c.country || '').indexOf('سوريا') !== -1) {
      loc = (c.country || '') + (c.region_syria ? ' · ' + c.region_syria : '');
    }
    var metaLoc = document.getElementById('tcDetailMetaLocation');
    if (metaLoc) metaLoc.textContent = loc || '—';

    var typesEl = document.getElementById('tcDetailTypes');
    if (typesEl) {
      var types = c.transfer_types || [];
      if (types.length) {
        typesEl.innerHTML = types
          .map(function(t) {
            return (
              '<span class="inline-flex items-center rounded-lg border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-900">' +
              escHtml(t) +
              '</span>'
            );
          })
          .join('');
      } else {
        typesEl.innerHTML = '<span class="text-sm text-slate-500">—</span>';
      }
    }

    var payTc = res.openPayablesUsd != null ? res.openPayablesUsd : 0;
    var led = res.ledger || [];
    var hasOpening = led.some(function(l) {
      return /رصيد افتتاحي/.test(l.notes || '') || (l.labelAr && /رصيد افتتاحي/.test(l.labelAr));
    });
    var hasReturn = led.some(function(l) {
      return /مرتجع|return/i.test(l.notes || '') || (l.labelAr && /مرتجع/.test(l.labelAr));
    });
    var hideBal = payTc > 0.0001 && hasOpening && hasReturn;
    var payEl = document.getElementById('tcDetailPayables');
    if (payEl) {
      if (payTc > 0.0001) {
        payEl.classList.remove('hidden');
        payEl.textContent =
          'دين علينا تجاه هذه الشركة: ' +
          payTc.toLocaleString('en-US', { minimumFractionDigits: 2 }) +
          ' USD';
      } else {
        payEl.classList.add('hidden');
        payEl.textContent = '';
      }
    }
    var shell = document.getElementById('tcDetailBalanceShell');
    var balEl = document.getElementById('tcDetailBal');
    if (balEl) {
      if (hideBal) {
        if (shell) shell.classList.add('hidden');
        balEl.textContent = '';
      } else {
        if (shell) shell.classList.remove('hidden');
        balEl.textContent =
          (c.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) +
          ' ' +
          (c.balance_currency || 'USD');
        balEl.style.color = tcBalanceTextColor(c.balance_amount);
      }
    }
    tcLedgerById = {};
    (res.ledger || []).forEach(function(l) {
      if (l.id != null) tcLedgerById[l.id] = l;
    });
    var ledgerBox = document.getElementById('tcDetailLedger');
    if (ledgerBox) {
      ledgerBox.innerHTML =
        (res.ledger || [])
          .map(function(l) {
            var cat = l.colorCategory || 'balance';
            var border = 'border-s-[3px] border-s-[#047857]';
            if (cat === 'payout') border = 'border-s-[3px] border-s-[#9a3412]';
            var after = l.balanceAfterUsd != null && !isNaN(l.balanceAfterUsd)
              ? l.balanceAfterUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD'
              : '—';
            var rowClick = l.id ? ' role="button" tabindex="0" onclick="tcOpenLedgerRow(' + l.id + ')"' : '';
            var rowHover = l.id ? ' cursor-pointer hover:bg-white' : '';
            return (
              '<div class="mb-2 last:mb-0 rounded-xl border border-slate-100 bg-white py-2.5 ps-2 pe-3 shadow-sm ' +
              border +
              rowHover +
              '"' +
              rowClick +
              '>' +
              '<div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">' +
              '<div class="min-w-0"><span class="text-sm font-medium text-slate-800">' +
              escHtml(l.labelAr || '') +
              '</span>' +
              '<span class="mt-0.5 block truncate text-[0.7rem] text-slate-500">' +
              escHtml(l.notes || '') +
              '</span></div>' +
              '<div class="shrink-0 text-left sm:min-w-[7rem]"><span class="font-semibold tabular-nums">' +
              (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) +
              ' ' +
              escHtml(l.currency || '') +
              '</span>' +
              '<span class="mt-0.5 block text-[0.65rem] text-slate-500">بعد: ' +
              after +
              '</span></div></div></div>'
            );
          })
          .join('') ||
        '<p class="py-8 text-center text-slate-400">لا سجل</p>';
    }
    var hid = document.getElementById('tcReturnCompanyId');
    if (hid && tcCurrentId) hid.value = String(tcCurrentId);
    tcToggleReturnFund();
  }

  window.tcLoadDetail = function() {
    if (!tcCurrentId) return;
    apiCall('/api/transfer-companies/' + tcCurrentId).then(function(res) {
      applyTcDetailResponse(res);
      tryOpenTcModalFromQuery();
    });
  };

  window.tcSubmitReturn = function() {
    var cid = document.getElementById('tcReturnCompanyId');
    var amt = parseFloat(document.getElementById('tcReturnAmt').value);
    if (!cid || !cid.value || isNaN(amt) || amt <= 0) {
      toast('أدخل مبلغاً صالحاً', 'error');
      return;
    }
    var disp = document.getElementById('tcReturnDisposition').value;
    var body = {
      entityType: 'transfer_company',
      entityId: cid.value,
      amount: amt,
      currency: document.getElementById('tcReturnCur').value,
      disposition: disp,
      notes: document.getElementById('tcReturnNotes').value || null,
    };
    if (disp === 'transfer_to_fund') {
      var fid = document.getElementById('tcReturnFundId').value;
      if (!fid) {
        toast('اختر الصندوق', 'error');
        return;
      }
      body.targetFundId = fid;
    }
    apiCall('/api/returns', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(function(res) {
      toast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        document.getElementById('tcReturnAmt').value = '';
        tcCloseReturnModal();
        tcLoadDetail();
      }
    });
  };

  window.tcOpenLedgerRow = function(id) {
    var l = tcLedgerById[id];
    if (!l) return;
    tcCloseReceivableModal();
    tcCloseReturnModal();
    tcLedgerModalRow = l;
    var titleEl = document.getElementById('tcLedgerMoveModalTitle');
    var bodyEl = document.getElementById('tcLedgerMoveModalBody');
    var btn = document.getElementById('tcLedgerMoveModalCancelBtn');
    if (titleEl) titleEl.textContent = l.labelAr || 'حركة';
    if (bodyEl) {
      var parts = [];
      parts.push(
        '<p><span class="font-semibold text-slate-600">المبلغ:</span> ' +
          (l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) +
          ' ' +
          escHtml(l.currency || '') +
          '</p>'
      );
      if (l.notes) parts.push('<p class="break-words"><span class="font-semibold text-slate-600">الوصف:</span> ' + escHtml(l.notes) + '</p>');
      if (l.created_at) {
        try {
          parts.push('<p class="text-xs text-slate-500">' + escHtml(new Date(l.created_at).toLocaleString('ar-SY')) + '</p>');
        } catch (_) {}
      }
      if (l.cancelled_at) parts.push('<p class="text-amber-800 font-semibold text-sm">هذه الحركة ملغاة</p>');
      bodyEl.innerHTML = parts.join('');
    }
    if (btn) btn.classList.toggle('hidden', !l.canCancel);
    var modal = document.getElementById('tcLedgerMoveModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  };

  window.tcCloseLedgerModal = function() {
    tcLedgerModalRow = null;
    var modal = document.getElementById('tcLedgerMoveModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  };

  window.tcConfirmCancelLedger = function() {
    if (!tcLedgerModalRow || !tcCurrentId || !tcLedgerModalRow.id || !tcLedgerModalRow.canCancel) return;
    if (!window.confirm('إلغاء هذه الحركة واسترجاع الأرصدة والالتزامات المرتبطة بها؟')) return;
    apiCall('/api/transfer-companies/' + tcCurrentId + '/ledger/' + tcLedgerModalRow.id + '/cancel', { method: 'POST' }).then(function(res) {
      toast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        tcCloseLedgerModal();
        tcLoadDetail();
        if (document.getElementById('tcCards')) loadList();
      }
    });
  };

  window.tcDownloadLedgerPdf = function() {
    window.tcDownloadLedgerPdfFor(tcCurrentId);
  };

  window.tcSubmitReceivable = function() {
    if (!tcCurrentId) return;
    var amt = parseFloat(document.getElementById('tcRecvAmt').value);
    if (isNaN(amt) || amt <= 0) {
      toast('أدخل مبلغاً صالحاً', 'error');
      return;
    }
    var cur = document.getElementById('tcRecvCur').value;
    var notes = document.getElementById('tcRecvNotes').value;
    apiCall('/api/transfer-companies/' + tcCurrentId + '/add-receivable', {
      method: 'POST',
      body: JSON.stringify({ amount: amt, currency: cur, notes: notes || null }),
    }).then(function(res) {
      toast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        document.getElementById('tcRecvAmt').value = '';
        document.getElementById('tcRecvNotes').value = '';
        tcCloseReceivableModal();
        tcLoadDetail();
        if (document.getElementById('tcCards')) loadList();
      }
    });
  };

  var tcAddForm = document.getElementById('tcAddForm');
  if (tcAddForm) {
    tcAddForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var types = [];
      document.querySelectorAll('.tcTypeCb:checked').forEach(function(cb) {
        types.push(cb.value);
      });
      apiCall('/api/transfer-companies/add', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('tcName').value,
          country: document.getElementById('tcCountry').value,
          balanceAmount: document.getElementById('tcBal').value,
          balanceCurrency: document.getElementById('tcBalCur').value,
          transferTypes: types,
        }),
      }).then(function(res) {
        toast(res.message || '', res.success ? 'success' : 'error');
        if (res.success) {
          tcCloseAdd();
          loadList();
        }
      });
    });
  }

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
    toast('افتح ملف شركة من القائمة، ثم استخدم «تسجيل مرتجع» من الأزرار العلوية أو من بطاقة الشركة. للصناديق: «الصناديق» ثم افتح الصندوق.', 'success');
    var el = document.getElementById('tcCards');
    if (el) setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 200);
  }

  document.addEventListener('DOMContentLoaded', function() {
    var detailPage = document.getElementById('tcDetailPage');
    if (detailPage && detailPage.dataset.transferCompanyId) {
      tcCurrentId = parseInt(detailPage.dataset.transferCompanyId, 10);
      if (isNaN(tcCurrentId)) {
        window.location.href = '/transfer-companies';
        return;
      }
      var tcRetDisp = document.getElementById('tcReturnDisposition');
      if (tcRetDisp) tcRetDisp.addEventListener('change', tcToggleReturnFund);
      tcLoadDetail();
      return;
    }
    loadList();
    applyFabDeepLink();
  });
})();
