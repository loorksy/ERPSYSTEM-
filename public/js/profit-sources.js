(function() {
  'use strict';

  /** تسميات عربية لـ source_type في دفتر صافي الربح (وما قد يُضاف لاحقاً) */
  var NET_PROFIT_SOURCE_LABELS = {
    fx_spread_profit: 'ربح فرق التصريف',
    audit_cycle_profits: 'أرباح تدقيق الدورة (Y+Z و W)',
    audit_management_yz: 'أرباح الإدارة: أعمدة Y+Z',
    audit_management_w: 'أرباح الإدارة: عمود W',
    transfer_discount_profit: 'ربح نسبة خصم التحويل',
    cycle_creation_discount_profit: 'ربح خصم التحويل (إنشاء دورة)',
    accreditation_brokerage: 'وساطة معتمدين',
    admin_brokerage: 'وساطة إدارية',
    shipping_sale_profit: 'ربح بيع شحن',
    sub_agency_share: 'حصة وكالة فرعية',
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

  function labelForSourceType(code) {
    var k = (code == null ? '' : String(code)).trim();
    if (!k) return '—';
    if (NET_PROFIT_SOURCE_LABELS[k]) return NET_PROFIT_SOURCE_LABELS[k];
    return k.replace(/_/g, ' ');
  }

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(function(r) { return r.json(); });
  }
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  document.addEventListener('DOMContentLoaded', function() {
    var box = document.getElementById('profitSourcesBox');
    if (!box) return;
    apiCall('/api/expenses/net-profit-by-source').then(function(res) {
      if (!res.success) {
        box.innerHTML = '<p class="p-8 text-center text-sm text-red-600">' + (res.message || 'فشل') + '</p>';
        return;
      }
      var rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML = '<p class="p-8 text-center text-sm text-slate-400">لا توجد قيود صافي ربح بعد</p>';
        return;
      }
      box.innerHTML =
        '<div class="rounded-xl border border-slate-200 overflow-hidden bg-slate-50/50">' +
        '<table class="w-full text-right text-sm">' +
        '<thead><tr class="bg-slate-100/90 text-slate-700 border-b border-slate-200">' +
        '<th class="px-4 py-2.5 font-semibold text-xs">اسم العملية</th>' +
        '<th class="px-4 py-2.5 font-semibold text-xs">الإجمالي</th></tr></thead><tbody class="bg-white">' +
        rows.map(function(r) {
          var code = r.source_type || '';
          var title = labelForSourceType(code);
          return '<tr class="border-b border-slate-100 hover:bg-slate-50/80">' +
            '<td class="px-4 py-2.5 text-sm text-slate-800" title="' + escapeHtml(code) + '">' + escapeHtml(title) + '</td>' +
            '<td class="px-4 py-2.5 font-semibold tabular-nums text-indigo-700">' + fmt(r.total) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    });
  });
})();
