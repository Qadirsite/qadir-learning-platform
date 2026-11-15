'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const form = $('#contact-form');
  const status = $('#contact-status');
  const button = $('#contact-submit');
  const fileInput = $('#contact-files');
  const fileList = $('#contact-file-list');
  const defaultType = 'application/octet-stream';
  let csrf = '';
  let selected = [];
  async function token() {
    if (csrf) return csrf;
    const response = await fetch('/api/auth/session', { credentials:'same-origin', cache:'no-store' });
    const data = await response.json();
    if (!response.ok || !data.csrfToken) throw new Error('تعذر بدء جلسة آمنة لإرسال الرسالة.');
    csrf = data.csrfToken; return csrf;
  }
  function renderFiles() {
    fileList.replaceChildren(...selected.map((file, index) => {
      const row = document.createElement('div'); row.className = 'attachment-row';
      const label = document.createElement('span'); label.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} ميغابايت`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = 'إزالة';
      remove.addEventListener('click', () => { selected.splice(index, 1); renderFiles(); });
      row.append(label, remove); return row;
    }));
  }
  fileInput.addEventListener('change', () => {
    for (const file of [...fileInput.files]) {
      if (selected.length < 3 && !selected.some(item => item.name === file.name && item.size === file.size)) selected.push(file);
    }
    fileInput.value = ''; renderFiles();
  });
  async function upload(file, csrfToken) {
    const presign = await fetch('/api/contact/attachments/presign', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken}, body:JSON.stringify({name:file.name,type:file.type || defaultType,size:file.size}) });
    const signed = await presign.json(); if (!presign.ok) throw new Error(signed.error || 'تعذر تجهيز رفع المرفق.');
    const upload = await fetch('/api/storage/upload', { method:'PUT', headers:{'Content-Type':file.type || defaultType,'X-CSRF-Token':csrfToken,'X-Upload-Key':signed.key}, body:file });
    if (!upload.ok) throw new Error(`تعذر رفع الملف ${file.name}.`);
    return { name:file.name, type:file.type || defaultType, size:file.size, key:signed.key };
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true;
    status.textContent = selected.length ? 'جارٍ رفع المرفقات وإرسال رسالتك…' : 'جارٍ إرسال رسالتك…';
    try {
      const csrfToken = await token(); const attachments = [];
      for (const file of selected) attachments.push(await upload(file, csrfToken));
      const payload = { name:$('#contact-name').value.trim(), email:$('#contact-email').value.trim(), subject:$('#contact-subject').value.trim(), message:$('#contact-message').value.trim(), attachments };
      const response = await fetch('/api/contact', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken}, body:JSON.stringify(payload) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر إرسال الرسالة.');
      form.reset(); selected = []; renderFiles(); status.textContent = 'وصلت رسالتك ومرفقاتك إلى فريق قادر. شكرًا لك.';
    } catch (error) { status.textContent = `${error.message} احتفظنا بالنص لتتمكن من المحاولة مجددًا.`; }
    finally { button.disabled = false; }
  });
})();
