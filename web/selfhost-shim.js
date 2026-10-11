// Maps the claude.ai artifact runtime (window.claude.use) onto this server's /api routes,
// so web/index.html runs unchanged on both claude.ai and the self-hosted server.
(function () {
  if (window.claude && window.claude.use) return;
  window.__SELFHOST = true;

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.code || "upstream_error", message: j.message || r.statusText };
    return j;
  }

  const mcp = Object.freeze({
    async callTool(server, tool, input, opts) {
      if (opts && opts.cache && opts.cache.refresh && /accounts/.test(tool)) await api("POST", "/api/refresh").catch(() => {});
      const payload = await api("POST", "/api/era/" + encodeURIComponent(tool), input || {});
      return { content: [], payload };
    }
  });

  // Document store with the subset of the artifact db API the page uses.
  const listeners = {};   // coll -> Set of {kind, id, next}
  const snap = (id, data) => ({ id, exists: data != null, data: () => data == null ? undefined : data, metadata: { fromCache: false, hasPendingWrites: false } });
  async function emit(coll) {
    const set = listeners[coll]; if (!set || !set.size) return;
    const rows = await api("GET", "/api/db/" + coll);
    for (const l of set) {
      if (l.kind === "coll") l.next({ docs: rows.map(r => snap(r.id, r.data)), size: rows.length, empty: !rows.length, docChanges: () => [], metadata: {} });
      else { const r = rows.find(x => x.id === l.id); l.next(snap(l.id, r ? r.data : null)); }
    }
  }
  function listen(coll, entry, err) {
    (listeners[coll] = listeners[coll] || new Set()).add(entry);
    emit(coll).catch(e => err && err(e));
    return () => listeners[coll].delete(entry);
  }
  function doc(path) {
    const [coll, id] = path.split("/");
    return {
      id, path,
      get: async () => { const r = await api("GET", `/api/db/${coll}/${id}`); return snap(id, r.data); },
      set: async (data) => { await api("PUT", `/api/db/${coll}/${id}`, data); emit(coll); },
      update: async (data) => { const r = await api("GET", `/api/db/${coll}/${id}`); await api("PUT", `/api/db/${coll}/${id}`, { ...(r.data || {}), ...data }); emit(coll); },
      delete: async () => { await api("DELETE", `/api/db/${coll}/${id}`); emit(coll); },
      onSnapshot: (next, err) => listen(coll, { kind: "doc", id, next }, err)
    };
  }
  function collection(coll) {
    return {
      path: coll,
      doc: (id) => doc(coll + "/" + id),
      get: async () => { const rows = await api("GET", "/api/db/" + coll); return { docs: rows.map(r => snap(r.id, r.data)), size: rows.length, empty: !rows.length }; },
      onSnapshot: (next, err) => listen(coll, { kind: "coll", next }, err)
    };
  }
  const db = Object.freeze({ doc, collection });

  let adviceOn = null;
  async function sample(prompt, opts) {
    const { text } = await api("POST", "/api/advice", { prompt });
    if (opts && opts.onText) opts.onText({ text, delta: text });
    return { text, truncated: false };
  }

  window.claude = Object.freeze({
    use(name) {
      if (name === "mcp") return Promise.resolve(mcp);
      if (name === "db") return Promise.resolve(db);
      if (name === "sample") {
        adviceOn = adviceOn || api("GET", "/api/status").then(s => s.advice ? sample : null).catch(() => null);
        return adviceOn;
      }
      return Promise.resolve(null);
    }
  });
})();
