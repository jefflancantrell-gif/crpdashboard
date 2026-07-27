// ---------------------------------------------------------------------------
// window.storage polyfill (+ read-only shareable-link support)
// ---------------------------------------------------------------------------
// The dashboard was originally written for Claude.ai's artifact sandbox, which
// provides a `window.storage` object (get/set/delete/list) as a hosted service.
// That API doesn't exist in a plain desktop browser/WebView2 context, so this
// polyfill reimplements the exact same signatures on top of plain browser
// localStorage, which WebView2/Edge app-mode supports natively and which
// persists to disk between runs of the app on this machine.
//
// Every key is namespaced under "crdash:" so this app's data can't collide with
// anything else that might use the same local storage origin.
//
// READ-ONLY SHARE LINKS: this desktop copy runs from a local file:// path, so a
// link built from location.href would only work on a computer with this exact
// app installed at this exact path -- useless for sending to someone remote.
// Instead, the snapshot (everything currently in local storage, gzip-compressed
// and encoded into a URL hash fragment -- which browsers never send to any
// server) is attached to the SHARED_VIEWER_URL below: your already-live Netlify
// copy of this dashboard. That site is a universal "viewer" for any snapshot,
// regardless of which machine generated it. When that page loads with the hash
// present, its own copy of this same polyfill decodes the snapshot and serves
// window.storage.get/list from it instead of real localStorage, while set/delete
// become silent no-ops -- so the exact same app code runs there, just unable to
// persist anything.
(function () {
  const NS = "crdash:";
  const HASH_PREFIX = "#share=";
  const SHARED_VIEWER_URL = "https://vermillion-crisp-55e05b.netlify.app/";

  // ---- byte <-> base64url helpers (URL-safe: no +, /, or = padding) ----
  function bytesToBase64Url(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(b64url) {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async function gzipCompress(str) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function gzipDecompress(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buf);
  }

  // ---- detect a shared read-only link (only relevant if this exact file were
  // ever opened directly with a #share= hash -- included for parity/testing,
  // though the normal path is opening SHARED_VIEWER_URL instead) ----
  const isSharedLink = !!(location.hash && location.hash.indexOf(HASH_PREFIX) === 0);
  window.__CRDASH_READONLY__ = isSharedLink;

  let snapshotPromise = null; // resolves to a Map(key -> value) once decoded
  if (isSharedLink) {
    const encoded = location.hash.slice(HASH_PREFIX.length);
    snapshotPromise = (async () => {
      const bytes = base64UrlToBytes(encoded);
      const json = await gzipDecompress(bytes);
      const parsed = JSON.parse(json);
      window.__CRDASH_SNAPSHOT_META__ = parsed.__meta__ || null;
      return new Map(Object.entries(parsed.data || {}));
    })();
    window.__crdashSnapshotReady__ = snapshotPromise;
  }

  window.storage = {
    async set(key, value) {
      if (isSharedLink) return { key, value, shared: false }; // read-only: no-op, not persisted
      try {
        localStorage.setItem(NS + key, value);
        return { key, value, shared: false };
      } catch (e) {
        // localStorage is full (rare, but the dashboard already has retry/backoff
        // logic built in for exactly this kind of failure) -- surface it the same
        // way a real storage-quota error would look.
        throw new Error("rate limit: local storage quota exceeded — " + e.message);
      }
    },

    async get(key) {
      if (isSharedLink) {
        const map = await snapshotPromise;
        return { key, value: map.has(key) ? map.get(key) : null, shared: false };
      }
      const value = localStorage.getItem(NS + key);
      if (value === null) return { key, value: null, shared: false };
      return { key, value, shared: false };
    },

    async delete(key) {
      if (isSharedLink) return { key, deleted: true, shared: false }; // read-only: no-op
      localStorage.removeItem(NS + key);
      return { key, deleted: true, shared: false };
    },

    async list(prefix) {
      if (isSharedLink) {
        const map = await snapshotPromise;
        const keys = [];
        for (const k of map.keys()) if (k.startsWith(prefix)) keys.push(k);
        return { keys, prefix, shared: false };
      }
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS) && k.slice(NS.length).startsWith(prefix)) {
          keys.push(k.slice(NS.length));
        }
      }
      return { keys, prefix, shared: false };
    },
  };

  // Builds a shareable read-only link from THIS machine's local storage data,
  // pointed at the hosted Netlify viewer rather than this file's own file://
  // location, so the link actually works for whoever you send it to.
  window.__crdashBuildShareLink__ = async function () {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) data[k.slice(NS.length)] = localStorage.getItem(k);
    }
    const payload = JSON.stringify({ data, __meta__: { createdAt: new Date().toISOString() } });
    const bytes = await gzipCompress(payload);
    const encoded = bytesToBase64Url(bytes);
    const url = SHARED_VIEWER_URL + HASH_PREFIX + encoded;
    return { url, byteLength: bytes.length };
  };
})();
