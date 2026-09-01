(() => {
  const VIDEO_PATTERN = /\.(mp4|webm|mov|m4v|avi|mkv|flv|ogv|mp3|m4a|aac|wav|flac|ogg|opus|m3u8|mpd)(?:$|[?#])/i;
  const BILIBILI_RESPONSE_TYPE = "VIDEO_DOWNLOADER_BILIBILI_DASH";
  const BILIBILI_REQUEST_TYPE = "VIDEO_DOWNLOADER_REQUEST_BILIBILI_DASH";
  let reportTimer;
  let mediaObserver;
  let contextValid = true;
  let bilibiliDashItem = null;

  function stopAfterContextInvalidation() {
    contextValid = false;
    clearTimeout(reportTimer);
    mediaObserver?.disconnect();
  }

  function sendMessageSafely(message) {
    if (!contextValid) return;
    try {
      const pending = chrome.runtime.sendMessage(message);
      pending?.catch((error) => {
        if (/Extension context invalidated/i.test(String(error?.message || error))) {
          stopAfterContextInvalidation();
        }
      });
    } catch (error) {
      if (/Extension context invalidated/i.test(String(error?.message || error))) {
        stopAfterContextInvalidation();
      }
    }
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      return new URL(value, document.baseURI).href;
    } catch (_) {
      return "";
    }
  }

  function kindFromUrl(url) {
    if (/\.m3u8(?:$|[?#])/i.test(url)) return "hls";
    if (/\.mpd(?:$|[?#])/i.test(url)) return "dash";
    if (url.startsWith("blob:")) return "blob";
    return "direct";
  }

  function addItem(items, seen, raw) {
    const url = absoluteUrl(raw.url);
    if (!url || seen.has(url) || url.startsWith("data:")) return;
    seen.add(url);
    items.push({ ...raw, url, kind: kindFromUrl(url) });
  }

  function collectMedia() {
    const items = [];
    const seen = new Set();
    const pageTitle = document.title.trim() || location.hostname;

    document.querySelectorAll("video, audio").forEach((video, index) => {
      const mediaName = video.tagName === "AUDIO" ? "音频" : "视频";
      const title = video.getAttribute("title") || video.getAttribute("aria-label") || `${pageTitle} - ${mediaName} ${index + 1}`;
      const common = {
        title,
        source: "video-element",
        width: video.videoWidth || video.clientWidth,
        height: video.videoHeight || video.clientHeight
      };
      addItem(items, seen, { ...common, url: video.currentSrc || video.src, type: video.getAttribute("type") || "" });
      video.querySelectorAll("source").forEach((source) => {
        addItem(items, seen, { ...common, url: source.src, type: source.type || "" });
      });
    });

    document.querySelectorAll("a[href]").forEach((anchor) => {
      if (!VIDEO_PATTERN.test(anchor.href)) return;
      addItem(items, seen, {
        url: anchor.href,
        title: anchor.textContent.trim() || pageTitle,
        type: "",
        source: "link"
      });
    });

    try {
      performance.getEntriesByType("resource").forEach((entry) => {
        if (!VIDEO_PATTERN.test(entry.name)) return;
        addItem(items, seen, {
          url: entry.name,
          title: pageTitle,
          type: "",
          source: "performance",
          size: entry.transferSize || entry.encodedBodySize || 0
        });
      });
    } catch (_) {}

    if (bilibiliDashItem) items.push(bilibiliDashItem);

    return items;
  }

  function requestBilibiliDash() {
    if (!contextValid) return;
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;
    window.postMessage({ type: BILIBILI_REQUEST_TYPE }, location.origin);
  }

  function reportMedia() {
    if (!contextValid) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      sendMessageSafely({ type: "PAGE_MEDIA", items: collectMedia() });
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SCAN_PAGE") {
      requestBilibiliDash();
      const items = collectMedia();
      sendMessageSafely({ type: "PAGE_MEDIA", items });
      sendResponse({ items });
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== BILIBILI_RESPONSE_TYPE) return;
    const item = event.data.item;
    if (!item || item.kind !== "bilibili-dash" || !Array.isArray(item.videoStreams) || !item.videoStreams.length) return;
    bilibiliDashItem = item;
    sendMessageSafely({ type: "PAGE_MEDIA", items: [item] });
  });

  mediaObserver = new MutationObserver(reportMedia);
  mediaObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "href"]
  });

  window.addEventListener("load", reportMedia, { once: true });
  document.addEventListener("loadedmetadata", reportMedia, true);
  requestBilibiliDash();
  reportMedia();
})();
