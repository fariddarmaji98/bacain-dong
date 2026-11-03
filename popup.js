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
