const mediaByTab = new Map();
const MAX_ITEMS_PER_TAB = 200;
const BILIBILI_HEADER_RULE_ID = 1700;
const EXTENSION_ENABLED_KEY = "extensionEnabled";
const ACTION_ICONS = {
  enabled: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  },
  disabled: {
    16: "icons/icon-off16.png",
    32: "icons/icon-off32.png",
    48: "icons/icon-off48.png",
    128: "icons/icon-off128.png"
  }
};
let extensionEnabled = false;

const MEDIA_EXTENSIONS = /\.(mp4|webm|mov|m4v|avi|mkv|flv|ogv|mp3|m4a|aac|wav|flac|ogg|opus|m3u8|mpd)(?:$|[?#])/i;
const MEDIA_CONTENT_TYPES = [
  "video/",
  "audio/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml"
];

async function updateActionAppearance() {
  await chrome.action.setIcon({ path: extensionEnabled ? ACTION_ICONS.enabled : ACTION_ICONS.disabled });
  await chrome.action.setTitle({ title: extensionEnabled ? "识别当前页面视频" : "视频嗅探下载器（已暂停）" });
  if (!extensionEnabled) await chrome.action.setBadgeText({ text: "" });
}

async function updateTabAction(tabId, method, details) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.action[method]({ ...details, tabId });
  } catch (error) {
    // A tab can close after an event fires, even if tabs.get() just found it.
    // Its badge is no longer needed; do not turn normal closure into a rejection.
    if (!/^No tab with id: \d+\.?$/i.test(String(error?.message || error))) {
      console.warn(`无法更新标签页角标 (${method}, tab ${tabId})`, error);
    }
  }
}

async function clearDetectedMedia() {
  mediaByTab.clear();
  const stored = await chrome.storage.session.get(null);
  const mediaKeys = Object.keys(stored).filter((key) => key.startsWith("media_tab_"));
  if (mediaKeys.length) await chrome.storage.session.remove(mediaKeys);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateTabAction(tab.id, "setBadgeText", { text: "" })));
}

async function broadcastExtensionState() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id >= 0).map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: "SET_EXTENSION_ENABLED", enabled: extensionEnabled }).catch(() => {})
  ));
}

async function initializeExtensionState() {
  const stored = await chrome.storage.local.get(EXTENSION_ENABLED_KEY);
  extensionEnabled = stored[EXTENSION_ENABLED_KEY] !== false;
  await updateActionAppearance();
  if (!extensionEnabled) await clearDetectedMedia();
}

const extensionStateReady = initializeExtensionState().catch(() => {
  extensionEnabled = true;
});

async function setExtensionEnabled(enabled) {
  await extensionStateReady;
  extensionEnabled = Boolean(enabled);
  await chrome.storage.local.set({ [EXTENSION_ENABLED_KEY]: extensionEnabled });
  if (!extensionEnabled) await clearDetectedMedia();
  await updateActionAppearance();
  await broadcastExtensionState();
  return extensionEnabled;
}

async function ensureBilibiliRequestHeaders() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BILIBILI_HEADER_RULE_ID],
    addRules: [{
      id: BILIBILI_HEADER_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.bilibili.com/" }]
      },
      condition: {
        requestDomains: ["bilivideo.com", "bilivideo.cn"],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"]
      }
    }]
  });
}

chrome.runtime.onInstalled.addListener(() => ensureBilibiliRequestHeaders().catch(() => {}));
chrome.runtime.onStartup.addListener(() => ensureBilibiliRequestHeaders().catch(() => {}));
ensureBilibiliRequestHeaders().catch(() => {});

function inferKind(url = "", contentType = "") {
  const value = `${url} ${contentType}`.toLowerCase();
  if (value.includes(".m3u8") || value.includes("mpegurl")) return "hls";
  if (value.includes(".mpd") || value.includes("dash+xml")) return "dash";
  if (url.startsWith("blob:")) return "blob";
  return "direct";
}

function isMediaResponse(details) {
  // HLS 播放时可能产生数百个小分片；它们应由 m3u8 合并器处理，而不是逐个展示。
  if (/\.(ts|m4s|cmfv|cmfa|aac)(?:$|[?#])/i.test(details.url)) return false;
  if (MEDIA_EXTENSIONS.test(details.url)) return true;
  return (details.responseHeaders || []).some(({ name, value = "" }) =>
    name.toLowerCase() === "content-type" &&
    MEDIA_CONTENT_TYPES.some((type) => value.toLowerCase().includes(type))
  );
}

function getHeader(details, wantedName) {
  return (details.responseHeaders || []).find(
    ({ name }) => name.toLowerCase() === wantedName.toLowerCase()
  )?.value || "";
}

function normalizeDashStream(stream) {
  if (!stream || typeof stream !== "object" || !/^https?:/i.test(String(stream.url || ""))) return null;
  return {
    url: String(stream.url),
    backupUrls: (Array.isArray(stream.backupUrls) ? stream.backupUrls : [])
      .filter((url) => typeof url === "string" && /^https?:/i.test(url))
      .slice(0, 5),
    id: Number(stream.id) || 0,
    bandwidth: Number(stream.bandwidth) || 0,
    mimeType: String(stream.mimeType || ""),
    codecs: String(stream.codecs || "").slice(0, 80),
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    frameRate: Number(stream.frameRate) || 0,
    size: Number(stream.size) || 0,
    label: String(stream.label || "").slice(0, 120)
  };
}

function normalizeItem(item) {
  if (!item || typeof item.url !== "string") return null;
  const url = item.url.trim();
  if (!/^(https?:|blob:|data:)/i.test(url)) return null;
  const normalized = {
    url,
    title: String(item.title || "未命名视频").slice(0, 160),
    type: String(item.type || ""),
    source: String(item.source || "page"),
    kind: item.kind || inferKind(url, item.type),
    size: Number(item.size) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    selectedQuality: String(item.selectedQuality || "").slice(0, 120)
  };
  if (normalized.kind === "bilibili-dash") {
    const videoStreams = (Array.isArray(item.videoStreams) ? item.videoStreams : []).map(normalizeDashStream).filter(Boolean).slice(0, 40);
    const audioStreams = (Array.isArray(item.audioStreams) ? item.audioStreams : []).map(normalizeDashStream).filter(Boolean).slice(0, 20);
    if (!videoStreams.length) return null;
    const requestedVideo = normalizeDashStream(item.selectedVideo);
    const requestedAudio = normalizeDashStream(item.selectedAudio);
    normalized.videoStreams = videoStreams;
    normalized.audioStreams = audioStreams;
    normalized.selectedVideo = requestedVideo || videoStreams.find((stream) => stream.url === item.selectedVideoUrl) || videoStreams[0];
    normalized.selectedAudio = requestedAudio || audioStreams.find((stream) => stream.url === item.selectedAudioUrl) || audioStreams[0] || null;
    normalized.audioUrl = normalized.selectedAudio?.url || "";
    normalized.selectedAudioLabel = String(item.selectedAudioLabel || normalized.selectedAudio?.label || "").slice(0, 120);
    normalized.pageUrl = /^https?:/i.test(String(item.pageUrl || "")) ? String(item.pageUrl) : "https://www.bilibili.com/";
    normalized.resourceKey = String(item.resourceKey || `bilibili-dash:${normalized.pageUrl}`).slice(0, 600);
    normalized.duration = Number(item.duration) || 0;
    normalized.drm = item.drm === true;
  }
  return normalized;
}

function mergeItems(tabId, items) {
  if (!extensionEnabled || !Number.isInteger(tabId) || tabId < 0) return [];
  const current = mediaByTab.get(tabId) || new Map();
  for (const rawItem of items || []) {
    const item = normalizeItem(rawItem);
    if (!item) continue;
    if (item.kind === "bilibili-dash") {
      for (const [key, existing] of current) {
        if (existing.kind === "blob") current.delete(key);
      }
    } else if (item.kind === "blob" && [...current.values()].some((existing) => existing.kind === "bilibili-dash")) {
      continue;
    }
    const itemKey = item.resourceKey || item.url;
    const previous = current.get(itemKey) || {};
    current.set(itemKey, {
      ...previous,
      ...item,
      title: item.title !== "未命名视频" ? item.title : previous.title || item.title,
      size: item.size || previous.size || 0,
      width: item.width || previous.width || 0,
      height: item.height || previous.height || 0
    });
  }
  while (current.size > MAX_ITEMS_PER_TAB) {
    current.delete(current.keys().next().value);
  }
  mediaByTab.set(tabId, current);
  chrome.storage.session.set({ [`media_tab_${tabId}`]: [...current.values()] }).catch(() => {});
  void updateTabAction(tabId, "setBadgeBackgroundColor", { color: "#18855d" });
  void updateTabAction(tabId, "setBadgeText", { text: current.size ? String(Math.min(current.size, 99)) : "" });
  return [...current.values()];
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!extensionEnabled || details.tabId < 0 || !isMediaResponse(details)) return;
    const contentType = getHeader(details, "content-type");
    const contentLength = Number(getHeader(details, "content-length")) || 0;
    mergeItems(details.tabId, [{
      url: details.url,
      title: "网络视频资源",
      type: contentType,
      size: contentLength,
      source: "network",
      kind: inferKind(details.url, contentType)
    }]);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove(`media_tab_${tabId}`).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    mediaByTab.delete(tabId);
    chrome.storage.session.remove(`media_tab_${tabId}`).catch(() => {});
    void updateTabAction(tabId, "setBadgeText", { text: "" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PAGE_MEDIA" && sender.tab?.id >= 0) {
    sendResponse({ items: extensionEnabled ? mergeItems(sender.tab.id, message.items) : [], enabled: extensionEnabled });
    return;
  }

  if (message?.type === "GET_EXTENSION_STATE") {
    extensionStateReady
      .then(() => sendResponse({ enabled: extensionEnabled }))
      .catch(() => sendResponse({ enabled: true }));
    return true;
  }

  if (message?.type === "SET_EXTENSION_STATE") {
    setExtensionEnabled(message.enabled)
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_MEDIA") {
    const tabId = Number(message.tabId);
    extensionStateReady
      .then(() => {
        if (!extensionEnabled) return { items: [], enabled: false };
        const inMemory = mediaByTab.get(tabId);
        if (inMemory) return { items: [...inMemory.values()], enabled: true };
        return chrome.storage.session.get(`media_tab_${tabId}`).then((stored) => {
          const restored = stored[`media_tab_${tabId}`] || [];
          return { items: mergeItems(tabId, restored), enabled: true };
        });
      })
      .then(sendResponse)
      .catch(() => sendResponse({ items: [], enabled: extensionEnabled }));
    return true;
  }

  if (message?.type === "DOWNLOAD_MEDIA") {
    extensionStateReady
      .then(() => {
        if (!extensionEnabled) throw new Error("扩展当前已暂停，请先打开右上角开关");
        return downloadMedia(message.item, message.mode, message.audioFormat, message.videoFormat);
      })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

});

function safeFilename(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "video";
}

function extensionFrom(item) {
  try {
    const match = new URL(item.url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) {}
  const contentType = String(item.type || "").toLowerCase();
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  return "mp4";
}

async function createMediaJob(item, mode, audioFormat = "auto", videoFormat = "auto") {
  const jobId = crypto.randomUUID();
  await chrome.storage.session.set({
    [`hls_job_${jobId}`]: {
      item,
      mode,
      audioFormat,
      videoFormat,
      filename: `网页视频/${safeFilename(item.title)}`,
      createdAt: Date.now()
    }
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?job=${encodeURIComponent(jobId)}`) });
  return jobId;
}

async function downloadMedia(rawItem, requestedMode = "video", requestedAudioFormat = "auto", requestedVideoFormat = "auto") {
  const item = normalizeItem(rawItem);
  if (!item) throw new Error("无效的视频地址");
  if (item.kind === "bilibili-dash") {
    if (item.drm) throw new Error("此视频使用 DRM 加密，扩展不能下载或解密");
    if (requestedMode === "audio" && !item.selectedAudio) throw new Error("没有发现可下载的 Bilibili 音轨");
    const audioFormat = ["auto", "mp3", "flac"].includes(requestedAudioFormat) ? requestedAudioFormat : "auto";
    const videoFormat = ["auto", "mp4", "ts"].includes(requestedVideoFormat) ? requestedVideoFormat : "auto";
    return createMediaJob(item, requestedMode === "audio" ? "audio" : "video", audioFormat, videoFormat);
  }
  if (requestedMode === "audio" && /^https?:/i.test(item.url) && ["direct", "hls"].includes(item.kind)) {
    const audioFormat = ["auto", "mp3", "flac"].includes(requestedAudioFormat) ? requestedAudioFormat : "auto";
    return createMediaJob(item, "audio", audioFormat);
  }
  const videoFormat = ["auto", "mp4", "ts"].includes(requestedVideoFormat) ? requestedVideoFormat : "auto";
  if (requestedMode === "video" && videoFormat !== "auto" && /^https?:/i.test(item.url) && ["direct", "hls"].includes(item.kind)) {
    return createMediaJob(item, "video", "auto", videoFormat);
  }
  if (item.kind === "hls" && /^https?:/i.test(item.url)) {
    return createMediaJob(item, "video", "auto", videoFormat);
  }
  if (item.kind !== "direct" || !/^https?:/i.test(item.url)) {
    throw new Error("此资源是 DASH 播放清单或临时 blob，不能作为完整视频直接下载");
  }
  const filename = `网页视频/${safeFilename(item.title)}.${extensionFrom(item)}`;
  return chrome.downloads.download({ url: item.url, filename, saveAs: true });
}
