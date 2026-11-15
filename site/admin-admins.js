'use strict';
(() => {
  const target = document.querySelector('#admin-directory-list');
  const copyButton = document.querySelector('#copy-admin-names');
  let recipients = [];
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notify = message => { copyButton.textContent = message; window.setTimeout(() => { copyButton.textContent = 'نسخ أسماء الإداريين'; }, 1800); };
  copyButton?.addEventListener('click', async () => {
    if (!recipients.length) return notify('لا توجد أسماء');
    try { await navigator.clipboard.writeText(recipients.map(item => item.username).join('\n')); notify('تم نسخ الأسماء'); }
    catch { notify('تعذر النسخ'); }
  });
  async function load() {
    try {
      const response = await fetch('/api/admin/messages/recipients',{credentials:'same-origin',cache:'no-store'});
      const data = await response.json();
      if (response.status === 401) { location.href='/admin'; return; }
      if (!response.ok) throw new Error(data.error || 'تعذر تحميل الإداريين.');
      recipients = data.items || [];
      if (!recipients.length) { target.innerHTML='<div class="empty-state">لا يوجد إداريون ظاهرون لهذه الصلاحية.</div>'; return; }
      target.innerHTML = recipients.map(item => `<a class="recipient-card directory-card" href="/admin.html?section=internal-messages&recipient=${encodeURIComponent(item.username)}"><strong>${safe(item.username)}</strong><span>${safe(item.label || 'إداري')} · ${item.is_active ? 'نشط' : 'غير نشط'}</span><small>اختيار هذا الإداري ←</small></a>`).join('');
    } catch (error) { target.innerHTML=`<div class="empty-state">${safe(error.message)}</div>`; }
  }
  load();
})();
