const elements = {
  loading: document.querySelector("#loading"),
  disabled: document.querySelector("#disabled"),
  empty: document.querySelector("#empty"),
  mediaList: document.querySelector("#mediaList"),
  footer: document.querySelector("#footer"),
  refresh: document.querySelector("#refreshButton"),
  powerToggle: document.querySelector("#extensionEnabled"),
  selectAll: document.querySelector("#selectAll"),
  downloadSelected: document.querySelector("#downloadSelected"),
  toast: document.querySelector("#toast")
};

let currentTabId;
let items = [];
let toastTimer;
let activeFilter = "all";
let extensionEnabled = true;

function isDownloadable(item) {
  if (item.kind === "bilibili-dash") return !item.drm && Boolean(item.videoStreams?.length);
  return (item.kind === "direct" || item.kind === "hls") && /^https?:/i.test(item.url);
}

function matchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "dash") return item.kind === "dash" || item.kind === "bilibili-dash";
  return item.kind === filter;
}

function formatBytes(bytes) {
  if (!bytes) return "大小未知";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function typeLabel(item) {
  if (item.kind === "hls") return "HLS 播放清单";
  if (item.kind === "dash") return "DASH 播放清单";
  if (item.kind === "bilibili-dash") return item.drm ? "Bilibili DASH · DRM" : "Bilibili DASH";
  if (item.kind === "blob") return "页面临时流";
  try {
    return new URL(item.url).pathname.split(".").pop().toUpperCase().slice(0, 6) || "视频";
  } catch (_) {
    return "视频";
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 3200);
}

function setState(state) {
  elements.loading.classList.toggle("hidden", state !== "loading");
  elements.disabled.classList.toggle("hidden", state !== "disabled");
  elements.empty.classList.toggle("hidden", state !== "empty");
  elements.mediaList.classList.toggle("hidden", state !== "results");
  elements.footer.classList.toggle("hidden", state !== "results");
  document.querySelector("#filters").classList.toggle("hidden", state !== "results");
}

function parseHlsAttributes(value) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(value))) attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  return attributes;
}

async function inspectHls(item) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(item.url, { credentials: "include", signal: controller.signal });
    if (!response.ok) return item;
    const text = await response.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const variants = [];
    const audioRenditions = lines
      .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
      .map((line) => parseHlsAttributes(line.slice(line.indexOf(":") + 1)))
      .filter((attributes) => attributes.TYPE === "AUDIO" && attributes.URI)
      .map((attributes) => ({
        url: new URL(attributes.URI, item.url).href,
        label: attributes.NAME || attributes.LANGUAGE || "默认音轨",
        isDefault: attributes.DEFAULT === "YES"
      }));
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
      const attributes = parseHlsAttributes(lines[index].slice(lines[index].indexOf(":") + 1));
      const uri = lines.slice(index + 1).find((line) => line && !line.startsWith("#"));
      if (!uri) continue;
      const resolution = attributes.RESOLUTION || "清晰度未知";
      const bandwidth = Number(attributes.BANDWIDTH) || 0;
      variants.push({
        url: new URL(uri, item.url).href,
        bandwidth,
        label: `${resolution}${bandwidth ? ` · ${(bandwidth / 1000000).toFixed(1)} Mbps` : ""}`
      });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    if (variants.length) {
      item.variants = variants;
      item.downloadUrl = variants[0].url;
      item.selectedQuality = variants[0].label;
    }
    if (audioRenditions.length) {
      const preferredAudio = audioRenditions.find((audio) => audio.isDefault) || audioRenditions[0];
      item.audioRenditions = audioRenditions;
      item.audioUrl = preferredAudio.url;
      item.audioLabel = preferredAudio.label;
    }
    return item;
  } catch (_) {
    return item;
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichHlsItems() {
  const hlsItems = items.filter((item) => item.kind === "hls").slice(0, 12);
  await Promise.all(hlsItems.map(inspectHls));
  const childUrls = new Set(hlsItems.flatMap((item) => [
    ...(item.variants || []).map((variant) => variant.url),
    ...(item.audioRenditions || []).map((audio) => audio.url)
  ]));
  items = items.filter((item) => !childUrls.has(item.url) || Boolean(item.variants?.length));
}

function updateDownloadButton() {
  const count = document.querySelectorAll(".media-check:checked").length;
  elements.downloadSelected.textContent = count ? `下载所选 (${count})` : "下载所选";
  elements.downloadSelected.disabled = count === 0;
  const available = document.querySelectorAll(".media-check").length;
  elements.selectAll.checked = available > 0 && count === available;
  elements.selectAll.indeterminate = count > 0 && count < available;
}

function render() {
  elements.mediaList.replaceChildren();
  if (!items.length) {
    setState("empty");
    return;
  }

  items.sort((a, b) => Number(isDownloadable(b)) - Number(isDownloadable(a)) || (b.size || 0) - (a.size || 0));
  document.querySelector("#allCount").textContent = items.length;
  document.querySelector("#directCount").textContent = items.filter((item) => item.kind === "direct").length;
  document.querySelector("#hlsCount").textContent = items.filter((item) => item.kind === "hls").length;
  document.querySelector("#dashCount").textContent = items.filter((item) => item.kind === "dash" || item.kind === "bilibili-dash").length;
  const visibleItems = items.map((item, index) => ({ item, index })).filter(({ item }) => matchesFilter(item, activeFilter));
  visibleItems.forEach(({ item, index }) => {
    const downloadable = isDownloadable(item);
    const card = document.createElement("article");
    card.className = "media-card";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "media-check";
    checkbox.dataset.index = index;
    checkbox.disabled = !downloadable;
    checkbox.addEventListener("change", updateDownloadButton);

    const info = document.createElement("div");
    info.className = "media-info";
    const title = document.createElement("p");
    title.className = "media-title";
    title.textContent = item.title || "未命名视频";
    title.title = item.url;
    const meta = document.createElement("div");
    meta.className = "media-meta";
    const type = document.createElement("span");
    type.className = `badge${downloadable ? "" : " warning"}`;
    type.textContent = typeLabel(item);
    const size = document.createElement("span");
    size.className = "badge";
    size.textContent = formatBytes(item.size);
    meta.append(type, size);
    if (item.width && item.height) {
      const resolution = document.createElement("span");
      resolution.className = "badge";
      resolution.textContent = `${item.width}×${item.height}`;
      meta.append(resolution);
    }
    if (item.kind === "bilibili-dash" && item.videoStreams?.length) {
      item.selectedVideo = item.selectedVideo || item.videoStreams[0];
      item.selectedQuality = item.selectedVideo.label || "Bilibili DASH";
      const quality = document.createElement("select");
      quality.className = "quality-select";
      quality.title = "选择 Bilibili 视频清晰度和编码";
      item.videoStreams.forEach((stream, streamIndex) => {
        const option = document.createElement("option");
        option.value = String(streamIndex);
        option.textContent = stream.label || `${stream.height || "未知"}P · ${stream.codecs || "未知编码"}`;
        option.selected = stream.url === item.selectedVideo.url;
        quality.append(option);
      });
      quality.addEventListener("change", () => {
        item.selectedVideo = item.videoStreams[Number(quality.value)] || item.videoStreams[0];
        item.selectedQuality = item.selectedVideo.label || "";
      });
      info.append(quality);

      if (item.audioStreams?.length) {
        item.selectedAudio = item.selectedAudio || item.audioStreams[0];
        item.selectedAudioLabel = item.selectedAudio.label || "";
        const audioTrack = document.createElement("select");
        audioTrack.className = "quality-select audio-track-select";
        audioTrack.title = "选择 Bilibili 音轨";
        item.audioStreams.forEach((stream, streamIndex) => {
          const option = document.createElement("option");
          option.value = String(streamIndex);
          option.textContent = stream.label || `音频 · ${stream.codecs || "未知编码"}`;
          option.selected = stream.url === item.selectedAudio.url;
          audioTrack.append(option);
        });
        audioTrack.addEventListener("change", () => {
          item.selectedAudio = item.audioStreams[Number(audioTrack.value)] || item.audioStreams[0];
          item.selectedAudioLabel = item.selectedAudio.label || "";
        });
        info.append(audioTrack);
      }
    } else if (item.variants?.length) {
      const quality = document.createElement("select");
      quality.className = "quality-select";
      quality.title = "选择下载清晰度";
      item.variants.forEach((variant) => {
        const option = document.createElement("option");
        option.value = variant.url;
        option.textContent = variant.label;
        quality.append(option);
      });
      quality.addEventListener("change", () => {
        const variant = item.variants.find((candidate) => candidate.url === quality.value);
        item.downloadUrl = quality.value;
        item.selectedQuality = variant?.label || "";
      });
      info.append(quality);
    }
    info.prepend(title, meta);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const button = document.createElement("button");
    button.className = "download-one";
    button.textContent = item.kind === "hls" || item.kind === "bilibili-dash" ? "合并下载" : downloadable ? "下载" : "不支持直下";
    button.disabled = !downloadable;
    const videoFormat = document.createElement("select");
    videoFormat.className = "video-format-select";
    videoFormat.title = "选择视频保存格式";
    [["auto", "视频：自动"], ["mp4", "视频：MP4"], ["ts", "视频：TS"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      videoFormat.append(option);
    });
    videoFormat.disabled = !downloadable;
    videoFormat.addEventListener("change", () => { item.videoFormat = videoFormat.value; });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await downloadItem(item, "video", "auto", videoFormat.value);
        const label = videoFormat.value === "auto" ? "自动选择格式" : `保存为 ${videoFormat.value.toUpperCase()}`;
        showToast(item.kind === "hls" || item.kind === "bilibili-dash" || videoFormat.value !== "auto" ? `已打开下载中心：${label}` : "已交给 Chrome 下载");
      } catch (error) {
        showToast(error.message);
      } finally {
        button.disabled = false;
      }
    });
    const copy = document.createElement("button");
    copy.className = "copy-link";
    copy.textContent = "复制地址";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.selectedVideo?.url || item.downloadUrl || item.url);
        showToast("资源地址已复制");
      } catch (_) {
        showToast("复制失败，请检查剪贴板权限");
      }
    });
    const audio = document.createElement("button");
    audio.className = "download-one audio-one";
    audio.textContent = "仅音频";
    const audioDownloadable = downloadable && (item.kind !== "bilibili-dash" || Boolean(item.audioStreams?.length));
    audio.disabled = !audioDownloadable;
    const audioFormat = document.createElement("select");
    audioFormat.className = "audio-format-select";
    audioFormat.title = "选择音频保存格式";
    [["auto", "音频：自动"], ["mp3", "音频：MP3"], ["flac", "音频：FLAC"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      audioFormat.append(option);
    });
    audioFormat.disabled = !audioDownloadable;
    audio.addEventListener("click", async () => {
      audio.disabled = true;
      try {
        await downloadItem(item, "audio", audioFormat.value);
        const formatLabel = audioFormat.value === "auto" ? "根据源音质自动选择" : `转换为 ${audioFormat.value.toUpperCase()}`;
        showToast(`已打开音频提取页面：${formatLabel}`);
      } catch (error) {
        showToast(error.message);
      } finally {
        audio.disabled = false;
      }
    });
    actions.append(videoFormat, button, audioFormat, audio, copy);
    card.append(checkbox, info, actions);
    elements.mediaList.append(card);
  });

  setState("results");
  updateDownloadButton();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法读取当前标签页");
  currentTabId = tab.id;
  return tab;
}

async function scan() {
  elements.refresh.disabled = true;
  setState("loading");
  try {
    const extensionState = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" });
    extensionEnabled = extensionState?.enabled !== false;
    elements.powerToggle.checked = extensionEnabled;
    if (!extensionEnabled) {
      items = [];
      setState("disabled");
      return;
    }
    const tab = await getActiveTab();
    if (!/^https?:/i.test(tab.url || "")) {
      throw new Error("Chrome 内部页面和扩展商店页面不允许扫描");
    }
    try {
      await chrome.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE" });
    } catch (_) {
      // 新安装扩展后，已打开的旧页面可能还没有 content script；网络结果仍可显示。
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    const response = await chrome.runtime.sendMessage({ type: "GET_MEDIA", tabId: currentTabId });
    if (response?.enabled === false) {
      extensionEnabled = false;
      elements.powerToggle.checked = false;
      items = [];
      setState("disabled");
      return;
    }
    items = response?.items || [];
    await enrichHlsItems();
    render();
  } catch (error) {
    items = [];
    render();
    showToast(error.message);
  } finally {
    elements.refresh.disabled = !extensionEnabled;
    elements.powerToggle.disabled = false;
  }
}

async function downloadItem(item, mode = "video", audioFormat = "auto", videoFormat = "auto") {
  if (item.kind === "bilibili-dash") {
    const selectedVideo = item.selectedVideo || item.videoStreams?.[0];
    const selectedAudio = item.selectedAudio || item.audioStreams?.[0] || null;
    if (!selectedVideo) throw new Error("没有可用的 Bilibili 视频轨");
    if (mode === "audio" && !selectedAudio) throw new Error("没有可用的 Bilibili 音轨");
    const payload = {
      ...item,
      url: selectedVideo.url,
      selectedVideo,
      selectedVideoUrl: selectedVideo.url,
      selectedAudio,
      selectedAudioUrl: selectedAudio?.url || "",
      audioUrl: selectedAudio?.url || "",
      selectedQuality: selectedVideo.label || item.selectedQuality || "",
      selectedAudioLabel: selectedAudio?.label || ""
    };
    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", item: payload, mode, audioFormat, videoFormat });
    if (!response?.ok) throw new Error(response?.error || "Bilibili 下载启动失败");
    return;
  }
  const selectedUrl = mode === "audio" ? item.audioUrl || item.downloadUrl : item.downloadUrl;
  const payload = selectedUrl ? { ...item, url: selectedUrl } : item;
  const selectedVideoFormat = videoFormat === "auto" ? item.videoFormat || "auto" : videoFormat;
  const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", item: payload, mode, audioFormat, videoFormat: selectedVideoFormat });
  if (!response?.ok) throw new Error(response?.error || "下载启动失败");
}

elements.refresh.addEventListener("click", scan);
elements.powerToggle.addEventListener("change", async () => {
  const requestedState = elements.powerToggle.checked;
  elements.powerToggle.disabled = true;
  elements.refresh.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SET_EXTENSION_STATE", enabled: requestedState });
    if (!response?.ok) throw new Error(response?.error || "无法更新工作状态");
    extensionEnabled = response.enabled;
    elements.powerToggle.checked = extensionEnabled;
    if (extensionEnabled) {
      showToast("视频嗅探已开启");
      await scan();
    } else {
      items = [];
      setState("disabled");
      showToast("视频嗅探已暂停");
    }
  } catch (error) {
    elements.powerToggle.checked = extensionEnabled;
    showToast(error.message);
  } finally {
    elements.powerToggle.disabled = false;
    elements.refresh.disabled = !extensionEnabled;
  }
});
document.querySelector("#filters").addEventListener("click", (event) => {
  const button = event.target.closest(".filter");
  if (!button) return;
  activeFilter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach((filter) => filter.classList.toggle("active", filter === button));
  render();
});
elements.selectAll.addEventListener("change", () => {
  document.querySelectorAll(".media-check").forEach((checkbox) => {
    checkbox.checked = elements.selectAll.checked;
  });
  updateDownloadButton();
});

elements.downloadSelected.addEventListener("click", async () => {
  const selected = [...document.querySelectorAll(".media-check:checked")]
    .map((checkbox) => items[Number(checkbox.dataset.index)]);
  if (!selected.length) return;
  elements.downloadSelected.disabled = true;
  let succeeded = 0;
  for (const item of selected) {
    try {
      await downloadItem(item);
      succeeded += 1;
    } catch (error) {
      showToast(error.message);
    }
  }
  showToast(`已启动 ${succeeded}/${selected.length} 个下载`);
  updateDownloadButton();
});

elements.powerToggle.disabled = true;
scan();
