const onBtn = document.getElementById('on');
const offBtn = document.getElementById('off');
const statusEl = document.getElementById('status');
let tabId = null;

function render(active) {
  onBtn.classList.toggle('sel', active);
  offBtn.classList.toggle('sel', !active);
  onBtn.setAttribute('aria-pressed', String(active));
  offBtn.setAttribute('aria-pressed', String(!active));
  statusEl.textContent = active ? 'Active on this tab.' : 'Inactive on this tab.';
  statusEl.style.color = active ? '#4caf50' : '#666';
}

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = '#3b82f6';
  onBtn.disabled = offBtn.disabled = true;
}

async function setActive(active) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'bacain:set', active });
    render(res.active);
  } catch (e) {
    fail('Lost contact with the page. Reload it.');
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null || !/^https?:/.test(tab.url || '')) {
    return fail('Cannot run on this page.');
  }
  tabId = tab.id;
  try {
    // Injected on demand — activeTab grants access to this tab only.
    // content.js is guarded, so repeat injection is a no-op.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['text.js', 'content.js'] });
  } catch (e) {
    return fail('Cannot run on this page.');
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'bacain:get' });
    render(res.active);
  } catch (e) {
    fail('No response from the page. Reload this tab.');
  }
}

onBtn.addEventListener('click', () => setActive(true));
offBtn.addEventListener('click', () => setActive(false));

init();

// ---------- cloud voice settings ----------

const keyInput = document.getElementById('key');
const voiceInput = document.getElementById('voice');
const cloudEl = document.getElementById('cloud');

function cloudStatus(text, ok) {
  cloudEl.textContent = text;
  cloudEl.style.color = ok === false ? '#d93025' : ok ? '#4caf50' : '#666';
}

async function showCloud(extra) {
  const info = (await chrome.runtime.sendMessage({ type: 'tts:usage' })) || { enabled: false, used: 0, cap: 0 };
  const { ttsVoice } = await chrome.storage.local.get('ttsVoice');
  voiceInput.value = ttsVoice || '';
  keyInput.placeholder = info.enabled ? 'API key saved (hidden)' : 'API key';
  const usage = `${info.used.toLocaleString('en-US')} / ${info.cap.toLocaleString('en-US')} characters this month`;
  const base = info.enabled ? `Cloud voice on. ${usage}.` : 'No key: the browser voice is used.';
  cloudStatus(extra ? `${base} ${extra}` : base, info.enabled ? true : null);
}

async function checkKey(key) {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=id-ID&key=${encodeURIComponent(key)}`);
  if (res.ok) return '';
  let detail = '';
  try { detail = (await res.json()).error.message; } catch (e) { /* no JSON body */ }
  return `Google rejected the key (${res.status}${detail ? `: ${detail}` : ''}).`;
}

document.getElementById('save').addEventListener('click', async () => {
  try {
    const key = keyInput.value.trim();
    const voice = voiceInput.value.trim();
    await (voice ? chrome.storage.local.set({ ttsVoice: voice }) : chrome.storage.local.remove('ttsVoice'));
    if (!key) return await showCloud('Voice saved.');
    // Save first: the popup closes the moment it loses focus, which would drop the key mid-check.
    await chrome.storage.local.set({ ttsKey: key });
    keyInput.value = '';
    cloudStatus('Checking key…');
    let problem = '';
    let rejected = false;
    try {
      problem = await checkKey(key);
      rejected = !!problem;
    } catch (e) {
      problem = 'Could not reach Google to check the key.';
    }
    if (rejected) await chrome.storage.local.remove('ttsKey');
    await showCloud(rejected ? `${problem} Key not saved.` : problem || 'Google accepted the key.');
    if (problem) cloudEl.style.color = '#d93025';
  } catch (e) {
    cloudStatus(`Could not save: ${e.message || e}`, false);
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove('ttsKey');
    keyInput.value = '';
    await showCloud();
  } catch (e) {
    cloudStatus(`Could not remove the key: ${e.message || e}`, false);
  }
});

showCloud().catch(() => cloudStatus('Could not read cloud voice settings.', false));
