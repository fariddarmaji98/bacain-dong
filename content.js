// Bacain Dong — content script (injected on demand by popup.js, after text.js)
(() => {
  if (window.__bacainDong) return;
  window.__bacainDong = true;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HIGHLIGHT_CLASS = 'bacain-dong-reading';
  // Short chunks: Chrome's remote voices can stall silently on utterances longer than ~15 s.
  const MAX_CHUNK = 160;
  // Parts of a page that are not worth reading aloud.
  const SKIP_SELECTOR = 'script,style,noscript,template,svg,canvas,iframe,select,textarea,input,button,'
    + 'nav,aside,footer,[role=navigation],[role=complementary],[role=contentinfo],[role=banner],[aria-hidden=true]';

  const ICON = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    stop: 'M6 6h12v12H6z',
    save: 'M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z',
    sync: 'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z',
  };

  const WIDGET_CSS = `
    .card { box-sizing: border-box; width: 244px; padding: 10px 12px 12px; background: #1f2430; color: #e8eaf0;
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .title { font-weight: 600; color: #8ab4ff; }
    .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
    .bar { height: 4px; margin-bottom: 10px; border-radius: 2px; background: #394055; overflow: hidden; }
    .fill { height: 100%; width: 0; background: #3b82f6; transition: width .15s; }
    .btns { display: flex; gap: 6px; }
    button { flex: 1; height: 32px; display: flex; align-items: center; justify-content: center; padding: 0;
      border: 0; border-radius: 8px; background: #2c3347; color: #e8eaf0; cursor: pointer; }
    button:hover:not(:disabled) { background: #3b82f6; }
    button:disabled { opacity: .5; cursor: default; }
    button[hidden] { display: none; }
    svg { width: 18px; height: 18px; fill: currentColor; }
    .status { margin-top: 8px; color: #b6bdd0; word-break: break-word; }
    .status:empty { display: none; }
  `;

  const PAGE_CSS = `.${HIGHLIGHT_CLASS} { background-color: rgba(255, 214, 10, .28) !important; box-shadow: 0 0 0 3px rgba(255, 214, 10, .28) !important; }`;

  let active = false;
  let host = null;
  let styleEl = null;
  let ui = {};
  let rafPending = false;
  let statusTimer = 0;
  let generation = 0; // bumped on every activate and deactivate, so replies to an older widget are dropped
  let syncPort = null;
  const busy = { draft: false, sync: false };
  const reader = freshReader();

  function freshReader() {
    return { state: 'idle', chunks: [], total: 0, index: 0, charIn: 0, done: false, session: 0, utterance: null, block: null };
  }

  // ---------- widget ----------

  function el(tag, props, ...kids) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  }

  function makeButton(label, path, onClick) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    const b = el('button', { type: 'button', title: label }, svg);
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function mount() {
    host = document.createElement('bacain-dong-widget');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    ui.pct = el('span', { className: 'pct', textContent: '0%' });
    ui.fill = el('div', { className: 'fill' });
    ui.status = el('div', { className: 'status' });
    ui.status.setAttribute('role', 'status');
    ui.play = makeButton('Play', ICON.play, play);
    ui.pause = makeButton('Pause', ICON.pause, pause);
    ui.pause.hidden = true;
    ui.stop = makeButton('Stop', ICON.stop, stop);
    ui.draft = makeButton('Save to draft', ICON.save, saveDraft);
    ui.sync = makeButton('Sync to Google Drive', ICON.sync, sync);

    shadow.append(
      el('style', { textContent: WIDGET_CSS }),
      el('div', { className: 'card' },
        el('div', { className: 'top' }, el('span', { className: 'title', textContent: 'Bacain Dong' }), ui.pct),
        el('div', { className: 'bar' }, ui.fill),
        el('div', { className: 'btns' }, ui.play, ui.pause, ui.stop, ui.draft, ui.sync),
        ui.status),
    );
    document.documentElement.append(host);
  }

  function say(text, ttl = 5000) {
    if (!ui.status) return;
    clearTimeout(statusTimer);
    ui.status.textContent = text;
    if (ttl) statusTimer = setTimeout(() => { if (ui.status) ui.status.textContent = ''; }, ttl);
  }

  // ---------- progress (scroll or read, whichever is further) ----------

  function scrollFraction() {
    const se = document.scrollingElement || document.documentElement;
    const max = se.scrollHeight - se.clientHeight;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, se.scrollTop / max));
  }

  function readFraction() {
    if (reader.state === 'idle') return reader.done ? 1 : 0;
    const c = reader.chunks[reader.index];
    if (!c || !reader.total) return 0;
    return Math.min(1, (c.start + Math.min(reader.charIn, c.text.length)) / reader.total);
  }

  function renderProgress() {
    rafPending = false;
    if (!active || !ui.pct) return;
    const pct = Math.round(Math.max(scrollFraction(), readFraction()) * 100);
    ui.pct.textContent = `${pct}%`;
    ui.fill.style.width = `${pct}%`;
  }

  function scheduleProgress() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(renderProgress);
  }

  // ---------- read aloud ----------

  function pickRoot() {
    const bodyLen = (document.body.innerText || '').length;
    let best = null;
    let bestLen = 0;
    for (const node of document.querySelectorAll('article, main, [role=main]')) {
      const len = (node.innerText || '').length;
      if (len > bestLen) { best = node; bestLen = len; }
    }
    return best && bestLen > 200 && bestLen > bodyLen * 0.4 ? best : document.body;
  }

  // Walk the readable text, group it by its nearest block-level ancestor, split into chunks.
  function collectChunks() {
    const root = pickRoot();
    const blockCache = new Map();
    const blocks = []; // { el, raw } in document order; adjacent text of one block is merged

    const blockFor = (node) => {
      let b = blockCache.get(node);
      if (!b) {
        b = node;
        while (b !== root && b.parentElement) {
          const d = getComputedStyle(b).display;
          if (!d.startsWith('inline') && d !== 'contents') break;
          b = b.parentElement;
        }
        blockCache.set(node, b);
      }
      return b;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (n.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (!n.checkVisibility({ checkVisibilityCSS: true })) {
          // display:contents has no box, so it reads as invisible, but its children render.
          return getComputedStyle(n).display === 'contents' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        }
        return n.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const b = blockFor(n.parentElement);
      const piece = n.nodeType === Node.TEXT_NODE ? n.nodeValue : ' ';
      const last = blocks[blocks.length - 1];
      if (last && last.el === b) last.raw += piece;
      else blocks.push({ el: b, raw: piece });
    }

    const chunks = [];
    let total = 0;
    for (const { el: node, raw } of blocks) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      for (const part of splitText(text, MAX_CHUNK)) {
        chunks.push({ el: node, text: part, start: total });
        total += part.length;
      }
    }
    return { chunks, total };
  }

  function firstVisibleIndex(chunks) {
    const i = chunks.findIndex((c) => c.el.getBoundingClientRect().bottom > 0);
    return i < 0 ? 0 : i;
  }

  function clearHighlight() {
    if (reader.block) reader.block.classList.remove(HIGHLIGHT_CLASS);
    reader.block = null;
  }

  function focusBlock(node) {
    if (reader.block === node) return;
    clearHighlight();
    if (node === document.body) return;
    reader.block = node;
    node.classList.add(HIGHLIGHT_CLASS);
    const r = node.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      node.scrollIntoView({ block: r.height > window.innerHeight ? 'start' : 'center', behavior: 'smooth' });
    }
  }

  function setState(state) {
    reader.state = state;
    if (ui.play) {
      ui.play.hidden = state === 'playing';
      ui.pause.hidden = state !== 'playing';
    }
    scheduleProgress();
  }

  function cancelSpeech() {
    reader.session++;
    reader.utterance = null;
    const synth = window.speechSynthesis;
    if (synth && (synth.speaking || synth.pending || synth.paused)) {
      synth.cancel();
      synth.resume();
    }
  }

  function speakFrom(i) {
    const session = reader.session;
    if (i >= reader.chunks.length) {
      clearHighlight();
      reader.done = true;
      setState('idle');
      say('Finished reading.');
      return;
    }
    reader.index = i;
    reader.charIn = 0;
    const chunk = reader.chunks[i];
    const u = new SpeechSynthesisUtterance(chunk.text);
    if (document.documentElement.lang) u.lang = document.documentElement.lang;
    u.onstart = () => {
      if (session !== reader.session) return;
      focusBlock(chunk.el);
      scheduleProgress();
    };
    u.onboundary = (e) => {
      if (session !== reader.session) return;
      reader.charIn = e.charIndex;
      scheduleProgress();
    };
    u.onend = () => {
      if (session === reader.session) speakFrom(i + 1);
    };
    u.onerror = (e) => {
      // Our own cancel() bumps the session first, so anything left here came from outside
      // (the page or another extension cancelled speech) and must not leave the UI on "playing".
      if (session !== reader.session) return;
      const external = e.error === 'interrupted' || e.error === 'canceled';
      stop();
      if (!external) say(`Speech error: ${e.error}`);
    };
    reader.utterance = u; // keep a reference: Chrome may garbage-collect a playing utterance
    window.speechSynthesis.speak(u);
  }

  function play() {
    if (!window.speechSynthesis) return say('Speech synthesis is not available on this page.');
    if (reader.state === 'paused') {
      window.speechSynthesis.resume();
      return setState('playing');
    }
    const { chunks, total } = collectChunks();
    if (!chunks.length) return say('Nothing to read on this page.');
    const fromStart = reader.done;
    cancelSpeech();
    Object.assign(reader, { chunks, total, done: false });
    setState('playing');
    speakFrom(fromStart ? 0 : firstVisibleIndex(chunks));
  }

  function pause() {
    if (reader.state !== 'playing') return;
    window.speechSynthesis.pause();
    setState('paused');
  }

  function stop() {
    cancelSpeech();
    clearHighlight();
    Object.assign(reader, { chunks: [], total: 0, index: 0, charIn: 0, done: false });
    setState('idle');
  }

  // ---------- draft + sync ----------

  async function saveDraft() {
    if (busy.draft) return;
    busy.draft = true;
    const gen = generation;
    ui.draft.disabled = true;
    say('Saving draft…', 0);
    clearHighlight(); // keep the reading highlight out of the saved copy
    try {
      const res = await chrome.runtime.sendMessage({ type: 'draft:save', title: document.title, url: location.href });
      if (gen !== generation) return;
      if (!res || !res.ok) throw new Error((res && res.error) || 'No response from extension.');
      say(`Draft saved: ${res.folder}`);
    } catch (e) {
      if (gen === generation) say(`Save failed: ${e.message || e}`, 8000);
    } finally {
      if (gen === generation) {
        busy.draft = false;
        ui.draft.disabled = false;
      }
    }
  }

  function syncSummary(m) {
    if (!m.total) return 'No drafts to sync yet.';
    let text = `Sync done: ${m.uploaded} uploaded, ${m.skipped} already in Drive.`;
    if (m.failed.length) text += ` ${m.failed.length} failed (${m.failed[0].id}: ${m.failed[0].error})`;
    return text;
  }

  function sync() {
    if (busy.sync) return;
    busy.sync = true;
    ui.sync.disabled = true;
    say('Starting sync…', 0);
    const gen = generation;
    const end = (text) => {
      if (gen !== generation) return;
      busy.sync = false;
      ui.sync.disabled = false;
      say(text, 10000);
      try { syncPort.disconnect(); } catch (e) { /* already closed */ }
      syncPort = null;
    };
    try {
      syncPort = chrome.runtime.connect({ name: 'sync' });
    } catch (e) {
      return end('Extension was reloaded. Refresh this page.');
    }
    syncPort.onMessage.addListener((m) => {
      if (m.type === 'progress') { if (gen === generation) say(m.text, 0); }
      else if (m.type === 'error') end(`Sync failed: ${m.message}`);
      else if (m.type === 'done') end(syncSummary(m));
    });
    syncPort.onDisconnect.addListener(() => { if (busy.sync) end('Sync interrupted.'); });
  }

  // ---------- activate / deactivate ----------

  function onPageHide() { stop(); }

  function activate() {
    if (active) return;
    active = true;
    generation++;
    styleEl = el('style', { textContent: PAGE_CSS });
    (document.head || document.documentElement).append(styleEl);
    mount();
    window.addEventListener('scroll', scheduleProgress, { passive: true });
    window.addEventListener('resize', scheduleProgress);
    window.addEventListener('pagehide', onPageHide);
    scheduleProgress();
  }

  function deactivate() {
    if (!active) return;
    stop();
    active = false;
    generation++;
    busy.draft = busy.sync = false;
    if (syncPort) { try { syncPort.disconnect(); } catch (e) { /* already closed */ } syncPort = null; }
    window.removeEventListener('scroll', scheduleProgress);
    window.removeEventListener('resize', scheduleProgress);
    window.removeEventListener('pagehide', onPageHide);
    clearTimeout(statusTimer);
    host.remove();
    styleEl.remove();
    host = styleEl = null;
    ui = {};
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'bacain:set') msg.active ? activate() : deactivate();
    else if (msg.type !== 'bacain:get') return;
    sendResponse({ active });
  });
})();
