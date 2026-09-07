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

/* ---- body + inventory helpers (agent page "Body" panel, fleet card hotbar) ---- */

/** "minecraft:iron_pickaxe" / "iron_pickaxe" -> "iron pickaxe". */
export const itemLabel = (id) => String(id ?? "").replace(/^minecraft:/, "").replace(/_/g, " ");

/** A tint class for an item id so the grid reads at a glance: material first, then category. */
export function tint(id) {
  const s = String(id ?? "").replace(/^minecraft:/, "");
  if (!s) return "";
  if (/netherite/.test(s)) return "t-netherite";
  if (/diamond/.test(s)) return "t-diamond";
  if (/^gold|golden|gold_/.test(s)) return "t-gold";
  if (/emerald|lapis|amethyst/.test(s)) return "t-gem";
  if (/redstone|tnt|magma|lava|fire/.test(s)) return "t-red";
  if (/_ore$|raw_/.test(s)) return "t-ore";
  if (/^iron|chainmail|shield|anvil|bucket|shears|flint_and|compass|clock/.test(s)) return "t-iron";
  if (/apple|bread|beef|pork|mutton|chicken|cod|salmon|melon|carrot|potato|stew|soup|cookie|cake|pie|berries|kelp|rabbit|honey|bottle/.test(s)) return "t-food";
  if (/log|planks|wood|stick|bamboo|sapling|leaves|boat|chest$|crafting|door|fence|sign|bed|ladder|bowl/.test(s)) return "t-wood";
  if (/stone|cobble|deepslate|andesite|diorite|granite|brick|gravel|sand|dirt|grass|clay|obsidian|netherrack|basalt|blackstone|terracotta/.test(s)) return "t-stone";
  if (/torch|lantern|glowstone|candle/.test(s)) return "t-light";
  if (/string|wool|leather|feather|bone|arrow|bow|paper|book|map|ender|pearl|blaze|rod|eye/.test(s)) return "t-misc";
  return "";
}

/** One inventory cell. `item` may be undefined (empty). `opts.ph` is a placeholder word for armour slots; `opts.sel` marks the selected hotbar slot. */
export function slotHtml(item, opts = {}) {
  if (!item) return `<span class="slot ${opts.ph ? "ph" : ""} ${opts.sel ? "sel" : ""}" title="${esc(opts.ph || "empty")}">${opts.ph ? esc(opts.ph) : ""}</span>`;
  const label = itemLabel(item.item);
  return `<span class="slot full ${tint(item.item)} ${opts.sel ? "sel" : ""}" title="${esc(label)} ×${item.count} (slot ${item.slot})">${esc(label)}${item.count > 1 ? `<b class="n">${item.count}</b>` : ""}</span>`;
}

/** Minecraft day ticks -> "HH:MM" on the in-game clock (0 ticks = 06:00). */
export function mcClock(time) {
  if (time == null) return "";
  const t = ((Number(time) % 24000) + 24000) % 24000;
  const mins = Math.floor(((t + 6000) % 24000) / 24000 * 1440);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** Yaw (Minecraft: 0 = south, 90 = west, -90 = east, 180 = north) -> compass word. */
export function facing(yaw) {
  const y = (((Number(yaw) % 360) + 360 + 22.5) % 360);
  return ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"][Math.floor(y / 45)] || "";
}

export const fmtK = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
export const ago = (ms) => ms == null ? "–" : ms < 1500 ? "just now" : ms < 60000 ? `${Math.round(ms / 1000)}s ago` : ms < 3600000 ? `${Math.round(ms / 60000)}m ago` : `${(ms / 3600000).toFixed(1)}h ago`;
export const dur = (ms) => ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 3600000).toFixed(1)}h`;

/** Compact bar: `<span class="bar"><i style="width:.."></i></span>`; `cls` adds hp/food/xp/hot etc. */
export const barHtml = (pct, cls = "") => `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></span>`;
