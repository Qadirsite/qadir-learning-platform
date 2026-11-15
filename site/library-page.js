'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  let items = [];
  const labels = { lesson: 'درس', resource: 'مورد', question: 'سؤال تدريبي', announcement: 'إعلان', faq: 'سؤال شائع' };

  function card(item) {
    const article = document.createElement('article');
    article.className = 'content-card';
    if (item.cover_url) {
      const image = document.createElement('img');
      image.src = item.cover_url;
      image.alt = '';
      image.loading = 'lazy';
      article.append(image);
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = labels[item.kind] || 'محتوى';
    const title = document.createElement('h2');
    title.textContent = item.title_ar;
    const text = String(item.body_ar || '');
    const excerpt = document.createElement('p');
    excerpt.textContent = text.slice(0, 220) + (text.length > 220 ? '…' : '');
    const open = document.createElement('a');
    open.href = `/content/${encodeURIComponent(item.slug)}`;
    open.className = 'button';
    open.textContent = 'قراءة المحتوى';
    article.append(tag, title, excerpt, open);
    return article;
  }

  function render() {
    const query = $('#library-search').value.trim().toLocaleLowerCase('ar');
    const kind = $('#library-kind').value;
    const filtered = items.filter(item => (!kind || item.kind === kind) && (!query || `${item.title_ar} ${item.title_en || ''} ${item.body_ar} ${item.category || ''}`.toLocaleLowerCase('ar').includes(query)));
    const target = $('#library-list');
    target.replaceChildren(...(filtered.length ? filtered.map(card) : [Object.assign(document.createElement('p'), { className: 'empty-state', textContent: 'لا يوجد محتوى منشور يطابق البحث.' })]));
  }

  async function load() {
    try {
      const response = await fetch('/api/content?limit=100', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'تعذر تحميل المكتبة.');
      items = data.items || [];
      render();
    } catch (error) {
      $('#library-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: error.message }));
    }
  }

  $('#library-search').addEventListener('input', render);
  $('#library-kind').addEventListener('change', render);
  load();
})();
