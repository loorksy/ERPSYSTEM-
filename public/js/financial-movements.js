(function () {
  const BUCKET_LABELS = {
    payable: 'دين علينا',
    receivable: 'دين لنا',
    obligation: 'التزامات',
    transfer: 'ترحيل نقدي',
  };

  const FILTER_BASE =
    'fm-filter-btn inline-flex min-h-[2.75rem] w-full items-center justify-center rounded-xl border px-3 py-2 text-[11px] transition-colors sm:min-h-0 sm:text-sm ';

  const BUCKET_BADGE = {
    payable: 'bg-rose-100 text-rose-900 border-rose-200',
    receivable: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    obligation: 'bg-indigo-100 text-indigo-900 border-indigo-200',
    transfer: 'bg-amber-100 text-amber-900 border-amber-200',
  };

  /** تسمية عربية لنوع السجل الداخلي (لا تُعرَض للمستخدم كمعرّف إنجليزي) */
  const KIND_LABELS_AR = {
    entity_payable: 'تسجيل دين علينا',
    shipping_debt: 'شحن — بيع آجل',
    company_negative_balance: 'شركة — رصيد سالب',
    fund_negative_balance: 'صندوق — رصيد سالب',
    accreditation_payable: 'معتمد — مطلوب دفع',
    fx_spread: 'فرق تصريف',
    aggregate_entity_payables: 'مجموع ديون مسجّلة',
    company_positive_balance: 'شركة — لنا لديها',
    sub_agency_receivable: 'وكالة فرعية — لنا',
    accreditation_receivable: 'معتمد — دين لنا',
    member_debt_to_company: 'مستخدم — دين على العضو',
    financial_return: 'مرتجع مالي',
  };

  let currentBucket = 'all';
  let lastItems = [];

  function fmtMoney(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }

  function fmtKpi(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return (
      Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' دولار'
    );
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString('ar-SA-u-ca-gregory', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return iso;
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
  }

  function currencyAr(c) {
    const x = String(c == null ? '' : c).toUpperCase();
    if (x === 'USD') return 'دولار';
    if (x === 'TRY') return 'ليرة تركية';
    if (x === 'SYP') return 'ليرة سورية';
    return c ? escapeHtml(c) : '';
  }

  function setActiveFilter() {
    document.querySelectorAll('.fm-filter-btn').forEach((btn) => {
      const b = btn.getAttribute('data-fm-bucket');
      const on = b === currentBucket;
      const transferSpan = b === 'transfer' ? ' col-span-2 sm:col-span-1' : '';
      btn.className =
        FILTER_BASE +
        (on
          ? 'font-bold border-indigo-500 bg-indigo-50 text-indigo-900'
          : 'font-semibold border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50') +
        transferSpan;
    });
  }

  function renderKpis(data) {
    const t = data.totals || {};
    const br = data.breakdown || {};
    const elO = document.getElementById('fmKpiObligation');
    const elR = document.getElementById('fmKpiRecv');
    const elP = document.getElementById('fmKpiPayables');
    if (elO) elO.textContent = fmtKpi(t.totalObligationUsd);
    if (elR) elR.textContent = fmtKpi(t.receivablesToUsUsd);
    if (elP) elP.textContent = fmtKpi(br.payablesSumUsd);
  }

  function renderTable(items) {
    lastItems = items || [];
    const tbody = document.getElementById('fmTableBody');
    const empty = document.getElementById('fmEmpty');
    const count = document.getElementById('fmCount');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (count) count.textContent = `${lastItems.length} حركة`;

    if (!lastItems.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');

    lastItems.forEach((row, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50 cursor-pointer transition-colors';
      tr.setAttribute('data-fm-idx', String(idx));
      const badge = BUCKET_BADGE[row.bucket] || 'bg-slate-100 text-slate-800 border-slate-200';
      const lbl = BUCKET_LABELS[row.bucket] || row.bucket;
      const kindAr = KIND_LABELS_AR[row.kind] || 'حركة';
      tr.innerHTML = `
        <td class="px-3 py-3 align-top">
          <span class="inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-semibold ${badge}">${escapeHtml(lbl)}</span>
          <div class="text-[0.65rem] text-slate-500 mt-1">${escapeHtml(kindAr)}</div>
        </td>
        <td class="px-3 py-3 align-top">
          <div class="font-medium text-slate-900">${escapeHtml(row.titleAr || '')}</div>
          <div class="text-xs text-slate-600 mt-1 line-clamp-2">${escapeHtml(row.summaryAr || '')}</div>
        </td>
        <td class="px-3 py-3 align-top text-slate-700 whitespace-nowrap">${escapeHtml(fmtDate(row.occurredAt))}</td>
        <td class="px-3 py-3 align-top text-left font-mono tabular-nums" dir="ltr">${escapeHtml(fmtMoney(row.amount))} ${currencyAr(row.currency || 'USD')}</td>
      `;
      tr.addEventListener('click', () => openModal(row));
      tbody.appendChild(tr);
    });
  }

  function openModal(row) {
    const modal = document.getElementById('fmModal');
    const title = document.getElementById('fmModalTitle');
    const body = document.getElementById('fmModalBody');
    if (!modal || !body) return;

    if (title) title.textContent = row.titleAr || 'تفاصيل الحركة';

    const lbl = BUCKET_LABELS[row.bucket] || row.bucket;
    const kindAr = KIND_LABELS_AR[row.kind] || '—';
    let detailJson = '';
    try {
      detailJson = JSON.stringify(row.detail || {}, null, 2);
    } catch (_) {
      detailJson = String(row.detail);
    }

    const linkHref =
      typeof row.linkUrl === 'string' && row.linkUrl.trim().startsWith('/') ? row.linkUrl.trim() : '';

    body.innerHTML = `
      <div class="rounded-xl border border-slate-200 bg-slate-50/80 p-3 space-y-2">
        <p class="text-xs font-bold text-slate-500">التصنيف</p>
        <p class="text-slate-900">${escapeHtml(lbl)}</p>
        <p class="text-[11px] text-slate-500">نوع السجل: <span class="font-medium text-slate-700">${escapeHtml(kindAr)}</span></p>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="rounded-xl border border-slate-200 p-3">
          <p class="text-xs font-bold text-slate-500 mb-1">متى</p>
          <p class="text-slate-900">${escapeHtml(fmtDate(row.occurredAt))}</p>
          <p class="text-[0.65rem] text-slate-500 mt-1 font-mono break-all" dir="ltr">${escapeHtml(row.occurredAt || '')}</p>
        </div>
        <div class="rounded-xl border border-slate-200 p-3">
          <p class="text-xs font-bold text-slate-500 mb-1">المبلغ</p>
          <p class="font-mono text-lg font-bold tabular-nums text-slate-900" dir="ltr">${escapeHtml(fmtMoney(row.amount))} ${currencyAr(row.currency || 'USD')}</p>
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-bold text-slate-500 mb-1">لماذا (السبب)</p>
        <p class="text-slate-800 leading-relaxed whitespace-pre-wrap">${escapeHtml(row.whyAr || '—')}</p>
      </div>
      <div class="rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-bold text-slate-500 mb-1">كيف (المصدر والآلية)</p>
        <p class="text-slate-800 leading-relaxed whitespace-pre-wrap">${escapeHtml(row.howAr || '—')}</p>
      </div>
      <div class="rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-bold text-slate-500 mb-1">ملخص</p>
        <p class="text-slate-700 leading-relaxed whitespace-pre-wrap">${escapeHtml(row.summaryAr || '—')}</p>
      </div>
      ${
        linkHref
          ? `<div class="flex justify-end">
        <a href="${escapeHtml(linkHref)}" class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">فتح الصفحة المرتبطة <i class="fas fa-external-link-alt text-xs"></i></a>
      </div>`
          : ''
      }
      <div>
        <p class="text-xs font-bold text-slate-500 mb-2">البيانات التفصيلية (للنسخ أو المراجعة)</p>
        <pre class="text-[0.7rem] leading-relaxed bg-slate-900 text-emerald-100/95 p-3 rounded-xl overflow-x-auto max-h-48 overflow-y-auto font-mono" dir="ltr">${escapeHtml(detailJson)}</pre>
      </div>
    `;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    const modal = document.getElementById('fmModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  window.fmCloseFmModal = closeModal;

  async function load() {
    const errEl = document.getElementById('fmError');
    if (errEl) {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }

    try {
      const q = new URLSearchParams({ bucket: currentBucket });
      const res = await fetch(`/api/financial-movements/feed?${q.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل التحميل');
      }
      if (!data.success) {
        throw new Error(data.message || 'فشل التحميل');
      }
      renderKpis(data);
      renderTable(data.items);
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message || 'خطأ';
        errEl.classList.remove('hidden');
      }
      renderTable([]);
    }
  }

  function init() {
    const root = document.getElementById('fmPageRoot');
    if (!root) return;

    document.querySelectorAll('.fm-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentBucket = btn.getAttribute('data-fm-bucket') || 'all';
        setActiveFilter();
        load();
      });
    });

    document.querySelectorAll('[data-fm-close]').forEach((el) => {
      el.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    setActiveFilter();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
