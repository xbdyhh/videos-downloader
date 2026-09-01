(() => {
  const RESPONSE_TYPE = "VIDEO_DOWNLOADER_BILIBILI_DASH";
  const REQUEST_TYPE = "VIDEO_DOWNLOADER_REQUEST_BILIBILI_DASH";
  const PLAY_URL_PATTERN = /(?:api\.)?bilibili\.com\/(?:x\/player\/(?:wbi\/)?playurl|pgc\/player\/web\/playurl)/i;
  const QUALITY_NAMES = {
    6: "240P",
    16: "360P",
    32: "480P",
    64: "720P",
    74: "720P60",
    80: "1080P",
    112: "1080P+",
    116: "1080P60",
    120: "4K",
    125: "HDR",
    126: "杜比视界",
    127: "8K"
  };
  let lastSignature = "";

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function findDashContainer(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
    seen.add(value);
    if (value.dash && Array.isArray(value.dash.video)) return value;
    for (const key of ["data", "result", "video_info", "videoInfo", "playurl_info", "playurlInfo"]) {
      const found = findDashContainer(value[key], depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  function parseFrameRate(value) {
    if (typeof value === "number") return value;
    const text = String(value || "");
    if (text.includes("/")) {
      const [numerator, denominator] = text.split("/").map(Number);
      if (numerator && denominator) return numerator / denominator;
    }
    return Number(text) || 0;
  }

  function codecLabel(codecs = "") {
    const value = codecs.toLowerCase();
    if (value.includes("av01")) return "AV1";
    if (value.includes("hev") || value.includes("hvc")) return "HEVC";
    if (value.includes("avc")) return "H.264";
    if (value.includes("flac")) return "FLAC";
    if (value.includes("ec-3") || value.includes("eac3")) return "杜比音频";
    if (value.includes("mp4a")) return "AAC";
    return codecs || "编码未知";
  }

  function normalizeStream(raw, kind, duration) {
    if (!raw || typeof raw !== "object") return null;
    const url = raw.baseUrl || raw.base_url || raw.url || "";
    if (!/^https?:/i.test(url)) return null;
    const backupUrls = asArray(raw.backupUrl || raw.backup_url)
      .filter((candidate) => typeof candidate === "string" && /^https?:/i.test(candidate));
    const bandwidth = Number(raw.bandwidth) || 0;
    const codecs = String(raw.codecs || "");
    const width = Number(raw.width) || 0;
    const height = Number(raw.height) || 0;
    const frameRate = parseFrameRate(raw.frameRate || raw.frame_rate);
    const quality = QUALITY_NAMES[raw.id] || (height ? `${height}P` : `画质 ${raw.id || "未知"}`);
    const rate = bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "码率未知";
    const label = kind === "video"
      ? `${quality}${frameRate >= 45 ? ` · ${Math.round(frameRate)}fps` : ""} · ${codecLabel(codecs)} · ${rate}`
      : `${raw.id === 30251 ? "Hi-Res / FLAC" : raw.id === 30250 ? "杜比音频" : "音频"} · ${codecLabel(codecs)} · ${rate}`;
    return {
      url,
      backupUrls,
      id: Number(raw.id) || 0,
      bandwidth,
      mimeType: String(raw.mimeType || raw.mime_type || ""),
      codecs,
      width,
      height,
      frameRate,
      size: bandwidth && duration ? Math.round((bandwidth * duration) / 8) : 0,
      label
    };
  }

  function currentTitle() {
    const node = document.querySelector("h1.video-title, h1[title], .video-title");
    const value = node?.getAttribute("title") || node?.textContent || document.title || "Bilibili 视频";
    return value.trim().replace(/[_-]?哔哩哔哩.*$/i, "").trim() || "Bilibili 视频";
  }

  function emitPlayInfo(playInfo, source = "page") {
    const container = findDashContainer(playInfo);
    if (!container) return;
    const dash = container.dash;
    const duration = Number(dash.duration) || Math.round((Number(container.timelength) || 0) / 1000);
    const videoStreams = asArray(dash.video)
      .map((stream) => normalizeStream(stream, "video", duration))
      .filter(Boolean)
      .sort((a, b) => b.height - a.height || b.frameRate - a.frameRate || b.bandwidth - a.bandwidth);
    const extraAudio = [
      ...asArray(dash.dolby?.audio),
      ...asArray(dash.flac?.audio)
    ];
    const audioStreams = [...asArray(dash.audio), ...extraAudio]
      .map((stream) => normalizeStream(stream, "audio", duration))
      .filter(Boolean)
      .filter((stream, index, all) => all.findIndex((candidate) => candidate.url === stream.url) === index)
      .sort((a, b) => b.bandwidth - a.bandwidth);
    if (!videoStreams.length) return;
    const pageUrl = `${location.origin}${location.pathname}${location.search}`;
    const signature = `${pageUrl}|${videoStreams.map((stream) => stream.url).join("|")}|${audioStreams.map((stream) => stream.url).join("|")}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    window.postMessage({
      type: RESPONSE_TYPE,
      item: {
        kind: "bilibili-dash",
        source: `bilibili-${source}`,
        resourceKey: `bilibili-dash:${pageUrl}`,
        pageUrl,
        title: currentTitle(),
        url: videoStreams[0].url,
        type: videoStreams[0].mimeType || "video/mp4",
        width: videoStreams[0].width,
        height: videoStreams[0].height,
        duration,
        size: (videoStreams[0].size || 0) + (audioStreams[0]?.size || 0),
        drm: container.is_drm === true,
        videoStreams,
        audioStreams
      }
    }, location.origin);
  }

  function scanKnownPlayInfo() {
    emitPlayInfo(window.__playinfo__, "initial");
    emitPlayInfo(window.__PLAYINFO__, "initial");
  }

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await Reflect.apply(originalFetch, this, args);
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || response.url;
      if (PLAY_URL_PATTERN.test(requestUrl || "")) {
        response.clone().json().then((data) => emitPlayInfo(data, "fetch")).catch(() => {});
      }
      return response;
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    const originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__videoDownloaderPlayUrl = PLAY_URL_PATTERN.test(String(url || ""));
      if (this.__videoDownloaderPlayUrl) {
        this.addEventListener("load", () => {
          try {
            const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            emitPlayInfo(data, "xhr");
          } catch (_) {}
        }, { once: true });
      }
      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.type === REQUEST_TYPE) {
      lastSignature = "";
      scanKnownPlayInfo();
    }
  });

  scanKnownPlayInfo();
  setInterval(scanKnownPlayInfo, 1500);
})();
