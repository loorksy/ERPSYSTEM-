(function () {
  'use strict';
  var root = document.getElementById('profitDetailRoot');
  if (!root) return;
  var st = (root.getAttribute('data-source') || '').trim();
  var box = document.getElementById('profitDetailBox');
  var titleEl = document.getElementById('profitDetailTitle');
  var codeEl = document.getElementById('profitDetailCode');

  var NET_PROFIT_SOURCE_LABELS = {
    fx_spread_profit: 'ربح فرق التصريف',
    audit_cycle_profits: 'أرباح تدقيق الدورة (مكافات شهرية وإيداع W في الصندوق)',
    audit_management_yz: 'أرباح المكافات الشهرية',
    audit_management_w: 'أرباح الإدارة: عمود W (أرشيف — لا يُنشأ قيد جديد)',
    transfer_discount_profit: 'ربح نسبة خصم التحويل',
    cycle_creation_discount_profit: 'ربح خصم التحويل (إنشاء دورة)',
    accreditation_brokerage: 'وساطة معتمدين',
    accreditation_payable_discount: 'ربح خصم دين علينا (معتمد)',
    admin_brokerage: 'وساطة إدارية',
    shipping_sale_profit: 'ربح بيع شحن',
    sub_agency_share: 'حصة وكالة فرعية',
    sub_agency_company_profit: 'ربح الشركة من نسبة الوكالات',
    manual_expense: 'مصروف يدوي',
    sub_agency_reward: 'مكافأة وكالة فرعية',
    agent_table_primary_seed: 'جدول الوكيل (رأس مال)',
    primary_agent_seed: 'رأس مال من جدول الوكيل',
    profit_transfer: 'ترحيل أرباح',
    fx_spread_disbursement: 'تصريف عملات',
    company_payout: 'صرف لشركة تحويل',
    fund_allocation: 'تحويل لصندوق',
    shipping_sale_cash: 'بيع شحن نقدي',
    shipping_buy_cash: 'شراء شحن نقدي',
  };
  function labelFor(code) {
    var k = (code == null ? '' : String(code)).trim();
    if (!k) return '—';
    if (NET_PROFIT_SOURCE_LABELS[k]) return NET_PROFIT_SOURCE_LABELS[k];
    return k.replace(/_/g, ' ');
  }
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (titleEl) titleEl.textContent = labelFor(st);
  if (codeEl) codeEl.textContent = st;

  function apiCall(url) {
    if (typeof window.apiCall === 'function') return window.apiCall(url);
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json();
    });
  }

  apiCall('/api/expenses/net-profit-by-source/' + encodeURIComponent(st) + '/detail').then(function (res) {
    if (!res.success || !box) {
      box.innerHTML = '<p class="p-8 text-center text-sm text-red-600">' + esc(res.message || 'فشل') + '</p>';
      return;
    }
    if (res.kind === 'shipping') {
      var rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML = '<p class="p-8 text-center text-sm text-slate-400">لا مبيعات بعد</p>';
        return;
      }
      box.innerHTML =
        '<div class="overflow-x-auto"><table class="w-full text-right text-sm">' +
        '<thead><tr class="bg-slate-100/90 text-slate-700 border-b border-slate-200">' +
        '<th class="px-3 py-2 text-xs">#</th><th class="px-3 py-2 text-xs">النوع</th><th class="px-3 py-2 text-xs">الكمية</th>' +
        '<th class="px-3 py-2 text-xs">الإجمالي</th><th class="px-3 py-2 text-xs">الربح</th><th class="px-3 py-2 text-xs">التاريخ</th></tr></thead><tbody>' +
        rows
          .map(function (r) {
            return (
              '<tr class="border-b border-slate-100">' +
              '<td class="px-3 py-2 font-mono text-xs">' +
              esc(r.id) +
              '</td>' +
              '<td class="px-3 py-2">' +
              esc(r.item_type) +
              '</td>' +
              '<td class="px-3 py-2 tabular-nums">' +
              esc(r.quantity) +
              '</td>' +
              '<td class="px-3 py-2 tabular-nums">' +
              fmt(r.total) +
              '</td>' +
              '<td class="px-3 py-2 tabular-nums text-emerald-700">' +
              fmt(r.profit_amount) +
              '</td>' +
              '<td class="px-3 py-2 text-xs text-slate-500">' +
              esc(r.created_at ? new Date(r.created_at).toLocaleString('ar') : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
      return;
    }
    var lrows = res.rows || [];
    if (!lrows.length) {
      box.innerHTML = '<p class="p-8 text-center text-sm text-slate-400">لا قيود لهذا المصدر</p>';
      return;
    }
    box.innerHTML =
      '<div class="overflow-x-auto"><table class="w-full text-right text-sm">' +
      '<thead><tr class="bg-slate-100/90 text-slate-700 border-b border-slate-200">' +
      '<th class="px-3 py-2 text-xs">#</th><th class="px-3 py-2 text-xs">المبلغ</th><th class="px-3 py-2 text-xs">الاتجاه</th>' +
      '<th class="px-3 py-2 text-xs">ملاحظات</th><th class="px-3 py-2 text-xs">التاريخ</th></tr></thead><tbody>' +
      lrows
        .map(function (r) {
          return (
            '<tr class="border-b border-slate-100">' +
            '<td class="px-3 py-2 font-mono text-xs">' +
            esc(r.id) +
            '</td>' +
            '<td class="px-3 py-2 tabular-nums">' +
            fmt(r.amount) +
            '</td>' +
            '<td class="px-3 py-2">' +
            esc(r.direction) +
            '</td>' +
            '<td class="px-3 py-2 text-xs max-w-[14rem] truncate" title="' +
            esc(r.notes) +
            '">' +
            esc(r.notes) +
            '</td>' +
            '<td class="px-3 py-2 text-xs text-slate-500">' +
            esc(r.created_at ? new Date(r.created_at).toLocaleString('ar') : '') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  });
})();
