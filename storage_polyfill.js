// ---------------------------------------------------------------------------
// window.storage polyfill (+ read-only shareable-link support)
// ---------------------------------------------------------------------------
// The dashboard was originally written for Claude.ai's artifact sandbox, which
// provides a `window.storage` object (get/set/delete/list) as a hosted service.
// That API doesn't exist in a plain browser context, so this polyfill
// reimplements the exact same signatures on top of plain browser localStorage.
//
// Every key is namespaced under "crdash:" so this app's data can't collide with
// anything else that might use the same local storage origin.
//
// READ-ONLY SHARE LINKS: this site has no backend/database, so a "send this to
// the admin" link works by packaging every key currently in storage into a
// JSON blob, gzip-compressing it, and encoding it into the URL's hash fragment
// (the part after "#"). Hash fragments are never sent to any server, so this
// needs no backend at all -- the whole snapshot travels inside the link itself.
// When a page loads with that hash present, window.storage.get/list are backed
// by the decoded snapshot instead of real localStorage, and set/delete become
// silent no-ops -- so the exact same app code runs, just unable to persist
// anything, with no changes needed to the 4,500-line dashboard itself.
(function () {
  const NS = "crdash:";
  const HASH_PREFIX = "#share=";

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

  // ---- detect a shared read-only link ----
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

  // Builds a shareable read-only link from the REAL underlying localStorage data.
  // Only meaningful when not already viewing a shared link -- exposed for the
  // "Share Read-Only Link" button in index.html.
  // Downloads the current local data as a plain snapshot.json file. Drag that file
  // into the crpdashboard GitHub repo (replacing the old one) to "publish" -- anyone
  // who visits view.html (a permanently read-only page, unlike this editable one) will
  // then see this exact snapshot, and it won't change again until you publish a new one.
  window.__crdashDownloadSnapshotFile__ = function () {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) data[k.slice(NS.length)] = localStorage.getItem(k);
    }
    const payload = JSON.stringify({ data, meta: { createdAt: new Date().toISOString() } });
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snapshot.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return { byteLength: blob.size };
  };

  window.__crdashBuildShareLink__ = async function () {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) data[k.slice(NS.length)] = localStorage.getItem(k);
    }
    const payload = JSON.stringify({ data, __meta__: { createdAt: new Date().toISOString() } });
    const bytes = await gzipCompress(payload);
    const encoded = bytesToBase64Url(bytes);
    const url = location.origin + location.pathname + HASH_PREFIX + encoded;
    return { url, byteLength: bytes.length };
  };
})();
