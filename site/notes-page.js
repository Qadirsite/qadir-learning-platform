'use strict';
(() => {
  const app = document.querySelector('#notes-app');
  const state = { csrf:'', user:null, threads:[], busy:false, status:'' };
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const request = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const headers = {...(options.headers || {})};
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.csrf; }
    const response = await fetch(url, { ...options, method, headers, credentials:'same-origin', cache:'no-store' });
    let data = {}; try { data = await response.json(); } catch {}
    if (data.csrfToken) state.csrf = data.csrfToken;
    if (!response.ok) throw new Error(data.error || 'تعذر إتمام الطلب. حاول مرة أخرى.');
    return data;
  };
  const dateText = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(date); };
  function render() {
    if (!state.user) { app.innerHTML = '<div class="contact-form"><p class="status-message">يجب تسجيل الدخول بحساب طالب أولًا لرؤية ملاحظاتك وردود الإدارة.</p><a class="button primary" href="/">العودة للرئيسية وتسجيل الدخول</a></div>'; return; }
    const cards = state.threads.length ? state.threads.map(item => `<article class="note-card"><h2>${safe(item.subject)}</h2><p class="note-message"><b>ملاحظتك:</b> ${safe(item.message)}</p><p class="note-reply"><b>رد الإدارة:</b> ${safe(item.reply)}</p><small>${safe(dateText(item.updated_at || item.created_at))}</small></article>`).join('') : '<p class="status-message">لا توجد ردود بعد. أرسل أول ملاحظة وستظهر الإجابة هنا.</p>';
    app.innerHTML = `<form id="notes-form" class="contact-form"><h2 class="full">إرسال ملاحظة جديدة</h2><label class="form-field full">الموضوع<input id="notes-subject" maxlength="180" required placeholder="مثال: ملاحظة على درس"></label><label class="form-field full">الملاحظة أو السؤال<textarea id="notes-message" maxlength="6000" required placeholder="اكتب ملاحظتك هنا"></textarea></label><div class="full"><button class="button primary" type="submit" ${state.busy?'disabled':''}>${state.busy?'جارٍ الإرسال…':'إرسال الملاحظة للإدارة'}</button></div><p class="status-message full" role="status">${safe(state.status || 'ستظهر ردود الإدارة هنا بعد مراجعة ملاحظتك.')}</p></form><section class="notes-replies"><div class="section-heading"><div><div class="eyebrow">صندوق الردود</div><h2>ردود الإدارة على ملاحظاتك</h2></div><button id="notes-refresh" class="button" type="button">تحديث</button></div>${cards}</section>`;
    app.querySelector('#notes-form').addEventListener('submit', submit);
    app.querySelector('#notes-refresh').addEventListener('click', loadThreads);
  }
  async function loadThreads() { try { const data = await request('/api/contact/threads'); state.threads = data.items || []; render(); } catch (error) { state.status = error.message; render(); } }
  async function submit(event) {
    event.preventDefault(); if (state.busy) return;
    const subject = document.querySelector('#notes-subject').value.trim(); const message = document.querySelector('#notes-message').value.trim();
    if (!subject || !message) return;
    state.busy = true; render();
    try { await request('/api/contact',{method:'POST',body:JSON.stringify({name:state.user.username,email:'',subject,message})}); state.status = 'تم إرسال ملاحظتك. ستظهر الإجابة هنا بعد رد الإدارة.'; await loadThreads(); }
    catch (error) { state.status = error.message; }
    finally { state.busy = false; render(); }
  }
  async function init() { try { const session = await request('/api/auth/session'); state.user = session.user || null; if (state.user) await loadThreads(); else render(); } catch (error) { state.status = error.message; render(); } }
  init();
})();
