'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const form = $('#chat-form');
  const input = $('#chat-input');
  const send = $('#send-button');
  const messagesNode = $('#messages');
  const statusNode = $('#chat-status');
  const quickPrompts = $('#quick-prompts');
  const clearButton = $('#clear-chat');
  const historyButton = $('#chat-history');
  const historyDialog = $('#chat-history-dialog');
  const historyList = $('#history-list');
  const closeHistoryButton = $('#close-history');
  const themeButton = $('#theme-toggle');
  const attachButton = $('#attach-image');
  const recordVoiceButton = $('#record-voice');
  const imageInput = $('#image-input');
  const imagePreview = $('#image-preview');
  const imagePreviewImage = $('#image-preview-image');
  const imagePreviewName = $('#image-preview-name');
  const imagePreviewSize = $('#image-preview-size');
  const removeImageButton = $('#remove-image');
  const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_OUTPUT_IMAGE_BYTES = 3 * 1024 * 1024;
  const state = { csrfToken: '', clientId: '', conversationId: '', history: [], busy: false, voiceBusy: false, image: null, recorder: null, stream: null, chunks: [], recordingStartedAt: 0, recordingTimer: null };
  const MAX_RECORDING_MS = 60 * 1000;
  const CONVERSATIONS_KEY = 'qadir-chat-conversations-v1';
  const welcomeText = 'أهلًا بك. أستطيع شرح أسئلة القدرات والتحصيلي، أو مساعدتك بخطة مذاكرة وحل خطوة بخطوة. ما سؤالك؟';
  function readConversations() { try { const value = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
  function writeConversations(items) { try { localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(items.slice(0, 30))); } catch {} }
  function saveCurrentConversation() {
    if (state.history.length < 2) return;
    const firstUser = state.history.find(item => item.role === 'user');
    if (!firstUser) return;
    const items = readConversations().filter(item => item.id !== state.conversationId);
    items.unshift({ id: state.conversationId || crypto.randomUUID(), title: firstUser.content.slice(0, 58), updatedAt: new Date().toISOString(), history: state.history.slice(-40) });
    state.conversationId = items[0].id;
    writeConversations(items);
  }
  function renderHistoryList() {
    historyList.replaceChildren();
    const items = readConversations();
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = 'لا توجد محادثات محفوظة بعد.'; historyList.append(empty); return; }
    items.forEach(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
      const title = document.createElement('strong'); title.textContent = item.title || 'محادثة بدون عنوان';
      const date = document.createElement('span'); date.textContent = new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.updatedAt));
      button.append(title, date); button.addEventListener('click', () => loadConversation(item)); historyList.append(button);
    });
  }
  function loadConversation(item) {
    window.speechSynthesis?.cancel(); state.conversationId = item.id; state.history = Array.isArray(item.history) ? item.history.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string') : [];
    messagesNode.replaceChildren(); appendMessage('assistant', welcomeText, true); state.history.forEach(message => appendMessage(message.role, message.content));
    quickPrompts.hidden = state.history.length > 0; historyDialog.close(); showStatus('تم فتح المحادثة السابقة.'); updateControls();
  }

  function setTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    themeButton.textContent = value === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن';
    try { localStorage.setItem('qadir-theme-v1', value); } catch {}
  }
  function getClientId() {
    try {
      let id = sessionStorage.getItem('qadir-chat-client-v1');
      if (!id) {
        id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('qadir-chat-client-v1', id);
      }
      return id;
    } catch {
      return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '00000000000000000000000000000000';
    }
  }
  function showStatus(message, type = '') {
    statusNode.textContent = message;
    statusNode.className = `chat-status${type ? ` ${type}` : ''}`;
  }
  function updateControls() {
    send.disabled = state.busy || state.voiceBusy || !state.csrfToken || (!input.value.trim() && !state.image);
    send.textContent = state.busy ? 'جارٍ التفكير…' : 'إرسال';
    input.disabled = state.busy;
    attachButton.disabled = state.busy || state.voiceBusy;
    recordVoiceButton.disabled = state.busy || state.voiceBusy;
    imageInput.disabled = state.busy;
    removeImageButton.disabled = state.busy;
    clearButton.disabled = state.busy;
    quickPrompts.querySelectorAll('button').forEach(button => { button.disabled = state.busy; });
    form.setAttribute('aria-busy', String(state.busy));
  }
  function appendMessage(role, text, isWelcome = false, imageDataUrl = '') {
    const article = document.createElement('article');
    article.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}`;
    if (isWelcome) article.dataset.welcome = 'true';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'أنت' : 'مساعد قادر';
    const body = document.createElement('div');
    body.className = 'message-text';
    body.textContent = text;
    article.append(label);
    if (imageDataUrl) {
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = imageDataUrl;
      image.alt = 'الصورة التي أرفقتها للسؤال';
      image.loading = 'lazy';
      article.append(image);
    }
    article.append(body);
    if (role === 'assistant' && !isWelcome) {
      const listen = document.createElement('button');
      listen.type = 'button'; listen.className = 'listen-button'; listen.textContent = 'استماع';
      listen.setAttribute('aria-label', 'استماع إلى الإجابة بصوت');
      listen.addEventListener('click', () => {
        if (!('speechSynthesis' in window)) { showStatus('ميزة الاستماع غير مدعومة في هذا المتصفح.', 'error'); return; }
        if (listen.textContent === 'إيقاف الصوت') { window.speechSynthesis.cancel(); listen.textContent = 'استماع'; return; }
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ar-SA'; utterance.rate = 0.95; utterance.pitch = 1;
        listen.textContent = 'إيقاف الصوت';
        utterance.onend = utterance.onerror = () => { listen.textContent = 'استماع'; };
        window.speechSynthesis.speak(utterance);
      });
      article.append(listen);
    }
    messagesNode.append(article);
    messagesNode.scrollTop = messagesNode.scrollHeight;
    return article;
  }
  function clearAttachment() {
    state.image = null;
    imageInput.value = '';
    imagePreview.hidden = true;
    imagePreviewImage.removeAttribute('src');
    imagePreviewName.textContent = '';
    imagePreviewSize.textContent = '';
  }
  function renderAttachment() {
    imagePreview.hidden = !state.image;
    if (!state.image) return;
    imagePreviewImage.src = state.image.dataUrl;
    imagePreviewImage.alt = `معاينة الصورة: ${state.image.name}`;
    imagePreviewName.textContent = state.image.name;
    imagePreviewSize.textContent = `${(state.image.size / 1024).toFixed(0)} كيلوبايت بعد الضغط`;
  }
  function toBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('تعذر ضغط الصورة على هذا الجهاز.')), 'image/jpeg', quality));
  }
  function toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر قراءة الصورة.'));
      reader.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      reader.readAsDataURL(blob);
    });
  }
  async function compressImage(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('اختر صورة PNG أو JPEG أو WebP فقط.');
    if (file.size < 1 || file.size > MAX_INPUT_FILE_BYTES) throw new Error('حجم الصورة الأصلية يجب ألا يتجاوز 10 ميغابايت.');
    if (typeof createImageBitmap !== 'function') throw new Error('متصفحك لا يدعم ضغط الصور؛ حدّث المتصفح وحاول مجددًا.');
    const bitmap = await createImageBitmap(file);
    try {
      for (const [maxSide, quality] of [[2000, 0.88], [1600, 0.78], [1200, 0.68]]) {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('تعذر تجهيز الصورة.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await toBlob(canvas, quality);
        canvas.width = 1; canvas.height = 1;
        if (blob.size <= MAX_OUTPUT_IMAGE_BYTES) return { blob, dataUrl: await toDataUrl(blob) };
      }
      throw new Error('تعذر ضغط الصورة إلى الحجم المسموح؛ اختر صورة أصغر.');
    } finally { bitmap.close?.(); }
  }
  async function initialize() {
    let theme = 'light';
    try { theme = localStorage.getItem('qadir-theme-v1') || 'light'; } catch {}
    setTheme(theme);
    state.clientId = getClientId();
    state.conversationId = crypto.randomUUID();
    themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || typeof data.csrfToken !== 'string') throw new Error('تعذر تهيئة جلسة آمنة. حدّث الصفحة وحاول مجددًا.');
      state.csrfToken = data.csrfToken;
      showStatus('المساعد جاهز. اكتب سؤالًا أو أرفق صورة أو سجل سؤالك صوتيًا.');
    } catch (error) {
      showStatus(error.message || 'تعذر الاتصال بالخدمة. حدّث الصفحة وحاول مجددًا.', 'error');
    }
    updateControls();
  }
  async function sendMessage(message) {
    if (state.busy || state.voiceBusy || !state.csrfToken || (!message && !state.image)) return;
    const image = state.image;
    const userText = message || (image ? 'اشرح السؤال الظاهر في الصورة ضمن القدرات أو التحصيلي.' : '');
    state.busy = true;
    const previousHistory = state.history.slice(-8);
    const userBubble = appendMessage('user', userText, false, image?.dataUrl || '');
    showStatus('جارٍ إعداد شرح مناسب…');
    updateControls();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken },
        body: JSON.stringify({ message: userText, history: previousHistory, clientId: state.clientId, image: image?.dataUrl || null }),
        signal: AbortSignal.timeout(60000)
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.error || 'تعذر الحصول على إجابة. أبقينا السؤال والصورة لتتمكن من إعادة المحاولة.');
      if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('لم تصل إجابة مكتملة. أبقينا السؤال والصورة لتتمكن من إعادة المحاولة.');
      state.history.push({ role: 'user', content: userText }, { role: 'assistant', content: data.answer });
      state.history = state.history.slice(-40);
      saveCurrentConversation();
      appendMessage('assistant', data.answer);
      input.value = '';
      clearAttachment();
      quickPrompts.hidden = true;
      showStatus('');
    } catch (error) {
      userBubble.remove();
      showStatus(error.name === 'TimeoutError' ? 'تأخر الرد. سؤالك وصورتك محفوظان في هذه الصفحة؛ حاول الإرسال مرة أخرى.' : error.message || 'تعذر الاتصال. سؤالك وصورتك ما زالا هنا لإعادة المحاولة.', 'error');
    } finally {
      state.busy = false;
      updateControls();
      if (!state.busy && !input.value) input.focus({ preventScroll: true });
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage(input.value.trim());
  });
  input.addEventListener('input', updateControls);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  attachButton.addEventListener('click', () => { if (!state.busy) imageInput.click(); });
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    showStatus('جارٍ ضغط الصورة وتجهيزها…');
    attachButton.disabled = true;
    try {
      const result = await compressImage(file);
      state.image = { dataUrl: result.dataUrl, name: file.name.slice(0,120), size: result.blob.size };
      renderAttachment();
      showStatus('أُرفقت الصورة. اكتب سؤالك أو أرسلها مباشرة.');
    } catch (error) {
      imageInput.value = '';
      showStatus(error.message || 'تعذر إرفاق الصورة.', 'error');
    } finally { attachButton.disabled = false; updateControls(); }
  });
  removeImageButton.addEventListener('click', () => {
    clearAttachment();
    showStatus('تمت إزالة الصورة.');
    updateControls();
  });
  function recordingMimeType() {
    return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported?.(type)) || '';
  }
  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  }
  function blobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر قراءة التسجيل.'));
      reader.onerror = () => reject(new Error('تعذر قراءة التسجيل.'));
      reader.readAsDataURL(blob);
    });
  }
  async function transcribeAndSend(blob) {
    if (blob.size < 1 || blob.size > 8 * 1024 * 1024) throw new Error('حجم التسجيل يجب ألا يتجاوز 8 ميغابايت.');
    state.voiceBusy = true; updateControls(); showStatus('جارٍ تحويل التسجيل إلى نص…');
    try {
      const response = await fetch('/api/chat/transcribe', { method:'POST', credentials:'same-origin', cache:'no-store', headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken}, body:JSON.stringify({audio:await blobAsDataUrl(blob),clientId:state.clientId}), signal:AbortSignal.timeout(60000) });
      let data = {}; try { data = await response.json(); } catch {}
      if (!response.ok || typeof data.text !== 'string' || !data.text.trim()) throw new Error(data.error || 'تعذر فهم التسجيل الصوتي.');
      input.value = data.text.trim().slice(0, 1500);
      state.voiceBusy = false; updateControls();
      await sendMessage(input.value);
    } finally { state.voiceBusy = false; updateControls(); }
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('تسجيل الصوت غير مدعوم في هذا المتصفح.');
    const mime = recordingMimeType();
    if (!mime) throw new Error('صيغة التسجيل غير مدعومة في هذا المتصفح.');
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = []; state.recordingStartedAt = Date.now();
    state.recorder = new MediaRecorder(state.stream, { mimeType: mime });
    state.recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = async () => {
      clearInterval(state.recordingTimer); state.recordingTimer = null;
      state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
      const blob = new Blob(state.chunks, { type: mime }); state.recorder = null; state.chunks = [];
      recordVoiceButton.classList.remove('is-recording'); recordVoiceButton.textContent = 'تسجيل صوتي'; recordVoiceButton.setAttribute('aria-pressed','false');
      try { await transcribeAndSend(blob); } catch (error) { state.voiceBusy = false; showStatus(error.message || 'تعذر تحويل التسجيل.', 'error'); updateControls(); }
    };
    state.recorder.start(); recordVoiceButton.classList.add('is-recording'); recordVoiceButton.textContent = 'إيقاف التسجيل'; recordVoiceButton.setAttribute('aria-pressed','true');
    showStatus('جارٍ التسجيل… اضغط إيقاف عند الانتهاء.'); updateControls();
    state.recordingTimer = setInterval(() => { const elapsed = Date.now() - state.recordingStartedAt; if (elapsed >= MAX_RECORDING_MS) stopRecording(); else recordVoiceButton.textContent = `إيقاف التسجيل (${Math.ceil((MAX_RECORDING_MS - elapsed) / 1000)}ث)`; }, 250);
  }
  recordVoiceButton.addEventListener('click', async () => {
    if (state.recorder?.state === 'recording') return stopRecording();
    if (state.busy || state.voiceBusy) return;
    try { await startRecording(); } catch (error) { state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; showStatus(error.message || 'تعذر بدء التسجيل.', 'error'); updateControls(); }
  });
  quickPrompts.addEventListener('click', event => {
    const button = event.target.closest('[data-prompt]');
    if (!button || state.busy) return;
    input.value = button.dataset.prompt || '';
    updateControls();
    form.requestSubmit();
  });
  clearButton.addEventListener('click', () => {
    saveCurrentConversation(); window.speechSynthesis?.cancel(); state.conversationId = crypto.randomUUID(); state.history = []; clearAttachment(); messagesNode.replaceChildren(); appendMessage('assistant', welcomeText, true); quickPrompts.hidden = false; showStatus('بدأت محادثة جديدة.'); input.value = ''; updateControls(); input.focus({ preventScroll: true });
  });
  historyButton.addEventListener('click', () => { renderHistoryList(); historyDialog.showModal(); });
  closeHistoryButton.addEventListener('click', () => historyDialog.close());
  historyDialog.addEventListener('click', event => { if (event.target === historyDialog) historyDialog.close(); });
  if (location.hash === '#history') { setTimeout(() => { renderHistoryList(); historyDialog.showModal(); }, 0); }
  initialize();
})();
