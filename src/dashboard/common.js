// Shared by the fleet page and the agent page: auth, fetch, SSE, formatting, markdown-lite, toasts.
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const short = (s, n) => (s = String(s ?? ""), s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Resolve auth: open server needs nothing; otherwise a token from ?token=, storage, or a small gate. */
export async function auth() {
  const q = new URLSearchParams(location.search);
  let cfg = { auth: "token", agents: [] };
  try { cfg = await (await fetch("/api/config")).json(); } catch {}
  let token = q.get("token") || localStorage.getItem("golem.token") || "";
  if (q.get("token")) { localStorage.setItem("golem.token", q.get("token")); history.replaceState(null, "", location.pathname); }
  if (cfg.auth === "token" && !token) token = await gate();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const withToken = (url) => token ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : url;
  return { cfg, token, headers, withToken };
}
function gate() {
  return new Promise((resolve) => {
    document.body.innerHTML = `<div class="gate"><form><h1>Golem</h1><p>This Golem is not bound to localhost, so its dashboards need a token. Paste the <code>mcp</code> token from <code>data/&lt;agent&gt;/tokens.json</code>.</p><input placeholder="token" autofocus><button class="btn primary">open</button></form></div>`;
    document.querySelector(".gate form").onsubmit = (e) => { e.preventDefault(); const t = e.target.querySelector("input").value.trim(); if (!t) return; localStorage.setItem("golem.token", t); location.reload(); resolve(t); };
  });
}

export function api(A) {
  const H = { ...A.headers, "content-type": "application/json" };
  return {
    async get(path) { const r = await fetch(path, { headers: A.headers }); if (r.status === 401) { localStorage.removeItem("golem.token"); location.reload(); } if (!r.ok) throw new Error(`${path}: ${r.status}`); const ct = r.headers.get("content-type") || ""; return ct.includes("json") ? r.json() : r.text(); },
    async post(path, body) { const r = await fetch(path, { method: "POST", headers: H, body: JSON.stringify(body || {}) }); return r.json().catch(() => ({ ok: r.ok })); },
  };
}

/** EventSource with reconnect and a status callback; handlers keyed by event type. */
export function stream(url, handlers, onStatus) {
  let es, backoff = 1000;
  const open = () => {
    es = new EventSource(url);
    es.onopen = () => { backoff = 1000; onStatus?.("on"); };
    es.onerror = () => { onStatus?.("off"); es.close(); setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15000); };
    for (const t of Object.keys(handlers)) es.addEventListener(t, (e) => { try { handlers[t](JSON.parse(e.data)); } catch {} });
  };
  open();
  return () => es?.close();
}

let toastTimer;
export function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), 2200);
}

/** Markdown-lite for the shared files: headings, task lines with state, bold, code; optional highlight. */
export function md(text, needle) {
  const hl = (s) => needle ? s.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (m) => `<mark>${m}</mark>`) : s;
  const inline = (s) => hl(esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"));
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); continue; }
    if (needle && !line.toLowerCase().includes(needle.toLowerCase()) && !/^#/.test(line)) continue;
    const h = /^(#+)\s*(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${Math.min(h[1].length, 3)}>${inline(h[2])}</h${Math.min(h[1].length, 3)}>`); continue; }
    const t = /^\s*[-*]\s*\[([ xX~!])\]\s*(.*)$/.exec(line);
    if (t) { flush(); const st = t[1] === " " ? "" : /x/i.test(t[1]) ? "done" : t[1] === "~" ? "wip" : "flag"; out.push(`<div class="task ${st}"><span class="box"></span><span class="txt">${inline(t[2])}</span></div>`); continue; }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) { flush(); out.push(`<div class="line">${inline(b[1])}</div>`); continue; }
    if (/^\s{2,}\S/.test(line) && out.length && /task|line/.test(out[out.length - 1])) { out[out.length - 1] = out[out.length - 1].replace(/<\/span><\/div>$|<\/div>$/, (m) => ` ${inline(line.trim())}${m}`); continue; }
    para.push(line.trim());
  }
  flush();
  return out.join("") || `<div class="empty">nothing here yet</div>`;
}

/** Keep a scroller pinned to the bottom unless the reader scrolled up; returns helpers. */
export function pinned(el, jumpBtn) {
  const atBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  let stick = true;
  el.addEventListener("scroll", () => { stick = atBottom(); jumpBtn?.classList.toggle("hidden", stick); });
  jumpBtn?.addEventListener("click", () => { el.scrollTop = el.scrollHeight; stick = true; jumpBtn.classList.add("hidden"); });
  return { after() { if (stick) el.scrollTop = el.scrollHeight; }, get stuck() { return stick; } };
}

export function hpClass(hp) { return hp <= 6 ? "low" : hp <= 12 ? "mid" : ""; }
export function phaseTag(phase, weather) { if (!phase) return ""; const night = /night|dusk|midnight/.test(phase); return `<span class="tag ${night ? "night" : ""}">${esc(phase)}${weather && weather !== "clear" ? " · " + esc(weather) : ""}</span>`; }
