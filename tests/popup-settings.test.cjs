const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the real popup script and its event handlers without browser dependencies.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async fire(type, extra = {}) {
    const event = { preventDefault() {}, target: this, ...extra };
    for (const listener of this.listeners[type] || []) await listener(event);
  }
  showModal() { this.open = true; }
  close() { this.open = false; for (const listener of this.listeners.close || []) listener(); }
  focus() { this.focused = true; }
}

const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const fixtures = [
  { kind: "direct", url: "https://media.test/direct.mp4", title: "直链" },
  { kind: "hls", url: "https://media.test/list.m3u8", title: "HLS" },
  {
    kind: "bilibili-dash", url: "https://media.test/video.m4s", title: "DASH",
    videoStreams: [{ url: "https://media.test/video.m4s", label: "1080P" }],
    audioStreams: [{ url: "https://media.test/audio.m4s", label: "AAC" }]
  }
];

async function createPopup(storage, options = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const query = (selector) => [...nodes.values()].flatMap(descendants).filter((node) => {
    const [className, state] = selector.slice(1).split(":");
    return node.className.split(" ").includes(className) && (state !== "checked" || node.checked);
  });
  const downloads = [];
  const context = vm.createContext({
    document: {
      body: new Element("body"),
      querySelector: (selector) => get(selector.slice(1)),
      querySelectorAll: query,
      createElement: (tag) => new Element(tag)
    },
    chrome: {
      storage: { local: {
        async get(key) {
          if (options.failRead) throw new Error("storage unavailable");
          return { [key]: storage[key] };
        },
        async set(values) {
          if (options.failSave) throw new Error("storage unavailable");
          Object.assign(storage, structuredClone(values));
        }
      } },
      runtime: { async sendMessage(message) {
        if (message.type === "GET_EXTENSION_STATE") return { enabled: options.enabled !== false };
        if (message.type === "GET_MEDIA") return { items: structuredClone(fixtures), enabled: true };
        if (message.type === "DOWNLOAD_MEDIA") { downloads.push(message); return { ok: true }; }
        throw new Error(`Unexpected message: ${message.type}`);
      } },
      tabs: { query: async () => [{ id: 1, url: "https://page.test/" }], sendMessage: async () => ({}) }
    },
    fetch: async () => ({ ok: true, text: async () => "#EXTM3U\n#EXTINF:2,\npart.ts\n#EXT-X-ENDLIST" }),
    URL, AbortController,
    setTimeout(callback, delay) { if (delay === 180) queueMicrotask(callback); return 1; },
    clearTimeout() {}
  });
  vm.runInContext(source, context, { filename: "popup.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { get, query, downloads, run: (script) => vm.runInContext(script, context) };
}

async function save(popup, video, audio) {
  await popup.get("settingsButton").fire("click");
  popup.get("defaultVideoFormat").value = video;
  popup.get("defaultAudioFormat").value = audio;
  await popup.get("settingsForm").fire("submit");
}

(async () => {
  const fresh = await createPopup({});
  assert.deepEqual(fresh.query(".video-format-select").map((select) => select.value), ["auto", "auto", "auto"]);
  const corrupt = await createPopup({ downloadDefaults: { videoFormat: "exe", audioFormat: "wav" } });
  assert.equal(corrupt.query(".video-format-select")[0].value, "auto");
  assert.equal(corrupt.query(".audio-format-select")[0].value, "auto");

  const storage = { extensionEnabled: true, downloadDefaults: { videoFormat: "ts", audioFormat: "flac" } };
  const popup = await createPopup(storage);
  assert.deepEqual(popup.query(".video-format-select").map((select) => select.value), ["ts", "ts", "ts"]);
  assert.deepEqual(popup.query(".audio-format-select").map((select) => select.value), ["flac", "flac", "flac"]);

  // Real single-download handlers send the selected/default format for all three source types.
  const videoButtons = popup.query(".download-one").filter((button) => !button.className.includes("audio-one"));
  for (const button of videoButtons) await button.fire("click");
  assert.deepEqual(popup.downloads.map((message) => message.videoFormat), ["ts", "ts", "ts"]);
  for (const button of popup.query(".audio-one")) await button.fire("click");
  assert.deepEqual(popup.downloads.slice(3).map((message) => message.audioFormat), ["flac", "flac", "flac"]);

  // A manually selected "auto" must override even a non-auto saved default.
  const firstVideo = popup.query(".video-format-select")[0];
  firstVideo.value = "auto";
  await firstVideo.fire("change");
  const firstAudio = popup.query(".audio-format-select")[0];
  firstAudio.value = "auto";
  await firstAudio.fire("change");
  for (const checkbox of popup.query(".media-check")) checkbox.checked = true;
  await save(popup, "mp4", "mp3");
  assert.deepEqual(storage.downloadDefaults, { videoFormat: "mp4", audioFormat: "mp3" });
  assert.equal(storage.extensionEnabled, true, "format settings must not overwrite the work switch");
  assert.equal(popup.get("settingsDialog").open, false);
  assert.equal(popup.query(".media-check:checked").length, 3, "saving settings preserves selection");
  assert.deepEqual(popup.query(".video-format-select").map((select) => select.value), ["auto", "mp4", "mp4"]);
  assert.deepEqual(popup.query(".audio-format-select").map((select) => select.value), ["auto", "mp3", "mp3"]);
  await popup.get("downloadSelected").fire("click");
  assert.deepEqual(popup.downloads.slice(-3).map((message) => message.videoFormat), ["auto", "mp4", "mp4"]);

  // Render after filter changes must agree with the actual per-resource request formats.
  popup.run("render()");
  assert.equal(popup.query(".video-format-select")[0].value, "auto");
  assert.equal(popup.query(".audio-format-select")[0].value, "auto");
  await popup.run('downloadItem(items[2], "video", undefined, "auto")');
  assert.equal(popup.downloads.at(-1).videoFormat, "auto");
  await popup.run('downloadItem(items[2], "audio", "auto")');
  assert.equal(popup.downloads.at(-1).audioFormat, "auto");

  const reopened = await createPopup(storage);
  assert.deepEqual(reopened.query(".video-format-select").map((select) => select.value), ["mp4", "mp4", "mp4"]);
  await reopened.get("settingsButton").fire("click");
  reopened.get("defaultVideoFormat").value = "ts";
  await reopened.get("cancelSettings").fire("click");
  assert.equal(storage.downloadDefaults.videoFormat, "mp4");
  await reopened.get("settingsButton").fire("click");
  assert.equal(reopened.get("defaultVideoFormat").value, "mp4");

  const failure = await createPopup(storage, { failSave: true });
  await save(failure, "ts", "flac");
  assert.equal(failure.get("settingsDialog").open, true);
  assert.equal(failure.get("settingsError").classList.contains("hidden"), false);
  assert.equal(failure.get("saveSettings").disabled, false);
  assert.equal(storage.downloadDefaults.videoFormat, "mp4");
  assert.equal(failure.query(".video-format-select")[0].value, "mp4");

  const paused = await createPopup(storage, { enabled: false });
  assert.equal(paused.get("settingsButton").disabled, false);
  await save(paused, "auto", "auto");
  assert.deepEqual(storage.downloadDefaults, { videoFormat: "auto", audioFormat: "auto" });
  const readFailure = await createPopup(storage, { failRead: true });
  assert.equal(readFailure.query(".video-format-select")[0].value, "auto");
  console.log("Default formats: persistence, controls, individual/batch downloads, overrides and errors: OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
