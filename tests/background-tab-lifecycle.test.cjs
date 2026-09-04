const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createBackground() {
  const tabId = 371572730;
  const liveTabs = new Set([tabId]);
  const listeners = {};
  const calls = [];
  const warnings = [];
  const session = new Map([["hls_job_active", { mode: "video" }]]);
  let synchronous = false;
  let actionError;
  const action = (method) => (details) => {
    const apply = () => {
      if (actionError) throw actionError;
      if (details.tabId !== undefined && !liveTabs.has(details.tabId)) {
        throw new Error(`No tab with id: ${details.tabId}.`);
      }
      calls.push({ method, ...details });
    };
    return synchronous ? apply() : Promise.resolve().then(apply);
  };
  const chrome = {
    action: {
      setIcon: async () => {}, setTitle: async () => {},
      setBadgeText: action("setBadgeText"),
      setBadgeBackgroundColor: action("setBadgeBackgroundColor")
    },
    storage: {
      local: { get: async () => ({ extensionEnabled: true }), set: async () => {} },
      session: {
        get: async (key) => key === null ? Object.fromEntries(session) : { [key]: session.get(key) },
        set: async (values) => Object.entries(values).forEach(([key, value]) => session.set(key, value)),
        remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((key) => session.delete(key))
      }
    },
    tabs: {
      query: async () => [...liveTabs].map((id) => ({ id })),
      sendMessage: async () => {},
      onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } }
    },
    runtime: {
      id: "test-extension",
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => { listeners.message = fn; } }
    },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    webRequest: { onHeadersReceived: { addListener: (fn) => { listeners.headers = fn; } } }
  };
  const context = vm.createContext({ chrome, URL, console: { warn: (...args) => warnings.push(args) } });
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    tabId, liveTabs, listeners, calls, warnings, session, context,
    setSynchronous(value) { synchronous = value; },
    setActionError(value) { actionError = value; },
    message: (message, sender = {}) => new Promise((resolve) => listeners.message(message, sender, resolve)),
    headers: () => listeners.headers({ tabId, url: "https://media.test/video.mp4", responseHeaders: [] })
  };
}

(async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const bg = createBackground();
    await vm.runInContext("extensionStateReady", bg.context);

    // A live tab still gets the detected-resource count and loading reset.
    bg.headers();
    await flush();
    assert.ok(bg.calls.some((call) => call.tabId === bg.tabId && call.text === "1"));
    assert.ok(bg.calls.some((call) => call.tabId === bg.tabId && call.color === "#18855d"));
    bg.listeners.updated(bg.tabId, { status: "loading" });
    await flush();
    assert.equal(bg.calls.at(-1).text, "");

    // Close after a badge request has started but before Chrome resolves it.
    bg.headers();
    bg.liveTabs.delete(bg.tabId);
    bg.listeners.removed(bg.tabId);
    await flush();
    assert.equal(bg.session.has(`media_tab_${bg.tabId}`), false);
    assert.equal(bg.session.has("hls_job_active"), true, "closing a source tab must not remove download jobs");

    // Loading notifications, network responses, and page reports may arrive late.
    bg.listeners.updated(bg.tabId, { status: "loading" });
    bg.headers();
    await bg.message({ type: "PAGE_MEDIA", items: [{ url: "https://media.test/late.mp4" }] }, { tab: { id: bg.tabId } });
    await flush();
    assert.deepEqual(unhandled.map((error) => error.message), [], "closed-tab badge updates must not reject unhandled");
    assert.equal(bg.warnings.length, 0, "normal tab closure should be quiet");

    // Also catch synchronous API errors without interrupting media handling.
    bg.setSynchronous(true);
    assert.doesNotThrow(() => bg.headers());
    assert.doesNotThrow(() => bg.listeners.updated(bg.tabId, { status: "loading" }));
    await flush();
    assert.equal(bg.warnings.length, 0);
    bg.setSynchronous(false);

    // Invalid IDs must never trigger tab-scoped actions.
    const before = bg.calls.length;
    for (const tabId of [-1, NaN, null, undefined, Infinity, 1.5, "371572730"]) {
      bg.context.testTabId = tabId;
      assert.equal(vm.runInContext("mergeItems(testTabId, [])", bg.context).length, 0);
    }
    await flush();
    assert.equal(bg.calls.length, before);

    // Unrelated failures remain visible as diagnostics, not silently swallowed.
    bg.liveTabs.add(bg.tabId);
    bg.setActionError(new Error("Unexpected action failure"));
    bg.headers();
    await flush();
    assert.ok(bg.warnings.some((args) => args.some((arg) => arg?.message === "Unexpected action failure")));
    assert.deepEqual(unhandled.map((error) => error.message), []);
    console.log("Tab lifecycle: normal updates, close races, late events, sync errors and diagnostics: OK");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
