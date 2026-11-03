// Bacain Dong — service worker: save drafts (MHTML + meta.json) and sync them to Google Drive.
importScripts('db.js');

const DOWNLOAD_ROOT = 'Bacain Dong';
const DRIVE_ROOT_FOLDER = 'Bacain Dong';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ---------- drafts ----------

function sanitizeName(raw) {
  let s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return s || 'untitled';
}

async function uniqueFolderName(base) {
  const taken = new Set((await listDrafts()).map((d) => d.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function captureMhtml(tabId) {
  return new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!blob) return reject(new Error('Page capture returned nothing.'));
      resolve(blob);
    });
  });
}

let offscreenReady = null;
function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (open.length) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Create blob: URLs so draft files can be saved with chrome.downloads.',
      });
    })().catch((e) => { offscreenReady = null; throw e; });
  }
  return offscreenReady;
}

async function closeOffscreen() {
  offscreenReady = null;
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

const DOWNLOAD_TIMEOUT_MS = 120000;

function downloadAndWait(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || id == null) {
        return reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed.'));
      }
      const finish = (error) => {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        if (error) reject(new Error(error)); else resolve();
      };
      const onChanged = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete') finish();
        else if (delta.state.current === 'interrupted') finish((delta.error && delta.error.current) || 'Download interrupted.');
      };
      // A stuck download (paused, unanswered save prompt) must not block the save queue forever.
      const timer = setTimeout(() => {
        chrome.downloads.cancel(id);
        finish('Download timed out.');
      }, DOWNLOAD_TIMEOUT_MS);
      chrome.downloads.onChanged.addListener(onChanged);
      // The download may have ended before the listener was attached.
      chrome.downloads.search({ id }, ([item]) => {
        if (!item) return;
        if (item.state === 'complete') finish();
        else if (item.state === 'interrupted') finish(item.error || 'Download interrupted.');
      });
    });
  });
}

async function downloadDraft(draft) {
  await ensureOffscreen();
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob-urls', id: draft.id });
    if (!res || res.error) throw new Error((res && res.error) || 'No blob URLs from offscreen document.');
    for (const f of draft.files) {
      await downloadAndWait({
        url: res.urls[f.name],
        filename: `${DOWNLOAD_ROOT}/${draft.id}/${f.name}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    }
  } finally {
    await closeOffscreen();
  }
}

async function saveDraft(tabId, title, url) {
  if (tabId == null) throw new Error('No tab to save.');
  const mhtml = await captureMhtml(tabId);
  const folder = await uniqueFolderName(sanitizeName(title));
  const savedAt = new Date().toISOString();
  const meta = JSON.stringify({ title, url, savedAt }, null, 2);
  const draft = {
    id: folder,
    title,
    url,
    savedAt,
    files: [
      { name: `${folder}.mhtml`, type: 'application/octet-stream', blob: mhtml },
      { name: 'meta.json', type: 'application/json', blob: new Blob([meta], { type: 'application/json' }) },
    ],
  };
  await putDraft(draft);
  try {
    await downloadDraft(draft);
  } catch (e) {
    try { await deleteDraft(folder); } catch (_) { /* keep the original error */ }
    throw e;
  }
  return { folder };
}

// ---------- Google Drive sync ----------

function oauthConfigured() {
  const oauth = chrome.runtime.getManifest().oauth2;
  return !!(oauth && oauth.client_id && !oauth.client_id.startsWith('YOUR_CLIENT_ID'));
}

async function getToken() {
  const res = await chrome.identity.getAuthToken({ interactive: true });
  const token = typeof res === 'string' ? res : res && res.token;
  if (!token) throw new Error('Google sign-in failed.');
  return token;
}

async function driveFetch(state, url, init = {}) {
  const send = () => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${state.token}` } });
  let res = await send();
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: state.token });
    state.token = await getToken();
    res = await send();
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const jsonInit = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function ensureRootFolder(state) {
  const q = `name='${DRIVE_ROOT_FOLDER}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
  const found = await (await driveFetch(state, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=createdTime&pageSize=1`)).json();
  if (found.files && found.files.length) return found.files[0].id;
  const created = await driveFetch(state, `${DRIVE_API}/files?fields=id`, jsonInit({ name: DRIVE_ROOT_FOLDER, mimeType: FOLDER_MIME, parents: ['root'] }));
  return (await created.json()).id;
}

// Folders under the root, by name. A folder only counts as uploaded once its marker flips to '1'
// (set after the last file), so a half-filled folder is never mistaken for a finished one.
async function listDriveFolders(state, parentId) {
  const folders = new Map();
  const q = `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
  let pageToken = '';
  do {
    const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,appProperties)&pageSize=1000`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const page = await (await driveFetch(state, url)).json();
    for (const f of page.files || []) {
      const complete = !!f.appProperties && f.appProperties.complete === '1';
      const known = folders.get(f.name);
      if (!known || (complete && !known.complete)) folders.set(f.name, { id: f.id, complete });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return folders;
}

const deleteDriveFile = (state, id) => driveFetch(state, `${DRIVE_API}/files/${id}`, { method: 'DELETE' });

async function uploadFile(state, parentId, file) {
  const boundary = `bacain-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: file.name, parents: [parentId] });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`;
  const body = new Blob([head, file.blob, `\r\n--${boundary}--`]);
  await driveFetch(state, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function uploadDraft(state, rootId, draft) {
  const folder = await (await driveFetch(state, `${DRIVE_API}/files?fields=id`,
    jsonInit({ name: draft.id, mimeType: FOLDER_MIME, parents: [rootId], appProperties: { complete: '0' } }))).json();
  try {
    for (const file of draft.files) await uploadFile(state, folder.id, file);
    await driveFetch(state, `${DRIVE_API}/files/${folder.id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { complete: '1' } }),
    });
  } catch (e) {
    // Drop the half-filled folder; if that fails too, the marker still keeps it from counting as uploaded.
    try { await deleteDriveFile(state, folder.id); } catch (_) { /* best effort */ }
    throw e;
  }
}

async function syncDrafts(progress) {
  if (!oauthConfigured()) {
    throw new Error('Google OAuth client ID is not set in manifest.json (see README).');
  }
  progress('Signing in to Google…');
  const state = { token: await getToken() };
  const drafts = await listDrafts();
  if (!drafts.length) return { total: 0, uploaded: 0, skipped: 0, failed: [] };

  progress('Checking Google Drive…');
  const rootId = await ensureRootFolder(state);
  const inDrive = await listDriveFolders(state, rootId);
  const pending = drafts
    .filter((d) => !(inDrive.get(d.id) || {}).complete)
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt));

  const failed = [];
  let uploaded = 0;
  for (const [i, draft] of pending.entries()) {
    progress(`Uploading ${i + 1}/${pending.length}: ${draft.id}`);
    try {
      const stale = inDrive.get(draft.id); // leftover of an earlier interrupted upload
      if (stale) await deleteDriveFile(state, stale.id);
      await uploadDraft(state, rootId, draft);
      uploaded++;
    } catch (e) {
      failed.push({ id: draft.id, error: e.message || String(e) });
    }
  }
  return { total: drafts.length, uploaded, skipped: drafts.length - pending.length, failed };
}

// A service worker is killed after 30 s without extension-API activity, which a big upload can exceed.
async function syncDraftsKeepAlive(progress) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await syncDrafts(progress);
  } finally {
    clearInterval(timer);
  }
}

// ---------- cloud voice (Google Cloud Text-to-Speech) ----------

const TTS_API = 'https://texttospeech.googleapis.com/v1';
// Best voice first. id-ID has Chirp3-HD, Wavenet and Standard voices (no Neural2).
const VOICE_TIERS = ['Chirp3-HD', 'Wavenet', 'Standard'];
// Kept under the smallest monthly free quota (1M characters for Chirp 3 HD). Counted locally, per
// browser profile, so it is a guard, not Google's own meter.
const TTS_MONTHLY_CHAR_CAP = 900000;
const TTS_MAX_TEXT = 1000;

function ttsError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function googleError(res) {
  let detail = '';
  try { detail = (await res.json()).error.message; } catch (e) { /* no JSON body */ }
  return ttsError(res.status === 429 ? 'quota' : 'http', `Google TTS ${res.status}${detail ? `: ${detail}` : ''}`);
}

// Usage updates are queued: several chunks are fetched at once and each one read-modify-writes the counter.
let usageQueue = Promise.resolve();
function adjustUsage(delta, enforceCap) {
  const run = usageQueue.then(async () => {
    const { ttsUsage } = await chrome.storage.local.get('ttsUsage');
    const month = new Date().toISOString().slice(0, 7);
    const used = ttsUsage && ttsUsage.month === month ? ttsUsage.chars : 0;
    if (enforceCap && used + delta > TTS_MONTHLY_CHAR_CAP) {
      throw ttsError('cap', `Monthly cloud voice limit reached (${TTS_MONTHLY_CHAR_CAP.toLocaleString('en-US')} characters).`);
    }
    await chrome.storage.local.set({ ttsUsage: { month, chars: Math.max(0, used + delta) } });
  });
  usageQueue = run.catch(() => {});
  return run;
}

async function ttsUsageInfo() {
  const { ttsKey, ttsUsage } = await chrome.storage.local.get(['ttsKey', 'ttsUsage']);
  const month = new Date().toISOString().slice(0, 7);
  return { enabled: !!ttsKey, used: ttsUsage && ttsUsage.month === month ? ttsUsage.chars : 0, cap: TTS_MONTHLY_CHAR_CAP };
}

// Several chunks are requested at once, so concurrent first lookups share one voices.list call.
const voiceLookups = new Map();

async function lookupVoice(key, lang) {
  const { ttsVoiceCache } = await chrome.storage.local.get('ttsVoiceCache');
  const cache = ttsVoiceCache || {};
  if (cache[lang]) return cache[lang];
  const res = await fetch(`${TTS_API}/voices?languageCode=${encodeURIComponent(lang)}&key=${encodeURIComponent(key)}`);
  if (!res.ok) throw await googleError(res);
  const names = ((await res.json()).voices || []).map((v) => v.name).sort();
  for (const tier of VOICE_TIERS) {
    const hit = names.find((n) => n.includes(`-${tier}-`));
    if (hit) {
      // Re-read right before writing: another language may have been cached while we waited on the network.
      const { ttsVoiceCache: latest } = await chrome.storage.local.get('ttsVoiceCache');
      await chrome.storage.local.set({ ttsVoiceCache: { ...(latest || {}), [lang]: hit } });
      return hit;
    }
  }
  throw ttsError('novoice', `No Google voice for ${lang}.`);
}

async function pickVoice(key, lang) {
  const { ttsVoice } = await chrome.storage.local.get('ttsVoice');
  if (ttsVoice && ttsVoice.startsWith(`${lang}-`)) return ttsVoice; // user override for this language
  if (!voiceLookups.has(lang)) {
    voiceLookups.set(lang, lookupVoice(key, lang).finally(() => voiceLookups.delete(lang)));
  }
  return voiceLookups.get(lang);
}

async function synthesize(text, lang) {
  if (typeof text !== 'string' || !text.trim() || text.length > TTS_MAX_TEXT || typeof lang !== 'string') {
    throw ttsError('input', 'Invalid text for cloud voice.');
  }
  const { ttsKey } = await chrome.storage.local.get('ttsKey');
  if (!ttsKey) throw ttsError('nokey', 'No Google TTS API key set.');
  await adjustUsage(text.length, true);
  try {
    const voice = await pickVoice(ttsKey, lang);
    const res = await fetch(`${TTS_API}/text:synthesize?key=${encodeURIComponent(ttsKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang, name: voice },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });
    if (!res.ok) throw await googleError(res);
    const { audioContent } = await res.json();
    if (!audioContent) throw ttsError('http', 'Google TTS returned no audio.');
    return { audio: audioContent, voice };
  } catch (e) {
    await adjustUsage(-text.length, false); // nothing was synthesized, give the characters back
    throw e;
  }
}

// ---------- messaging ----------

const fail = (sendResponse) => (e) => sendResponse({ ok: false, code: e.code || 'error', error: e.message || String(e) });

// Saves run one at a time: they share the offscreen document and the folder-name check.
let saveQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'draft:save') {
    const tab = sender.tab || {};
    saveQueue = saveQueue
      .then(() => saveDraft(tab.id, msg.title || tab.title, msg.url || tab.url))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch(fail(sendResponse));
    return true;
  }
  if (msg.type === 'tts:info' || msg.type === 'tts:usage') {
    ttsUsageInfo().then(sendResponse).catch(() => sendResponse({ enabled: false, used: 0, cap: TTS_MONTHLY_CHAR_CAP }));
    return true;
  }
  if (msg.type === 'tts:synthesize') {
    synthesize(msg.text, msg.lang)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch(fail(sendResponse));
    return true;
  }
});

let syncing = false;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sync') return;
  const post = (m) => { try { port.postMessage(m); } catch (e) { /* tab navigated away */ } };
  if (syncing) {
    post({ type: 'error', message: 'Sync already running.' });
    return;
  }
  syncing = true;
  syncDraftsKeepAlive((text) => post({ type: 'progress', text }))
    .then((result) => post({ type: 'done', ...result }))
    .catch((e) => post({ type: 'error', message: e.message || String(e) }))
    .finally(() => { syncing = false; });
});
