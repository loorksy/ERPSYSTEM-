window.currencySymbol = '$';
window.formatMoney = function(num) {
  var n = typeof num === 'number' ? num : parseFloat(num) || 0;
  var s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var sym = window.currencySymbol;
  return (sym && sym !== '') ? s + ' ' + sym : s;
};

/** روابط قديمة أو برمجية؛ الإجراء السريع الحقيقي عبر زرّي صادر/وارد (+) وملف quick-actions.js */
window.navigateQuickAction = function(type) {
  var map = {
    صادر: '/shipping?fab=out',
    وارد: '/shipping?fab=in',
    مرتجع: '/transfer-companies?fab=return',
    مصاريف: '/expenses-manual',
    'دين-علينا': '/payables-us',
    اعتمادات: '/approvals',
    'وساطة-إدارية': '/admin-brokerage',
    ديون: '/debts',
  };
  var url = map[type];
  if (url) {
    window.location.href = url;
    return;
  }
  if (typeof window.showToast === 'function') {
    window.showToast('إجراء غير معروف: ' + type, 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  initSidebar();
  initDate();
  initHomeSheetsStatus();
  initHomeStats();
  initQuickActionFab();
  document.addEventListener('quickAction', function(ev) {
    var t = ev.detail && ev.detail.type;
    if (t && typeof window.navigateQuickAction === 'function') window.navigateQuickAction(t);
  });
  fetch('/settings/currency', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { if (d.success && d.symbol) window.currencySymbol = d.symbol; })
    .catch(() => {});
});

window.homeDownloadReportPdf = function() {
  var typeEl = document.getElementById('homeReportType');
  var cycleSel = document.getElementById('homeCycleSelect');
  var t = typeEl ? typeEl.value : 'comprehensive';
  var cid = cycleSel && cycleSel.value ? cycleSel.value : '';
  var path = '/api/reports/pdf/';
  if (t === 'transfer-companies') {
    path += 'transfer-companies';
  } else if (t === 'comprehensive') {
    path += 'comprehensive';
  } else if (t === 'accreditations') {
    path += 'accreditations';
  } else if (t === 'movements') {
    path += 'movements';
  } else {
    path += 'comprehensive';
  }
  var q = [];
  if (cid && t !== 'transfer-companies') {
    q.push('cycleId=' + encodeURIComponent(cid));
  }
  window.open(path + (q.length ? '?' + q.join('&') : ''), '_blank');
};

function initHomeStats() {
  var cycleSel = document.getElementById('homeCycleSelect');
  if (!cycleSel) return;
  window.homeLoadStats = function() {
    var cycleId = cycleSel ? cycleSel.value : '';
    fetch('/dashboard/stats' + (cycleId ? '?cycleId=' + cycleId : ''), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) return;
        var cycles = data.cycles || [];
        if (cycleSel && cycles.length && !cycleSel.dataset.filled) {
          cycleSel.innerHTML = '<option value="">-- اختر الدورة --</option>' + cycles.map(function(c) {
            return '<option value="' + c.id + '"' + (c.id === data.cycleId ? ' selected' : '') + '>' + (c.name || '') + '</option>';
          }).join('');
          cycleSel.dataset.filled = '1';
        }
        var pc = document.getElementById('homeProfitCycle');
        if (pc && cycles.length && !pc.dataset.filled) {
          pc.innerHTML = '<option value="">— دورة —</option>' + cycles.map(function(c) {
            return '<option value="' + c.id + '">' + (c.name || '') + '</option>';
          }).join('');
          pc.dataset.filled = '1';
        }
        function setEl(id, val) {
          var el = document.getElementById(id);
          if (el) el.textContent = formatMoney(val != null ? val : 0);
        }
        setEl('cashBalance', data.cashBalance);
        var defEl = document.getElementById('deferredBalance');
        if (defEl) {
          var dv = data.deferredBalance;
          if (dv != null && dv !== 0) {
            defEl.textContent = formatMoney(dv);
          } else {
            defEl.textContent = formatMoney(0);
          }
        }
        setEl('shippingBalance', data.shippingBalance);
        setEl('totalRevenue', data.totalRevenue);
        setEl('netProfit', data.netProfit);
        setEl('totalExpenses', data.totalExpenses);
        setEl('totalDebts', data.totalDebts);
        setEl('capitalRecovery', data.capitalRecovered);
        var sub = document.getElementById('cashBalanceSub');
        if (sub) {
          var mf = data.mainFund;
          var parts = [];
          if (data.snapshotCash != null && data.snapshotCash !== 0) {
            parts.push('من الجداول: ' + formatMoney(data.snapshotCash));
          }
          if (mf && mf.name) {
            parts.push('الصندوق الرئيسي: ' + mf.name + (data.mainFundUsd != null ? ' (' + formatMoney(data.mainFundUsd) + ')' : ''));
          }
          sub.textContent = parts.join(' | ');
        }
        var link = document.getElementById('deferredBalanceLink');
        if (link) link.href = '/deferred-balance';
      })
      .catch(function() {});
  };
  homeLoadStats();
}

window.homeOpenFundModal = function() {
  var m = document.getElementById('homeFundModal');
  var body = document.getElementById('homeFundModalBody');
  if (!m || !body) return;
  body.innerHTML = '<p class="text-slate-400">جاري التحميل...</p>';
  m.classList.remove('hidden');
  m.classList.add('flex');
  fetch('/dashboard/fund-sources', { credentials: 'same-origin' }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.success) {
      body.innerHTML = '<p class="text-red-500">' + (d.message || 'فشل') + '</p>';
      return;
    }
    var html = '';
    (d.funds || []).forEach(function(f) {
      var bs = (f.balances || []).map(function(b) {
        return (b.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (b.currency || '');
      }).join(' | ');
      html += '<div class="p-3 rounded-xl bg-slate-50 border border-slate-100"><strong>' + (f.name || '') + '</strong> ' +
        (f.is_main ? '<span class="text-amber-600 text-xs">رئيسي</span>' : '') +
        '<p class="text-xs text-slate-500">' + (f.fund_number || '') + ' · ' + (f.country || '') + '</p>' +
        '<p class="font-semibold text-indigo-700">' + (bs || '0') + '</p></div>';
    });
    if (d.recentSnapshots && d.recentSnapshots.length) {
      html += '<p class="font-semibold text-slate-700 mt-2">لقطات من الجداول (مرجع)</p>';
      d.recentSnapshots.forEach(function(s) {
        html += '<p class="text-xs">' + (s.name || '') + ': ' + formatMoney(s.cash_balance || 0) + '</p>';
      });
    }
    body.innerHTML = html || '<p class="text-slate-400">لا بيانات</p>';
  });
};
window.homeCloseFundModal = function() {
  var m = document.getElementById('homeFundModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
};

window.homeOpenCapitalModal = function() {
  var m = document.getElementById('homeCapitalModal');
  if (!m) return;
  var rows = document.getElementById('homeProfitRows');
  if (rows && !rows.dataset.inited) {
    homeAddProfitRow();
    rows.dataset.inited = '1';
  }
  m.classList.remove('hidden');
  m.classList.add('flex');
  fetch('/api/funds/list', { credentials: 'same-origin' }).then(function(r) { return r.json(); }).then(function(d) {
    document.querySelectorAll('.home-profit-fund-select').forEach(function(sel) {
      var v = sel.value;
      sel.innerHTML = '<option value="">— صندوق —</option>';
      (d.funds || []).forEach(function(f) {
        sel.innerHTML += '<option value="' + f.id + '">' + (f.name || '') + '</option>';
      });
      sel.value = v;
    });
  });
};
window.homeCloseCapitalModal = function() {
  var m = document.getElementById('homeCapitalModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
};
window.homeAddProfitRow = function() {
  var rows = document.getElementById('homeProfitRows');
  if (!rows) return;
  var div = document.createElement('div');
  div.className = 'flex gap-2 items-center';
  div.innerHTML = '<select class="home-profit-fund-select flex-1 px-2 py-2 rounded-lg border border-slate-200 text-sm"><option value="">— صندوق —</option></select>' +
    '<input type="number" class="home-profit-amt w-28 px-2 py-2 rounded-lg border border-slate-200" step="0.01" placeholder="مبلغ">';
  rows.appendChild(div);
  fetch('/api/funds/list', { credentials: 'same-origin' }).then(function(r) { return r.json(); }).then(function(d) {
    var sel = div.querySelector('.home-profit-fund-select');
    (d.funds || []).forEach(function(f) {
      sel.innerHTML += '<option value="' + f.id + '">' + (f.name || '') + '</option>';
    });
  });
};
window.homeSubmitProfitTransfer = function() {
  var batches = [];
  document.querySelectorAll('#homeProfitRows > div').forEach(function(row) {
    var fid = row.querySelector('.home-profit-fund-select');
    var amt = row.querySelector('.home-profit-amt');
    if (fid && amt && fid.value && amt.value) {
      batches.push({ fundId: fid.value, amount: parseFloat(amt.value), currency: 'USD' });
    }
  });
  var cycleId = document.getElementById('homeProfitCycle') && document.getElementById('homeProfitCycle').value;
  apiCall('/dashboard/transfer-profit', {
    method: 'POST',
    body: JSON.stringify({ batches: batches, cycleId: cycleId || null })
  }).then(function(res) {
    if (typeof showToast === 'function') showToast(res.message || '', res.success ? 'success' : 'error');
    if (res.success) homeCloseCapitalModal();
    if (typeof homeLoadStats === 'function') homeLoadStats();
  });
};

function initHomeSheetsStatus() {
  var el = document.getElementById('homeSheetsStatus');
  if (!el) return;
  fetch('/sheets/status', { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success && data.connected) {
        el.textContent = 'مفعل';
        el.className = 'text-xs font-medium py-0.5 px-2.5 rounded-full bg-emerald-50 text-emerald-600';
      } else {
        el.textContent = 'غير مفعل';
        el.className = 'text-xs font-medium py-0.5 px-2.5 rounded-full bg-red-50 text-red-500';
      }
    })
    .catch(function() {
      el.textContent = 'غير مفعل';
      el.className = 'text-xs font-medium py-0.5 px-2.5 rounded-full bg-red-50 text-red-500';
    });
}


function initSidebar() {
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebarClose = document.getElementById('sidebarClose');

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.remove('max-lg:translate-x-full');
      sidebar.classList.add('translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
      sidebarOverlay.classList.remove('hidden');
      sidebarOverlay.classList.add('block');
      document.body.style.overflow = 'hidden';
    });
  }

  function closeSidebar() {
    sidebar.classList.add('max-lg:translate-x-full');
    sidebar.classList.remove('translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
    sidebarOverlay.classList.add('hidden');
    sidebarOverlay.classList.remove('block');
    document.body.style.overflow = '';
  }

  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);

  let startX = 0, currentX = 0, isDragging = false;
  sidebar?.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; isDragging = true; });
  sidebar?.addEventListener('touchmove', (e) => { if (!isDragging) return; currentX = e.touches[0].clientX; const d = currentX - startX; if (d > 0) sidebar.style.transform = `translateX(${d}px)`; });
  sidebar?.addEventListener('touchend', () => { isDragging = false; if (currentX - startX > 80) closeSidebar(); sidebar.style.transform = ''; currentX = 0; startX = 0; });
}

function initDate() {
  const el = document.getElementById('currentDate');
  if (el) el.textContent = new Date().toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** زر + شعاعي (صادر / وارد / مرتجع) — موبايل + لابتوب */
function initQuickActionFab() {
  var backdrop = document.getElementById('quickActionBackdrop');
  var radialM = document.getElementById('quickActionRadialMobile');
  var radialD = document.getElementById('quickActionRadialDesktop');
  var fabM = document.getElementById('quickActionFabMobile');
  var fabD = document.getElementById('quickActionFabDesktop');
  if (!backdrop) return;

  var closeTimer = null;
  var PANEL_MS = 260;

  function isOpen() {
    return (radialM && radialM.classList.contains('quick-action-radial--open')) ||
      (radialD && radialD.classList.contains('quick-action-radial--open'));
  }

  function triggerFabPress(btn) {
    if (!btn || !btn.classList.contains('quick-action-fab')) return;
    btn.classList.remove('quick-action-fab-pulse');
    void btn.offsetWidth;
    btn.classList.add('quick-action-fab-pulse');
    function done() {
      btn.removeEventListener('animationend', done);
      btn.classList.remove('quick-action-fab-pulse');
    }
    btn.addEventListener('animationend', done, { once: true });
  }

  function setOpen(open) {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    [radialM, radialD].forEach(function (el) {
      if (!el) return;
      if (open) el.classList.add('quick-action-radial--open');
      else el.classList.remove('quick-action-radial--open');
    });
    document.querySelectorAll('.quick-action-radial-subs').forEach(function (el) {
      el.setAttribute('aria-hidden', open ? 'false' : 'true');
    });
    if (open) {
      backdrop.classList.remove('hidden');
      backdrop.classList.remove('quick-action-panel-open');
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          backdrop.classList.add('quick-action-panel-open');
        });
      });
    } else {
      backdrop.classList.remove('quick-action-panel-open');
      closeTimer = setTimeout(function () {
        backdrop.classList.add('hidden');
        closeTimer = null;
      }, PANEL_MS);
      document.body.style.overflow = '';
    }
    [fabM, fabD].forEach(function (el) {
      if (el) el.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function toggle(fromBtn) {
    var open = isOpen();
    if (!open && fromBtn) triggerFabPress(fromBtn);
    setOpen(!open);
  }

  if (fabM) fabM.addEventListener('click', function (e) { e.stopPropagation(); toggle(fabM); });
  if (fabD) fabD.addEventListener('click', function (e) { e.stopPropagation(); toggle(fabD); });
  backdrop.addEventListener('click', function () { setOpen(false); });

  document.querySelectorAll('.quick-action-radial-sub').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var t = this.getAttribute('data-quick-type') || '';
      if (typeof window.handleQuickActionSub === 'function' && window.handleQuickActionSub(t)) {
        setOpen(false);
        return;
      }
      try {
        window.dispatchEvent(new CustomEvent('quickAction', { detail: { type: t } }));
      } catch (_) {}
      setOpen(false);
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });
}

function switchTab(btn, tabId) {
  var card = btn.closest('[data-tabs-container="settings"]') || document.getElementById('settingsCard') || btn.closest('.bg-white');
  if (!card) return;
  var tabs = card.querySelectorAll('.tab-content');
  var targetTab = document.getElementById(tabId);
  tabs.forEach(function(t) {
    t.classList.add('hidden');
    t.style.display = 'none';
  });
  if (targetTab) {
    targetTab.classList.remove('hidden');
    targetTab.style.display = '';
    targetTab.setAttribute('aria-hidden', 'false');
  }
  tabs.forEach(function(t) {
    if (t !== targetTab) t.setAttribute('aria-hidden', 'true');
  });
  card.querySelectorAll('.tab-btn').forEach(function(b) {
    b.className = 'tab-btn px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 bg-slate-100 text-slate-600 hover:bg-slate-200';
  });
  btn.className = 'tab-btn px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 bg-indigo-600 text-white shadow-md';
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const isSuccess = type === 'success';
  const toast = document.createElement('div');
  toast.className = `flex items-center gap-2.5 py-3.5 px-5 bg-white rounded-xl shadow-lg min-w-[280px] max-w-[400px] text-[0.9rem] animate-[toastIn_0.3s_ease] border-r-4 ${isSuccess ? 'border-r-emerald-500' : 'border-r-red-500'}`;
  toast.innerHTML = `
    <i class="fas fa-${isSuccess ? 'check-circle text-emerald-500' : 'exclamation-circle text-red-500'}"></i>
    <span>${message}</span>
    <button class="mr-auto text-slate-400 p-1 cursor-pointer hover:text-slate-600" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
  `;
  container.appendChild(toast);
  setTimeout(() => { toast.style.animation = 'toastOut 0.3s ease'; setTimeout(() => toast.remove(), 300); }, 4000);
}

async function apiCall(url, options = {}) {
  var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (options.headers) {
    headers = Object.assign({}, headers, options.headers);
    delete options.headers;
  }
  try {
    var res = await fetch(url, { credentials: 'same-origin', headers: headers, ...options });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok) {
      return { success: false, message: data.message || data.error || ('خطأ من الخادم: ' + res.status) };
    }
    return data;
  } catch (err) {
    return { success: false, message: 'خطأ في الاتصال بالخادم. تحقق من تشغيل السيرفر والشبكة.' };
  }
}

async function updateProfile(e) {
  e.preventDefault();
  const result = await apiCall('/settings/update-profile', { method: 'POST', body: JSON.stringify({ displayName: document.getElementById('displayName').value }) });
  showToast(result.message, result.success ? 'success' : 'error');
  if (result.success) setTimeout(() => location.reload(), 1000);
}

async function changePassword(e) {
  e.preventDefault();
  const result = await apiCall('/settings/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: document.getElementById('currentPassword').value,
      newPassword: document.getElementById('newPassword').value,
      confirmPassword: document.getElementById('confirmPassword').value
    })
  });
  showToast(result.message, result.success ? 'success' : 'error');
  if (result.success) document.getElementById('passwordForm').reset();
}
