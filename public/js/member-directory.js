(function () {
  const input = document.getElementById('mdSearchInput');
  const btn = document.getElementById('mdSearchBtn');
  const pasteBtn = document.getElementById('mdPasteBtn');
  const tbody = document.getElementById('mdTableBody');
  const pageInfo = document.getElementById('mdPageInfo');
  const prevBtn = document.getElementById('mdPrevBtn');
  const nextBtn = document.getElementById('mdNextBtn');
  let page = 1;
  const pageSize = 50;
  let total = 0;
  let q = '';
  let liveDebounceTimer = null;
  const LIVE_DEBOUNCE_MS = 320;

  function getQuery() {
    return (input.value || '').trim();
  }

  /** بحث لحظي أثناء الكتابة: فارغ أو أرقام فقط (رقم مستخدم) */
  function isLiveSearchQuery(v) {
    return v === '' || /^\d+$/.test(v);
  }

  function runSearch() {
    q = getQuery();
    page = 1;
    load();
  }

  function scheduleLiveSearch() {
    clearTimeout(liveDebounceTimer);
    liveDebounceTimer = setTimeout(() => {
      const v = getQuery();
      if (!isLiveSearchQuery(v)) return;
      runSearch();
    }, LIVE_DEBOUNCE_MS);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function load() {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q: q || '' });
    const res = await fetch('/api/member-directory/list?' + params.toString(), { credentials: 'same-origin' });
    if (res.status === 401) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="px-3 py-10 text-center text-sm text-red-600 sm:px-4">انتهت الجلسة — أعد تسجيل الدخول</td></tr>';
      return;
    }
    const data = await res.json();
    if (!data.success) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-10 text-center text-sm text-red-600 sm:px-4">' + esc(data.message || 'فشل') + '</td></tr>';
      return;
    }
    total = data.total || 0;
    const rows = data.rows || [];
    if (!rows.length) {
      try {
        sessionStorage.removeItem('mdMemberNavIds');
      } catch (_) {}
      tbody.innerHTML =
        '<tr><td colspan="7" class="px-3 py-12 text-center text-sm leading-relaxed text-slate-500 sm:px-4">لا توجد نتائج — يُستخرج الأعضاء من التدقيق، المؤجل، أو الوكالات</td></tr>';
    } else {
      try {
        sessionStorage.setItem(
          'mdMemberNavIds',
          JSON.stringify(rows.map((r) => String(r.member_user_id)))
        );
      } catch (_) {}
      tbody.innerHTML = rows
        .map((r) => {
          const idEnc = encodeURIComponent(r.member_user_id);
          return (
            '<tr class="transition-colors hover:bg-indigo-50/40">' +
            '<td class="py-3.5 pl-2 pr-2 font-mono text-xs tabular-nums text-slate-900 sm:pl-4">' +
            esc(r.member_user_id) +
            '</td>' +
            '<td class="px-2 py-3.5 text-slate-800 sm:px-4">' +
            esc(r.display_name || r.last_seen_name || '—') +
            '</td>' +
            '<td class="px-2 py-3.5 font-mono text-sm tabular-nums text-slate-800 sm:px-4" dir="ltr">' +
            esc(Number(r.total_salary_audited_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-2 py-3.5 font-mono text-sm tabular-nums text-slate-800 sm:px-4" dir="ltr">' +
            esc(Number(r.deferred_balance_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-2 py-3.5 font-mono text-sm tabular-nums text-slate-800 sm:px-4" dir="ltr">' +
            esc(Number(r.debt_to_company_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-2 py-3.5 text-xs text-slate-500 sm:px-4">' +
            esc(r.updated_at ? new Date(r.updated_at).toLocaleString('ar') : '—') +
            '</td>' +
            '<td class="py-3.5 pl-4 pr-2 text-left sm:pr-4">' +
            '<a class="inline-flex items-center justify-center rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 hover:text-indigo-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" href="/member-directory/member/' +
            idEnc +
            '">تفاصيل</a></td>' +
            '</tr>'
          );
        })
        .join('');
    }
    const pages = Math.max(1, Math.ceil(total / pageSize));
    pageInfo.textContent = 'صفحة ' + page + ' من ' + pages + ' — ' + total + ' سجل';
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= pages;
  }

  btn.addEventListener('click', runSearch);
  input.addEventListener('input', scheduleLiveSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      input.value = (t || '').trim();
      runSearch();
    } catch (_) {}
  });
  prevBtn.addEventListener('click', () => {
    if (page > 1) {
      page--;
      load();
    }
  });
  nextBtn.addEventListener('click', () => {
    page++;
    load();
  });

  load();
})();
