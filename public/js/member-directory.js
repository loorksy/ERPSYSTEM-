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
        '<tr><td colspan="7" class="px-4 py-6 text-center text-red-600">انتهت الجلسة — أعد تسجيل الدخول</td></tr>';
      return;
    }
    const data = await res.json();
    if (!data.success) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-6 text-center text-red-600">' + esc(data.message || 'فشل') + '</td></tr>';
      return;
    }
    total = data.total || 0;
    const rows = data.rows || [];
    if (!rows.length) {
      try {
        sessionStorage.removeItem('mdMemberNavIds');
      } catch (_) {}
      tbody.innerHTML =
        '<tr><td colspan="7" class="px-4 py-6 text-center text-slate-500">لا توجد نتائج — يُستخرج الأعضاء من التدقيق، المؤجل، أو الوكالات</td></tr>';
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
            '<tr class="hover:bg-slate-50/80">' +
            '<td class="px-4 py-2 font-mono text-xs">' +
            esc(r.member_user_id) +
            '</td>' +
            '<td class="px-4 py-2">' +
            esc(r.display_name || r.last_seen_name || '—') +
            '</td>' +
            '<td class="px-4 py-2 font-mono">' +
            esc(Number(r.total_salary_audited_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-4 py-2">' +
            esc(Number(r.deferred_balance_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-4 py-2">' +
            esc(Number(r.debt_to_company_usd || 0).toFixed(2)) +
            '</td>' +
            '<td class="px-4 py-2 text-xs text-slate-500">' +
            esc(r.updated_at ? new Date(r.updated_at).toLocaleString('ar') : '—') +
            '</td>' +
            '<td class="px-4 py-2"><a class="text-indigo-600 text-xs font-semibold hover:underline" href="/member-directory/member/' +
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

  btn.addEventListener('click', () => {
    q = (input.value || '').trim();
    page = 1;
    load();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      input.value = (t || '').trim();
      q = input.value;
      page = 1;
      load();
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
