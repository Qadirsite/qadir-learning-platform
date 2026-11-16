(function(){
  'use strict';
  function textNodes(root){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(node){
      const parent=node.parentElement; return parent&&![ 'SCRIPT','STYLE','NOSCRIPT'].includes(parent.tagName)&&node.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
    }}); const nodes=[]; let node; while((node=walker.nextNode()))nodes.push(node); return nodes;
  }
  function apply(item){
    const original=String(item.original_title_ar||'').trim(), title=String(item.title_ar||original).trim(); if(!original||!title)return;
    for(const node of textNodes(document.body)) if(node.nodeValue.includes(original)) node.nodeValue=node.nodeValue.split(original).join(title);
    if(!item.youtube_url)return;
    const match=textNodes(document.body).find(node=>node.nodeValue.includes(title)); if(!match||match.parentElement.querySelector('.qadir-lesson-video'))return;
    const link=document.createElement('a'); link.className='qadir-lesson-video'; link.href=item.youtube_url; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='▶ شاهد شرح الدرس على يوتيوب';
    link.style.cssText='display:inline-flex;align-items:center;margin-top:10px;padding:8px 13px;border-radius:999px;background:#dc2626;color:#fff;font:800 12px system-ui,sans-serif;text-decoration:none';
    match.parentElement.appendChild(link);
  }
  async function load(){
    try{const response=await fetch('/api/student-lessons',{cache:'no-store'});if(!response.ok)return;const data=await response.json();
      for(const item of data.items||[])apply(item);
      for(const node of textNodes(document.body)) if(node.nodeValue.includes('30 درسًا')) node.nodeValue=node.nodeValue.replaceAll('30 درسًا','37 درسًا');
      for(const node of textNodes(document.body)) if(node.nodeValue.includes('30 درس')) node.nodeValue=node.nodeValue.replaceAll('30 درس','37 درس');
    }catch{}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(load,350));else setTimeout(load,350);
})();
