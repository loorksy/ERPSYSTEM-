(function() {
  'use strict';

  function showToast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else alert(msg);
  }

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(r => r.json());
  }

  function loadBalance() {
    apiCall('/api/shipping/balance').then(function(res) {
      if (res.success) {
        var g = document.getElementById('shippingGoldBalance');
        var c = document.getElementById('shippingCrystalBalance');
        if (g) g.textContent = (window.formatMoney || function(n){ return (n||0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $'; })(res.goldBalance || 0);
        if (c) c.textContent = (window.formatMoney || function(n){ return (n||0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $'; })(res.crystalBalance || 0);
      }
    });
  }

  function loadSellDropdowns() {
    apiCall('/api/shipping/approved').then(function(res) {
      var sel = document.getElementById('sellApprovedId');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر المعتمد --</option>';
      (res.list || []).forEach(function(a) {
        sel.innerHTML += '<option value="' + a.id + '">' + (a.name || '') + '</option>';
      });
    });
    apiCall('/api/shipping/sub-agencies').then(function(res) {
      var sel = document.getElementById('sellSubAgencyId');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر الوكالة --</option>';
      (res.list || []).forEach(function(a) {
        sel.innerHTML += '<option value="' + a.id + '">' + (a.name || '') + '</option>';
      });
    });
    apiCall('/api/shipping/users').then(function(res) {
      var sel = document.getElementById('sellSalaryUserId');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر المستخدم --</option>';
      (res.list || []).forEach(function(u) {
        sel.innerHTML += '<option value="' + (u.id || u.name) + '">' + (u.name || u.id) + '</option>';
      });
    });
    apiCall('/api/shipping/carriers').then(function(res) {
      var sel = document.getElementById('sellCarrierId');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- وكالة الشحن --</option>';
      (res.list || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || '') + '</option>';
      });
    });
  }

  function loadCarrierCards() {
    var box = document.getElementById('shippingCarrierCards');
    if (!box) return;
    apiCall('/api/shipping/carriers').then(function(res) {
      var list = res.list || [];
      if (list.length === 0) {
        box.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 px-6 rounded-3xl border border-dashed border-slate-200 bg-gradient-to-b from-slate-50 to-white">' +
          '<div class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600 shadow-inner"><i class="fas fa-truck-moving text-2xl"></i></div>' +
          '<p class="text-slate-700 font-semibold mb-1">لا توجد وكالات بعد</p>' +
          '<p class="text-sm text-slate-500 text-center max-w-sm">أضف وكالة شحن لعرض الرصيد وسجل الحركات من الزر أعلاه.</p></div>';
        return;
      }
      box.innerHTML = list.map(function(c) {
        return '<div class="group relative overflow-hidden rounded-2xl border border-slate-100 bg-white p-5 cursor-pointer shadow-sm hover:shadow-[0_12px_32px_rgba(79,70,229,0.12)] hover:border-indigo-200 hover:-translate-y-0.5 transition-all duration-300" onclick="shippingOpenCarrierDetail(' + c.id + ')">' +
          '<div class="absolute top-0 left-0 h-full w-1 rounded-r-full bg-gradient-to-b from-indigo-600 to-cyan-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>' +
          '<div class="flex items-start gap-4">' +
          '<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-500 text-white shadow-[0_6px_18px_rgba(79,70,229,0.35)]"><i class="fas fa-truck text-lg"></i></div>' +
          '<div class="min-w-0 flex-1">' +
          '<h5 class="font-bold text-slate-800 text-base leading-snug">' + (c.name || '') + '</h5>' +
          '<p class="text-xs text-slate-500 mt-1.5 flex items-center gap-1"><i class="fas fa-receipt text-[10px]"></i> عرض السجل والحركات</p></div>' +
          '<span class="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-400 group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-colors"><i class="fas fa-chevron-left text-xs"></i></span></div></div>';
      }).join('');
    });
  }

  var SHIP_TAB_INACTIVE = 'shipping-tab-link flex flex-1 min-w-0 items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-slate-600 bg-transparent hover:bg-white transition-all duration-200';
  var SHIP_TAB_ACTIVE = 'shipping-tab-link flex flex-1 min-w-0 items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-br from-indigo-600 to-indigo-700 shadow-[0_4px_16px_rgba(79,70,229,0.28)] transition-all duration-200';

  window.switchShippingTab = function(btn, tabId) {
    var card = document.querySelector('[data-tabs-container="shipping"]');
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
    }
    card.querySelectorAll('.shipping-tab-link').forEach(function(b) {
      b.className = SHIP_TAB_INACTIVE;
    });
    btn.className = SHIP_TAB_ACTIVE;
  };

  window.shippingOpenCarrierAdd = function() {
    document.getElementById('shippingCarrierAddModal').classList.remove('hidden');
    document.getElementById('shippingCarrierAddModal').classList.add('flex');
  };
  window.shippingCloseCarrierAdd = function() {
    document.getElementById('shippingCarrierAddModal').classList.add('hidden');
    document.getElementById('shippingCarrierAddModal').classList.remove('flex');
  };
  window.shippingOpenCarrierDetail = function(id) {
    apiCall('/api/shipping/carriers/' + id).then(function(res) {
      if (!res.success) return;
      document.getElementById('carrierDetailTitle').textContent = res.carrier.name || '';
      var tx = res.transactions || [];
      document.getElementById('carrierDetailTx').innerHTML = tx.map(function(t) {
        var dir = t.direction === 'in' ? 'وارد' : 'صادر';
        var dt = t.created_at ? new Date(t.created_at).toLocaleString('ar-SA') : '';
        return '<div class="p-3 rounded-lg border border-slate-100 flex justify-between gap-2"><span>' + dir + '</span><span>' +
          (t.amount != null ? t.amount : '') + ' / كمية: ' + (t.quantity != null ? t.quantity : '') + '</span><span class="text-xs text-slate-400">' + dt + '</span></div>';
      }).join('') || '<p class="text-slate-400">لا سجل</p>';
      document.getElementById('shippingCarrierDetailModal').classList.remove('hidden');
      document.getElementById('shippingCarrierDetailModal').classList.add('flex');
    });
  };
  window.shippingCloseCarrierDetail = function() {
    document.getElementById('shippingCarrierDetailModal').classList.add('hidden');
    document.getElementById('shippingCarrierDetailModal').classList.remove('flex');
  };

  function loadBuyDropdowns() {
    apiCall('/api/shipping/companies').then(function(res) {
      var sel = document.getElementById('buyCompanyId');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر الشركة --</option>';
      (res.list || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || '') + '</option>';
      });
    });
  }

  window.shippingSellBuyerTypeChange = function() {
    var t = document.getElementById('sellBuyerType').value;
    document.getElementById('sellUserFields').classList.toggle('hidden', t !== 'user');
    document.getElementById('sellApprovedFields').classList.toggle('hidden', t !== 'approved');
    document.getElementById('sellSubAgentFields').classList.toggle('hidden', t !== 'sub_agent');
    var cf = document.getElementById('sellCarrierFields');
    if (cf) cf.classList.toggle('hidden', t !== 'shipping_carrier');
    var salaryOpt = document.getElementById('sellSalaryOpt');
    var agencyOpt = document.getElementById('sellAgencyOpt');
    if (salaryOpt) salaryOpt.classList.toggle('hidden', t === 'sub_agent' || t === 'shipping_carrier');
    if (agencyOpt) agencyOpt.classList.toggle('hidden', t !== 'sub_agent');
    shippingSellPaymentChange();
  };

  window.shippingSellPaymentChange = function() {
    var pm = document.getElementById('sellPaymentMethod').value;
    var salaryFields = document.getElementById('sellSalaryFields');
    if (salaryFields) salaryFields.classList.toggle('hidden', pm !== 'salary_deduction');
  };

  window.shippingQuickAdd = function(type, selectId, label) {
    var name = prompt('أدخل ' + label);
    if (!name || !name.trim()) return;
    var url = type === 'approved' ? '/api/shipping/approved' : type === 'sub-agencies' ? '/api/shipping/sub-agencies' : '/api/shipping/companies';
    apiCall(url, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }).then(function(res) {
      if (!res.success) {
        showToast(res.message || 'فشل الإضافة', 'error');
        return;
      }
      showToast(res.message || 'تمت الإضافة', 'success');
      var newId = res.id;
      if (type === 'approved') {
        loadSellDropdowns();
        setTimeout(function() {
          var sel = document.getElementById(selectId);
          if (sel && newId) sel.value = newId;
        }, 300);
      } else if (type === 'sub-agencies') {
        loadSellDropdowns();
        setTimeout(function() {
          var sel = document.getElementById(selectId);
          if (sel && newId) sel.value = newId;
        }, 300);
      } else if (type === 'companies') {
        loadBuyDropdowns();
        setTimeout(function() {
          var sel = document.getElementById(selectId);
          if (sel && newId) sel.value = newId;
        }, 300);
      }
    });
  };

  window.shippingBuySourceChange = function() {
    var src = document.getElementById('buyPurchaseSource').value;
    document.getElementById('buyCompanyFields').classList.toggle('hidden', src !== 'company');
  };

  window.shippingOpenSellModal = function() {
    loadSellDropdowns();
    document.getElementById('shippingSellForm').reset();
    shippingSellBuyerTypeChange();
    document.getElementById('shippingSellModal').classList.remove('hidden');
    document.getElementById('shippingSellModal').classList.add('flex');
  };

  window.shippingCloseSellModal = function() {
    document.getElementById('shippingSellModal').classList.add('hidden');
    document.getElementById('shippingSellModal').classList.remove('flex');
  };

  window.shippingOpenBuyModal = function() {
    loadBuyDropdowns();
    document.getElementById('shippingBuyForm').reset();
    shippingBuySourceChange();
    document.getElementById('shippingBuyModal').classList.remove('hidden');
    document.getElementById('shippingBuyModal').classList.add('flex');
  };

  window.shippingCloseBuyModal = function() {
    document.getElementById('shippingBuyModal').classList.add('hidden');
    document.getElementById('shippingBuyModal').classList.remove('flex');
  };

  window.shippingOpenRecordModal = function() {
    document.getElementById('shippingRecordModal').classList.remove('hidden');
    document.getElementById('shippingRecordModal').classList.add('flex');
    shippingLoadRecord();
  };

  window.shippingCloseRecordModal = function() {
    document.getElementById('shippingRecordModal').classList.add('hidden');
    document.getElementById('shippingRecordModal').classList.remove('flex');
  };

  window.shippingLoadRecord = function() {
    var list = document.getElementById('shippingRecordList');
    list.innerHTML = '<p class="text-slate-400 text-center py-8">جاري التحميل...</p>';
    var params = new URLSearchParams();
    var type = document.getElementById('recordFilterType').value;
    var status = document.getElementById('recordFilterStatus').value;
    var from = document.getElementById('recordFilterFrom').value;
    var to = document.getElementById('recordFilterTo').value;
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    if (from) params.set('fromDate', from);
    if (to) params.set('toDate', to);
    apiCall('/api/shipping/transactions?' + params.toString()).then(function(res) {
      if (!res.success) {
        list.innerHTML = '<p class="text-red-500 text-center py-8">' + (res.message || 'فشل التحميل') + '</p>';
        return;
      }
      var rows = res.transactions || [];
      if (rows.length === 0) {
        list.innerHTML = '<p class="text-slate-400 text-center py-8">لا توجد عمليات</p>';
        return;
      }
      list.innerHTML = rows.map(function(r) {
        var typeLabel = r.type === 'buy' ? 'شراء' : 'بيع';
        var itemLabel = r.item_type === 'gold' ? 'ذهب' : 'كرستال';
        var statusLabel = r.status === 'debt' ? 'دين' : 'مكتملة';
        var date = r.created_at ? new Date(r.created_at).toLocaleDateString('ar-SA') : '-';
        var buyer = '';
        if (r.buyer_type === 'user' && r.buyer_user_id) buyer = 'مستخدم: ' + r.buyer_user_id;
        else if (r.buyer_type === 'approved' && r.buyer_approved_id) buyer = 'معتمد #' + r.buyer_approved_id;
        else if (r.buyer_type === 'sub_agent' && r.buyer_sub_agency_id) buyer = 'وكيل #' + r.buyer_sub_agency_id;
        else if (r.buyer_type === 'shipping_carrier' && r.buyer_carrier_id) buyer = 'وكالة شحن #' + r.buyer_carrier_id;
        else if (r.purchase_source === 'company' && r.purchase_company_name) buyer = 'شركة: ' + r.purchase_company_name;
        else if (r.purchase_source === 'administration') buyer = 'الإدارة';
        var pm = r.payment_method === 'cash' ? 'كاش' : r.payment_method === 'debt' ? 'دين' : r.payment_method === 'salary_deduction' ? 'خصم من راتب' : r.payment_method === 'agency_deduction' ? 'خصم من نسبة الوكالة' : r.payment_method;
        var profitLine = (r.type === 'sell' && r.profit_amount != null) ? ' | ربح: ' + (window.formatMoney ? window.formatMoney(r.profit_amount) : r.profit_amount) : '';
        return '<div class="p-4 rounded-xl border border-slate-100 bg-slate-50/50 flex flex-wrap justify-between items-center gap-2">' +
          '<div><span class="font-semibold ' + (r.type === 'buy' ? 'text-blue-600' : 'text-emerald-600') + '">' + typeLabel + '</span> ' + itemLabel + ' | كمية: ' + (r.quantity||0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' — إجمالي: ' + (window.formatMoney ? window.formatMoney(r.total) : (r.total||0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $') + profitLine + '</div>' +
          '<div class="text-sm text-slate-600">' + buyer + ' | ' + pm + ' | ' + statusLabel + '</div>' +
          '<div class="text-xs text-slate-400">' + date + '</div>' +
          '</div>';
      }).join('');
    });
  };

  document.getElementById('shippingCarrierAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    apiCall('/api/shipping/carriers', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('carrierAddName').value,
        amount: document.getElementById('carrierAddAmt').value,
        quantity: document.getElementById('carrierAddQty').value
      })
    }).then(function(res) {
      showToast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        shippingCloseCarrierAdd();
        loadCarrierCards();
        loadSellDropdowns();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', function() {
    loadBalance();
    loadCarrierCards();
    var sellForm = document.getElementById('shippingSellForm');
    if (sellForm) {
      sellForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var t = document.getElementById('sellBuyerType').value;
        var body = {
          buyerType: t,
          userNumber: t === 'user' ? document.getElementById('sellUserNumber').value : null,
          approvedId: t === 'approved' ? document.getElementById('sellApprovedId').value : null,
          subAgencyId: t === 'sub_agent' ? document.getElementById('sellSubAgencyId').value : null,
          carrierId: t === 'shipping_carrier' ? document.getElementById('sellCarrierId').value : null,
          itemType: document.getElementById('sellItemType').value,
          quantity: document.getElementById('sellQuantity').value,
          unitPrice: document.getElementById('sellUnitPrice').value,
          paymentMethod: document.getElementById('sellPaymentMethod').value,
          salaryDeductionUserId: document.getElementById('sellPaymentMethod').value === 'salary_deduction' ? document.getElementById('sellSalaryUserId').value : null,
          notes: document.getElementById('sellNotes').value
        };
        apiCall('/api/shipping/sell', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
          showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
          if (res.success) {
            shippingCloseSellModal();
            loadBalance();
          }
        });
      });
    }
    var buyForm = document.getElementById('shippingBuyForm');
    if (buyForm) {
      buyForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var src = document.getElementById('buyPurchaseSource').value;
        var companyId = document.getElementById('buyCompanyId').value;
        var companyName = document.getElementById('buyCompanyName').value;
        var body = {
          purchaseSource: src,
          companyId: src === 'company' ? companyId : null,
          companyName: src === 'company' ? (companyName || document.getElementById('buyCompanyId').options[document.getElementById('buyCompanyId').selectedIndex]?.text) : null,
          itemType: document.getElementById('buyItemType').value,
          quantity: document.getElementById('buyQuantity').value,
          unitPrice: document.getElementById('buyUnitPrice').value,
          paymentMethod: document.getElementById('buyPaymentMethod').value,
          notes: document.getElementById('buyNotes').value
        };
        if (src === 'company' && !companyId && !companyName) {
          showToast('اسم الشركة مطلوب', 'error');
          return;
        }
        apiCall('/api/shipping/buy', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
          showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
          if (res.success) {
            shippingCloseBuyModal();
            loadBalance();
          }
        });
      });
    }
  });

})();
