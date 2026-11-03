// Offscreen document: the service worker has no URL.createObjectURL, so it asks us
// for blob: URLs of a draft's files and hands them to chrome.downloads.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'blob-urls') return;
  getDraft(msg.id)
    .then((draft) => {
      if (!draft) throw new Error('Draft not found.');
      const urls = {};
      for (const f of draft.files) urls[f.name] = URL.createObjectURL(f.blob);
      sendResponse({ urls });
    })
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true;
});
