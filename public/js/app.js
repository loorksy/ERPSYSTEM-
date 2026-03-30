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

/** تنسيق أرقام لوحة التحكم — فئات Tailwind فقط */
var HOME_METRIC_CLASS = 'mt-auto font-mono font-bold tabular-nums tracking-tight transition-colors duration-200 text-sm leading-tight sm:text-base sm:leading-none md:text-lg xl:text-xl';

function homeApplyMetric(el, rawVal, kind) {
  if (!el) return;
  kind = kind || 'balance';
  if (kind === 'dash') {
    if (rawVal == null || rawVal === '') {
      el.textContent = '—';
      el.className = HOME_METRIC_CLASS + ' text-slate-400';
      return;
    }
    kind = 'receivable';
  }
  var v = rawVal == null ? NaN : parseFloat(rawVal);
  if (isNaN(v)) v = 0;
  el.textContent = formatMoney(v);
  var tone = 'text-slate-900';
  if (kind === 'debt') {
    tone = v > 0 ? 'text-red-600' : 'text-slate-500';
  } else if (kind === 'profit') {
    tone = v < 0 ? 'text-red-600' : (v > 0 ? 'text-emerald-700' : 'text-slate-600');
  } else if (kind === 'receivable') {
    tone = v < 0 ? 'text-red-600' : (v > 0 ? 'text-emerald-700' : 'text-slate-600');
  } else if (kind === 'expense') {
    tone = v > 0 ? 'text-rose-700' : 'text-slate-600';
  } else {
    tone = v < 0 ? 'text-red-600' : 'text-slate-900';
  }
  el.className = HOME_METRIC_CLASS + ' ' + tone;
}

/** يحدّث بطاقة رصيد المؤجل في لوحة التحكم بعد التدقيق أو إعادة احتساب المؤجل */
window.refreshDeferredBalanceCard = function() {
  fetch('/dashboard/stats', { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) return;
      var defEl = document.getElementById('deferredBalance');
      if (defEl) {
        var dv = data.deferredBalance;
        homeApplyMetric(defEl, dv != null && dv !== 0 ? dv : 0, 'balance');
      }
    })
    .catch(function() {});
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
        homeApplyMetric(document.getElementById('cashBalance'), data.cashBalance, 'balance');
        var defEl = document.getElementById('deferredBalance');
        if (defEl) {
          var dv = data.deferredBalance;
          homeApplyMetric(defEl, dv != null && dv !== 0 ? dv : 0, 'balance');
        }
        homeApplyMetric(document.getElementById('shippingBalance'), data.shippingBalance, 'balance');
        homeApplyMetric(document.getElementById('netProfit'), data.netProfit, 'profit');
        homeApplyMetric(document.getElementById('totalExpenses'), data.totalExpenses, 'expense');
        homeApplyMetric(document.getElementById('totalDebts'), data.totalDebts, 'debt');
        var recvH = document.getElementById('receivablesToUsHome');
        if (recvH) {
          homeApplyMetric(recvH, data.receivablesToUsTotal, 'dash');
        }
        var pdH = document.getElementById('paymentDueHome');
        if (pdH) {
          if (data.paymentDueTotal != null) {
            homeApplyMetric(pdH, data.paymentDueTotal, 'debt');
          } else {
            pdH.textContent = '—';
            pdH.className = HOME_METRIC_CLASS + ' text-slate-400';
          }
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
    if (d.profitPoolUsd != null && d.profitPoolUsd > 0) {
      html += '<div class="p-3 rounded-xl bg-indigo-50 border border-indigo-100 mt-2"><strong>صندوق الربح</strong> ' +
        '<span class="text-xs text-slate-500">(منفصل عن بطاقة رصيد الصندوق)</span>' +
        '<p class="font-semibold text-indigo-800 mt-1">' + formatMoney(d.profitPoolUsd) + ' USD</p></div>';
    }
    body.innerHTML = html || '<p class="text-slate-400">لا بيانات</p>';
  });
};
window.homeCloseFundModal = function() {
  var m = document.getElementById('homeFundModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
};

function initHomeSheetsStatus() {
  var el = document.getElementById('homeSheetsStatus');
  if (!el) return;
  var base =
    'inline-flex items-center rounded-full px-2 py-0.5 text-[0.6rem] sm:text-[0.65rem] font-semibold';
  fetch('/sheets/status', { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success && data.connected) {
        el.textContent = 'متصل';
        el.className = base + ' bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80';
      } else {
        el.textContent = 'غير متصل';
        el.className = base + ' bg-amber-50 text-amber-800 ring-1 ring-amber-200/80';
      }
    })
    .catch(function() {
      el.textContent = 'غير متصل';
      el.className = base + ' bg-amber-50 text-amber-800 ring-1 ring-amber-200/80';
    });
}


var LORKERP_SIDEBAR_DESKTOP_COLLAPSED_KEY = 'lorkerp_sidebar_desktop_collapsed';

function applyDesktopSidebarCollapsed(collapsed) {
  var mq = window.matchMedia('(min-width: 1024px)');
  if (!mq.matches) return;
  document.body.classList.toggle('sidebar-desktop-collapsed', collapsed);
  var btn = document.getElementById('sidebarCollapseToggle');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var expand = collapsed ? 'توسيع القائمة' : 'طي القائمة';
    btn.setAttribute('aria-label', expand);
    btn.setAttribute('title', expand);
    var icon = btn.querySelector('i');
    if (icon) {
      icon.className = collapsed ? 'fas fa-angles-left text-sm' : 'fas fa-angles-right text-sm';
    }
  }
  try {
    localStorage.setItem(LORKERP_SIDEBAR_DESKTOP_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (_) {}
}

function syncDesktopSidebarFromStorage() {
  var mq = window.matchMedia('(min-width: 1024px)');
  if (mq.matches) {
    applyDesktopSidebarCollapsed(readDesktopSidebarCollapsedFromStorage());
  } else {
    document.body.classList.remove('sidebar-desktop-collapsed');
  }
}

function readDesktopSidebarCollapsedFromStorage() {
  try {
    return localStorage.getItem(LORKERP_SIDEBAR_DESKTOP_COLLAPSED_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function initSidebar() {
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebarClose = document.getElementById('sidebarClose');
  const sidebarCollapseToggle = document.getElementById('sidebarCollapseToggle');

  if (sidebarCollapseToggle) {
    sidebarCollapseToggle.addEventListener('click', function () {
      var next = !document.body.classList.contains('sidebar-desktop-collapsed');
      applyDesktopSidebarCollapsed(next);
    });
  }

  var mqDesktop = window.matchMedia('(min-width: 1024px)');
  syncDesktopSidebarFromStorage();
  if (typeof mqDesktop.addEventListener === 'function') {
    mqDesktop.addEventListener('change', syncDesktopSidebarFromStorage);
  } else if (mqDesktop.addListener) {
    mqDesktop.addListener(syncDesktopSidebarFromStorage);
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      /* max-lg:translate-x-[calc(100%+4px)] على الشريط يغلب translate-x-0 في Tailwind — نستخدم ! للفتح */
      sidebar.classList.add('max-lg:!translate-x-0', 'translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
      sidebarOverlay.classList.remove('hidden');
      sidebarOverlay.classList.add('block');
      document.body.style.overflow = 'hidden';
    });
  }

  function closeSidebar() {
    sidebar.classList.remove('max-lg:!translate-x-0', 'translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
    sidebarOverlay.classList.add('hidden');
    sidebarOverlay.classList.remove('block');
    document.body.style.overflow = '';
  }

  window.closeSidebar = closeSidebar;

  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);

  window.updatePayrollDraftNavBadge = function () {
    try {
      var badge = document.getElementById('navPayrollDraftBadge');
      if (!badge) return;
      var has = !!localStorage.getItem('payrollAuditDraftV1');
      badge.classList.toggle('hidden', !has);
    } catch (_) {}
  };
  window.updatePayrollDraftNavBadge();

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

  var PULSE_ANIM = 'animate-[quick-action-fab-press_0.45s_cubic-bezier(0.34,1.45,0.64,1)]';

  function isOpen() {
    return (radialM && radialM.getAttribute('data-radial-open') === 'true') ||
      (radialD && radialD.getAttribute('data-radial-open') === 'true');
  }

  function triggerFabPress(btn) {
    if (!btn || !btn.classList.contains('quick-action-fab')) return;
    btn.classList.remove(PULSE_ANIM);
    void btn.offsetWidth;
    btn.classList.add(PULSE_ANIM);
    function done() {
      btn.removeEventListener('animationend', done);
      btn.classList.remove(PULSE_ANIM);
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
      el.setAttribute('data-radial-open', open ? 'true' : 'false');
    });
    document.querySelectorAll('.quick-action-radial-subs').forEach(function (el) {
      el.setAttribute('aria-hidden', open ? 'false' : 'true');
    });
    if (open) {
      backdrop.classList.remove('hidden');
      backdrop.classList.remove('opacity-100', 'pointer-events-auto');
      backdrop.classList.add('opacity-0', 'pointer-events-none');
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          backdrop.classList.remove('opacity-0', 'pointer-events-none');
          backdrop.classList.add('opacity-100', 'pointer-events-auto');
        });
      });
    } else {
      backdrop.classList.remove('opacity-100', 'pointer-events-auto');
      backdrop.classList.add('opacity-0', 'pointer-events-none');
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
  });
  if (targetTab) {
    targetTab.classList.remove('hidden');
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
  setTimeout(() => {
    toast.classList.remove('animate-[toastIn_0.3s_ease]');
    toast.classList.add('animate-[toastOut_0.3s_ease]');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
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
