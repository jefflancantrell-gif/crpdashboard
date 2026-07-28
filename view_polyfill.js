// ---------------------------------------------------------------------------
// view.html's polyfill -- permanently read-only, no exceptions
// ---------------------------------------------------------------------------
// Unlike storage_polyfill.js (the editable copy, backed by real localStorage,
// with an optional #share=... hash for one-off links), this page ALWAYS runs
// read-only and ALWAYS sources its data from snapshot.json sitting next to it
// in this same repo. There is no hash, no localStorage, no upload path here --
// visiting this URL can never show anything other than whatever snapshot.json
// currently contains, and whatever you see here can never be edited or saved.
//
// To change what this page shows, publish a new snapshot.json from the
// editable copy's "⬇️ Publish view-only snapshot" button and upload it here,
// replacing the old file. This page then reflects that instantly for anyone
// who (re)loads it -- no rebuild or redeploy step needed beyond that one file.
(function () {
  window.__CRDASH_READONLY__ = true;

  const ready = (async () => {
    const res = await fetch("snapshot.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(
        "snapshot.json not found (HTTP " + res.status + "). " +
        "Has a view-only snapshot been published to this repo yet?"
      );
    }
    const parsed = await res.json();
    window.__CRDASH_SNAPSHOT_META__ = parsed.meta || null;
    return new Map(Object.entries(parsed.data || {}));
  })();
  window.__crdashSnapshotReady__ = ready;

  window.storage = {
    async set(key, value) { return { key, value, shared: false }; }, // permanently read-only: no-op
    async get(key) {
      const map = await ready;
      return { key, value: map.has(key) ? map.get(key) : null, shared: false };
    },
    async delete(key) { return { key, deleted: true, shared: false }; }, // permanently read-only: no-op
    async list(prefix) {
      const map = await ready;
      const keys = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) keys.push(k);
      return { keys, prefix, shared: false };
    },
  };
})();
