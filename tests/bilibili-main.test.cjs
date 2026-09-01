const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const messages = [];
const listeners = new Map();

function MockXMLHttpRequest() {}
MockXMLHttpRequest.prototype.open = function () {};
MockXMLHttpRequest.prototype.addEventListener = function () {};

const window = {
  __playinfo__: {
    code: 0,
    data: {
      timelength: 120000,
      dash: {
        duration: 120,
        video: [
          {
            id: 80,
            baseUrl: "https://video.example.com/1080.m4s?token=1",
            backupUrl: ["https://backup.example.com/1080.m4s?token=1"],
            bandwidth: 4000000,
            mimeType: "video/mp4",
            codecs: "avc1.640032",
            width: 1920,
            height: 1080,
            frameRate: "60/1"
          },
          {
            id: 64,
            base_url: "https://video.example.com/720.m4s?token=1",
            bandwidth: 2000000,
            mime_type: "video/mp4",
            codecs: "hev1.1.6.L120.90",
            width: 1280,
            height: 720,
            frame_rate: "30"
          }
        ],
        audio: [{
          id: 30280,
          baseUrl: "https://audio.example.com/aac.m4s?token=1",
          bandwidth: 192000,
          mimeType: "audio/mp4",
          codecs: "mp4a.40.2"
        }],
        flac: {
          audio: {
            id: 30251,
            baseUrl: "https://audio.example.com/flac.m4s?token=1",
            bandwidth: 900000,
            mimeType: "audio/mp4",
            codecs: "fLaC"
          }
        }
      }
    }
  },
  fetch: async () => ({ url: "", clone: () => ({ json: async () => ({}) }) }),
  XMLHttpRequest: MockXMLHttpRequest,
  addEventListener(type, listener) { listeners.set(type, listener); },
  postMessage(message) { messages.push(message); }
};

const context = {
  window,
  document: {
    title: "测试视频_哔哩哔哩_bilibili",
    querySelector() { return { getAttribute: () => "测试视频", textContent: "测试视频" }; }
  },
  location: {
    origin: "https://www.bilibili.com",
    pathname: "/video/BV1test",
    search: "?p=1"
  },
  setInterval() { return 1; },
  URL,
  Reflect
};

const source = fs.readFileSync(path.join(root, "bilibili-main.js"), "utf8");
vm.runInNewContext(source, context, { filename: "bilibili-main.js" });

assert.equal(messages.length, 1, "initial play info should emit one DASH item");
const item = messages[0].item;
assert.equal(item.kind, "bilibili-dash");
assert.equal(item.title, "测试视频");
assert.equal(item.videoStreams.length, 2);
assert.equal(item.videoStreams[0].height, 1080);
assert.match(item.videoStreams[0].label, /1080P.*60fps.*H\.264/);
assert.equal(item.audioStreams.length, 2);
assert.equal(item.audioStreams[0].codecs, "fLaC");
assert.equal(item.duration, 120);
assert.ok(item.size > 0);

const mainWorldMessageListener = listeners.get("message");
window.__playinfo__.data.dash.video[0].baseUrl = "https://video.example.com/1080-new.m4s?token=2";
mainWorldMessageListener({ source: window, data: { type: "VIDEO_DOWNLOADER_BILIBILI_STATE", enabled: false } });
mainWorldMessageListener({ source: window, data: { type: "VIDEO_DOWNLOADER_REQUEST_BILIBILI_DASH" } });
assert.equal(messages.length, 1, "disabled Bilibili bridge should not emit play data");
mainWorldMessageListener({ source: window, data: { type: "VIDEO_DOWNLOADER_BILIBILI_STATE", enabled: true } });
assert.equal(messages.length, 2, "re-enabled Bilibili bridge should immediately rescan play data");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.ok(Number(manifest.minimum_chrome_version) >= 102);
assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
assert.ok(manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.js.includes("bilibili-main.js")));
assert.equal(manifest.action.default_icon[16], "icons/icon16.png");
for (const size of [16, 32, 48, 128]) {
  for (const prefix of ["icon", "icon-off"]) {
    const png = fs.readFileSync(path.join(root, "icons", `${prefix}${size}.png`));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
}
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
assert.match(popupHtml, /id="extensionEnabled"/);
assert.match(popupHtml, /id="disabled"/);

let backgroundMessageListener;
const stored = new Map();
const localSettings = new Map([["extensionEnabled", true]]);
const tabMessages = [];
let currentIconPath;
const chrome = {
  runtime: {
    id: "test-extension-id",
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { backgroundMessageListener = listener; } },
    getURL(value) { return `chrome-extension://test-extension-id/${value}`; }
  },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
  webRequest: { onHeadersReceived: { addListener() {} } },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    create: async () => ({ id: 2 }),
    query: async () => [{ id: 1 }],
    sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message }); }
  },
  storage: {
    session: {
      async set(values) { Object.entries(values).forEach(([key, value]) => stored.set(key, value)); },
      async get(key) { return key === null ? Object.fromEntries(stored) : { [key]: stored.get(key) }; },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => stored.delete(key)); }
    },
    local: {
      async get(key) { return { [key]: localSettings.get(key) }; },
      async set(values) { Object.entries(values).forEach(([key, value]) => localSettings.set(key, value)); }
    }
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText() {},
    async setIcon({ path: iconPath }) { currentIconPath = iconPath; },
    async setTitle() {}
  },
  downloads: { download: async () => 1 }
};
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
vm.runInNewContext(backgroundSource, { chrome, crypto: require("node:crypto").webcrypto, URL, Map, console });
assert.equal(typeof backgroundMessageListener, "function");

(async () => {
await new Promise((resolve) => setImmediate(resolve));
assert.equal(currentIconPath[16], "icons/icon16.png");

let mergedResponse;
backgroundMessageListener({
  type: "PAGE_MEDIA",
  items: [
    { kind: "blob", url: "blob:https://www.bilibili.com/test", title: "临时流" },
    item
  ]
}, { tab: { id: 1 } }, (response) => { mergedResponse = response; });
assert.equal(mergedResponse.items.length, 1, "Bilibili DASH should replace the temporary blob item");
assert.equal(mergedResponse.items[0].kind, "bilibili-dash");
assert.equal(mergedResponse.items[0].selectedVideo.height, 1080);
assert.equal(mergedResponse.items[0].selectedAudio.codecs, "fLaC");

function sendBackgroundMessage(message, sender = {}) {
  return new Promise((resolve) => backgroundMessageListener(message, sender, resolve));
}
const disabledState = await sendBackgroundMessage({ type: "SET_EXTENSION_STATE", enabled: false });
assert.equal(disabledState.enabled, false);
assert.equal(localSettings.get("extensionEnabled"), false);
assert.equal(currentIconPath[16], "icons/icon-off16.png");
assert.ok(tabMessages.some(({ message }) => message.type === "SET_EXTENSION_ENABLED" && message.enabled === false));
const ignoredWhileDisabled = await sendBackgroundMessage({ type: "PAGE_MEDIA", items: [item] }, { tab: { id: 1 } });
assert.equal(ignoredWhileDisabled.items.length, 0);
const enabledState = await sendBackgroundMessage({ type: "SET_EXTENSION_STATE", enabled: true });
assert.equal(enabledState.enabled, true);
assert.equal(currentIconPath[16], "icons/icon16.png");

let observerDisconnected = false;
class MockMutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() { observerDisconnected = true; }
}
const invalidatedContentContext = {
  chrome: {
    runtime: {
      sendMessage() { throw new Error("Extension context invalidated."); },
      onMessage: { addListener() {} }
    }
  },
  window: {
    addEventListener() {},
    postMessage() {}
  },
  document: {
    baseURI: "https://example.com/",
    title: "测试页面",
    documentElement: {},
    querySelectorAll() { return []; },
    addEventListener() {}
  },
  location: { hostname: "example.com", origin: "https://example.com" },
  performance: { getEntriesByType() { return []; } },
  MutationObserver: MockMutationObserver,
  URL,
  clearTimeout() {},
  setTimeout(callback) { callback(); return 1; }
};
invalidatedContentContext.window.window = invalidatedContentContext.window;
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.doesNotThrow(() => vm.runInNewContext(contentSource, invalidatedContentContext, { filename: "content.js" }));
assert.equal(observerDisconnected, true, "invalidated extension context should stop the media observer");

for (const filename of ["background.js", "content.js", "popup.js", "hls-downloader.js"]) {
  const script = fs.readFileSync(path.join(root, filename), "utf8");
  assert.doesNotThrow(() => new Function(script), `${filename} should parse`);
}

console.log("Bilibili DASH, icon assets, and global work-state tests: OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
