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
        if (g) g.textContent = (res.goldBalance || 0).toLocaleString('ar-SA');
        if (c) c.textContent = (res.crystalBalance || 0).toLocaleString('ar-SA');
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
  }

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
    var salaryOpt = document.getElementById('sellSalaryOpt');
    var agencyOpt = document.getElementById('sellAgencyOpt');
    if (salaryOpt) salaryOpt.classList.toggle('hidden', t === 'sub_agent');
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
        else if (r.purchase_source === 'company' && r.purchase_company_name) buyer = 'شركة: ' + r.purchase_company_name;
        else if (r.purchase_source === 'administration') buyer = 'الإدارة';
        var pm = r.payment_method === 'cash' ? 'كاش' : r.payment_method === 'debt' ? 'دين' : r.payment_method === 'salary_deduction' ? 'خصم من راتب' : r.payment_method === 'agency_deduction' ? 'خصم من نسبة الوكالة' : r.payment_method;
        return '<div class="p-4 rounded-xl border border-slate-100 bg-slate-50/50 flex flex-wrap justify-between items-center gap-2">' +
          '<div><span class="font-semibold ' + (r.type === 'buy' ? 'text-blue-600' : 'text-emerald-600') + '">' + typeLabel + '</span> ' + itemLabel + ' | ' + r.quantity + ' × ' + r.unit_price + ' = ' + r.total + '</div>' +
          '<div class="text-sm text-slate-600">' + buyer + ' | ' + pm + ' | ' + statusLabel + '</div>' +
          '<div class="text-xs text-slate-400">' + date + '</div>' +
          '</div>';
      }).join('');
    });
  };

  document.addEventListener('DOMContentLoaded', function() {
    loadBalance();
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
