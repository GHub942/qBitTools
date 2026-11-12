"use strict";

const $ = (id) => document.getElementById(id);
let torrents = [];
const selected = new Set();
let jobTimer = null;
let rules = [];
let page = 1;
let pageSize = 50;
let connected = false;
let sort = { key: null, dir: 1 };
let detailData = null;
let pendingAction = null;

// ---------- API ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });

function fmtSize(b) {
  if (b == null) return "";
  const u = ["o", "Kio", "Mio", "Gio", "Tio", "Pio"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + u[i];
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Toasts ----------
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ---------- Confirm custom ----------
let confirmResolve = null;
function confirmDialog(msg, { danger = false, title = "Confirmer", extra = "" } = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = msg;
    $("confirm-extra").innerHTML = extra;
    const yes = $("confirm-yes");
    yes.className = `btn ${danger ? "danger-solid" : "primary"}`;
    $("confirm-modal").classList.remove("hidden");
  });
}
function closeConfirm(v) {
  $("confirm-modal").classList.add("hidden");
  if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
}
$("confirm-yes").onclick = () => closeConfirm(true);
$("confirm-no").onclick = () => closeConfirm(false);
$("confirm-modal").onclick = (e) => { if (e.target === $("confirm-modal")) closeConfirm(false); };

// ---------- Routing ----------
const ROUTES = ["torrents", "rewrite", "actions", "history"];

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  return ROUTES.includes(h) ? h : "torrents";
}
function navigate(route) {
  if (("#/" + route) !== location.hash) location.hash = "#/" + route;
  else route();
}
function route() {
  if (!connected) {
    document.querySelectorAll(".module").forEach((m) => m.classList.add("hidden"));
    $("job-card").classList.add("hidden");
    return;
  }
  const r = currentRoute();
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === r));
  document.querySelectorAll(".module").forEach((m) => {
    const show = m.id === "mod-" + r;
    m.classList.toggle("hidden", !show);
    if (show) replayAnim(m);
  });
}
function replayAnim(el) {
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}
document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => navigate(t.dataset.tab); });
window.addEventListener("hashchange", route);

// ---------- Connexion ----------
$("btn-connect").onclick = async () => {
  const msg = $("connect-msg");
  msg.className = "";
  msg.textContent = "Connexion…";
  const res = await post("/api/connect", {
    host: $("qb-host").value.trim(),
    port: parseInt($("qb-port").value, 10),
    username: $("qb-user").value.trim(),
    password: $("qb-pass").value,
  });
  if (res.ok) {
    msg.className = "ok";
    msg.textContent = `Connecté — ${res.n_torrents} torrent(s).`;
    $("qb-pass").value = "";
    saveConnPref();
    connected = true;
    showApp();
    loadTorrents();
    loadHistory();
    navigate("torrents");
    toast(`Connecté — ${res.n_torrents} torrents`, "ok");
  } else {
    msg.className = "err";
    msg.textContent = res.error || "Échec de connexion.";
  }
};

function saveConnPref() {
  localStorage.setItem("qbtool-conn", JSON.stringify({
    host: $("qb-host").value, port: $("qb-port").value, user: $("qb-user").value,
  }));
}
function loadConnPref() {
  try {
    const p = JSON.parse(localStorage.getItem("qbtool-conn") || "{}");
    if (p.host) $("qb-host").value = p.host;
    if (p.port) $("qb-port").value = p.port;
    if (p.user) $("qb-user").value = p.user;
  } catch {}
}
$("btn-disconnect").onclick = async () => {
  await post("/api/disconnect");
  connected = false;
  location.reload();
};

async function showApp() {
  const st = await api("/api/status");
  $("conn-status").textContent = `${st.info.username}@${st.info.host}:${st.info.port}`;
  $("conn-dot").classList.add("on");
  $("btn-disconnect").classList.remove("hidden");
  $("tabs").classList.remove("hidden");
  $("connect-card").classList.add("hidden");
  route();
}

// ---------- Torrents ----------
async function loadTorrents() {
  torrents = await api("/api/torrents");
  buildFilters();
  page = 1;
  render();
}

function tagsOf(t) {
  return (t.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function buildFilters() {
  const cats = [...new Set(torrents.map((t) => t.category || "(sans catégorie)"))].sort();
  const tags = [...new Set(torrents.flatMap(tagsOf))].sort();
  $("f-cats").innerHTML = cats
    .map((c) => `<label class="chk"><input type="checkbox" class="f-cat" value="${esc(c)}"> ${esc(c)}</label>`)
    .join("");
  $("f-tags").innerHTML = tags
    .map((g) => `<label class="chk"><input type="checkbox" class="f-tag" value="${esc(g)}"> #${esc(g)}</label>`)
    .join("");
  document.querySelectorAll(".f-cat,.f-tag").forEach((el) => (el.onchange = () => { page = 1; render(); }));
  $("f-search").oninput = () => { page = 1; render(); };
}

function filtered() {
  const q = $("f-search").value.trim().toLowerCase();
  const cats = new Set([...document.querySelectorAll(".f-cat:checked")].map((e) => e.value));
  const tags = new Set([...document.querySelectorAll(".f-tag:checked")].map((e) => e.value));
  let rows = torrents.filter((t) => {
    if (q && !t.name.toLowerCase().includes(q)) return false;
    if (cats.size && !cats.has(t.category || "(sans catégorie)")) return false;
    if (tags.size && !tagsOf(t).some((g) => tags.has(g))) return false;
    return true;
  });
  if (sort.key) {
    const k = sort.key, d = sort.dir;
    rows = [...rows].sort((a, b) => {
      let va = a[k], vb = b[k];
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      va = va ?? -Infinity; vb = vb ?? -Infinity;
      return (va < vb ? -1 : va > vb ? 1 : 0) * d;
    });
  }
  return rows;
}

function render() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);

  $("tbody").innerHTML = slice
    .map((t, i) => `<tr class="tr" style="animation-delay:${Math.min(i * 15, 400)}ms">
      <td class="c-check"><input type="checkbox" class="row-chk" data-h="${t.hash}" ${selected.has(t.hash) ? "checked" : ""}></td>
      <td class="name link" data-h="${t.hash}" title="${esc(t.name)} — clic pour détails">${esc(t.name)}</td>
      <td>${esc(t.category)}</td>
      <td>${esc(tagsOf(t).map((g) => "#" + g).join(" "))}</td>
      <td class="trk-cell num" data-h="${t.hash}">${t.scanned ? t.n_trackers : "?"}</td>
      <td class="num">${fmtSize(t.size)}</td>
      <td class="num">${t.progress}%</td>
      <td>${esc(t.state)}</td>
    </tr>`).join("");
  $("empty-msg").classList.toggle("hidden", rows.length > 0);

  document.querySelectorAll(".row-chk").forEach((el) => {
    el.onchange = () => {
      el.checked ? selected.add(el.dataset.h) : selected.delete(el.dataset.h);
      updateSelCount();
    };
  });
  document.querySelectorAll(".trk-cell").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); showTrackers(el.dataset.h); };
  });
  document.querySelectorAll("td.name.link").forEach((el) => {
    el.onclick = () => showDetail(el.dataset.h);
  });
  $("chk-all").checked = slice.length > 0 && slice.every((t) => selected.has(t.hash));
  $("chk-all").indeterminate = !$("chk-all").checked && slice.some((t) => selected.has(t.hash));
  updateSelCount();
  renderPager(rows.length, pages);
  renderSortHeaders();
}

// ---------- Tri ----------
const SORTABLE = { name: "Nom", category: "Catégorie", size: "Taille", progress: "Prog.", n_trackers: "Trackers", state: "État" };
function renderSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const k = th.dataset.sort;
    th.classList.toggle("sorted", sort.key === k);
    th.classList.toggle("asc", sort.key === k && sort.dir === 1);
    th.classList.toggle("desc", sort.key === k && sort.dir === -1);
  });
}
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.sort;
    if (sort.key === k) sort.dir *= -1;
    else { sort.key = k; sort.dir = 1; }
    render();
  };
});

function renderPager(total, pages) {
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  $("pager-info").textContent = total ? `${from}–${to} sur ${total}` : "0 torrent";
  const btn = (label, p, cls = "") =>
    `<button class="btn sm ${cls}" data-p="${p}" ${p < 1 || p > pages ? "disabled" : ""}>${label}</button>`;
  let nums = "";
  const win = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) win.push(p);
  if (win[0] > 1) nums += `<span class="dots">…</span>`;
  win.forEach((p) => { nums += btn(p, p, p === page ? "cur primary" : ""); });
  if (win[win.length - 1] < pages) nums += `<span class="dots">…</span>`;
  $("pager-controls").innerHTML = btn("‹", page - 1) + nums + btn("›", page + 1);
  document.querySelectorAll("#pager-controls button[data-p]").forEach((b) => {
    b.onclick = () => { page = parseInt(b.dataset.p, 10); render(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  });
}

$("page-size").onchange = (e) => { pageSize = parseInt(e.target.value, 10); page = 1; render(); };
function updateSelCount() {
  $("sel-count").textContent = selected.size;
  $("action-count").textContent = selected.size;
}
$("chk-all").onchange = (e) => {
  const slice = filtered().slice((page - 1) * pageSize, page * pageSize);
  slice.forEach((t) => (e.target.checked ? selected.add(t.hash) : selected.delete(t.hash)));
  render();
};
$("btn-select-filtered").onclick = () => { filtered().forEach((t) => selected.add(t.hash)); render(); };
$("btn-select-page").onclick = () => {
  filtered().slice((page - 1) * pageSize, page * pageSize).forEach((t) => selected.add(t.hash));
  render();
};
$("btn-clear").onclick = () => { selected.clear(); render(); };

// ---------- Modal trackers (simple) ----------
async function showTrackers(h) {
  const t = torrents.find((x) => x.hash === h);
  $("modal-title").textContent = t ? t.name : h;
  $("modal-body").textContent = "Chargement…";
  $("modal").classList.remove("hidden");
  const list = await api(`/api/trackers?hash=${h}`);
  if (list.error) { $("modal-body").textContent = list.error; return; }
  $("modal-body").textContent = list
    .map((tr) => `[${tr.tier}] ${tr.url}\n    statut=${tr.status} ${tr.msg || ""}`)
    .join("\n");
}
$("modal-close").onclick = () => $("modal").classList.add("hidden");
$("modal").onclick = (e) => { if (e.target === $("modal")) $("modal").classList.add("hidden"); };

// ---------- Modal torrent détaillé ----------
async function showDetail(h) {
  const t = torrents.find((x) => x.hash === h);
  $("detail-title").textContent = t ? t.name : h;
  $("detail-body").innerHTML = '<div class="sub" style="padding:20px">Chargement…</div>';
  $("detail-modal").classList.remove("hidden");
  const d = await post("/api/torrent-detail", { hash: h });
  if (d.error) { $("detail-body").innerHTML = `<div class="sub" style="padding:20px">${esc(d.error)}</div>`; return; }
  detailData = d;
  renderDetailTab("info");
}
function renderDetailTab(tab) {
  document.querySelectorAll(".dtab").forEach((b) => b.classList.toggle("active", b.dataset.dtab === tab));
  const d = detailData;
  if (!d) return;
  const body = $("detail-body");
  if (tab === "info") {
    const p = d.properties || {};
    const rows = Object.entries(p)
      .filter(([k]) => !k.startsWith("pieces") && k !== "files")
      .map(([k, v]) => `<tr><td class="kv-k">${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</td></tr>`)
      .join("");
    body.innerHTML = `<div class="table-card"><table class="kv"><tbody>${rows}</tbody></table></div>`;
  } else if (tab === "trackers") {
    body.innerHTML = `<div class="table-card"><table>
      <thead><tr><th>Tier</th><th>URL</th><th>Statut</th><th>Message</th><th>Seeds</th><th>Peers</th></tr></thead>
      <tbody>${(d.trackers || []).map((tr) => `<tr>
        <td class="num">${tr.tier}</td><td class="urlcell">${esc(tr.url)}</td>
        <td class="num">${tr.status}</td><td>${esc(tr.msg || "")}</td>
        <td class="num">${tr.num_seeds ?? ""}</td><td class="num">${tr.num_peers ?? ""}</td>
      </tr>`).join("")}</tbody></table></div>`;
  } else if (tab === "files") {
    body.innerHTML = `<div class="table-card"><table>
      <thead><tr><th>Nom</th><th class="num">Taille</th><th class="num">Prio</th><th class="num">Progression</th></tr></thead>
      <tbody>${(d.files || []).map((f) => `<tr>
        <td class="name" title="${esc(f.name)}">${esc(f.name)}</td>
        <td class="num">${fmtSize(f.size)}</td><td class="num">${f.priority}</td>
        <td class="num">${Math.round((f.progress || 0) * 100)}%</td>
      </tr>`).join("")}</tbody></table></div>`;
  }
}
document.querySelectorAll(".dtab").forEach((b) => { b.onclick = () => renderDetailTab(b.dataset.dtab); });
$("detail-close").onclick = () => $("detail-modal").classList.add("hidden");
$("detail-modal").onclick = (e) => { if (e.target === $("detail-modal")) $("detail-modal").classList.add("hidden"); };

// ---------- Scan ----------
$("btn-scan").onclick = async () => {
  const res = await post("/api/scan");
  if (!res.ok) toast(res.error || "Scan impossible", "err");
  else pollJob();
};

// ---------- Règles ----------
function loadRules() {
  try { rules = JSON.parse(localStorage.getItem("qbtool-rules") || "[]"); }
  catch { rules = []; }
  renderRules();
}
function saveRules() { localStorage.setItem("qbtool-rules", JSON.stringify(rules)); }
function collectRules() {
  rules = [...document.querySelectorAll(".rule-row")].map((row) => ({
    find: row.querySelector(".rule-find").value,
    replace: row.querySelector(".rule-replace").value,
    regex: row.querySelector(".rule-regex").checked,
  }));
  saveRules();
  return rules;
}
function renderRules() {
  $("rules-list").innerHTML = rules.map((r, i) => `
    <div class="rule-row">
      <span class="rule-num">${i + 1}</span>
      <input class="rule-find" placeholder="chercher…" value="${esc(r.find)}">
      <span class="rule-arrow">→</span>
      <input class="rule-replace" placeholder="remplacer par…" value="${esc(r.replace)}">
      <label class="chk" title="Expression régulière"><input type="checkbox" class="rule-regex" ${r.regex ? "checked" : ""}> regex</label>
      <button class="btn sm ghost rule-del" title="Supprimer">✕</button>
    </div>`).join("") ||
    `<div class="sub" style="padding:8px 4px">Aucune règle — ajoute-en une ci-dessous.</div>`;
  document.querySelectorAll(".rule-del").forEach((b) => {
    b.onclick = () => { b.closest(".rule-row").remove(); collectRules(); renderRulesNums(); };
  });
  document.querySelectorAll(".rule-row input").forEach((el) => {
    el.onchange = collectRules; el.oninput = collectRules;
  });
  renderRulesNums();
}
function renderRulesNums() {
  document.querySelectorAll("#rules-list .rule-row").forEach((row, i) => {
    const n = row.querySelector(".rule-num");
    if (n) n.textContent = i + 1;
  });
}
$("btn-add-rule").onclick = () => {
  rules.push({ find: "", replace: "", regex: false });
  renderRules();
  const rows = document.querySelectorAll(".rule-row");
  const last = rows[rows.length - 1];
  if (last) last.querySelector(".rule-find").focus();
};
loadRules();

// ---------- Atelier de règles ----------
let pgTimer = null;
async function testRule() {
  const url = $("pg-url").value.trim();
  const out = $("pg-out");
  if (!url) { out.textContent = "—"; out.className = "pg-out"; return; }
  const r = collectRules();
  const res = await post("/api/test-rule", { url, rules: r });
  if (res.error) { out.textContent = "⚠ " + res.error; out.className = "pg-out err"; return; }
  out.textContent = res.result;
  out.className = "pg-out" + (res.result === url ? " same" : " changed");
}
$("pg-url").addEventListener("input", () => {
  clearTimeout(pgTimer);
  pgTimer = setTimeout(testRule, 300);
});
document.querySelectorAll("#rules-list input").forEach(() => {});
// re-test when rules change (delegated, since rows re-render)
$("rules-list").addEventListener("input", () => { clearTimeout(pgTimer); pgTimer = setTimeout(testRule, 300); });
$("rules-list").addEventListener("change", () => { clearTimeout(pgTimer); pgTimer = setTimeout(testRule, 300); });

// ---------- Preview ----------
$("btn-preview").onclick = async () => {
  if (!selected.size) return toast("Sélectionne au moins un torrent.", "err");
  const r = collectRules();
  $("preview-summary").textContent = "Calcul…";
  $("preview-box").classList.remove("hidden");
  $("preview-body").innerHTML = "";
  const res = await post("/api/preview", { hashes: [...selected], rules: r });
  if (res.error) { $("preview-summary").textContent = res.error; return; }
  const ch = res.changes || [];
  $("preview-summary").textContent =
    `${ch.length} changement(s) sur ${selected.size} torrent(s)${res.errors ? ` — ${res.errors} erreur(s)` : ""}`;
  $("preview-body").innerHTML = ch.slice(0, 300).map((c) => `
    <tr>
      <td class="name" title="${esc(c.name)}">${esc(c.name)}</td>
      <td class="urlcell">${esc(c.old)}</td>
      <td class="urlcell new">${esc(c.new)}</td>
    </tr>`).join("");
  if (ch.length > 300) {
    $("preview-body").innerHTML += `<tr><td colspan="3" class="sub">… et ${ch.length - 300} autre(s)</td></tr>`;
  }
};

// ---------- Apply rewrite ----------
$("btn-apply").onclick = async () => {
  if (!selected.size) return toast("Sélectionne au moins un torrent.", "err");
  const r = collectRules();
  const dry = $("opt-dry").checked;
  if (!dry && !(await confirmDialog(
    `Réécrire les URLs de trackers de ${selected.size} torrent(s) ?`,
    { title: "Réécriture d'URL" }))) return;
  $("job-log").textContent = "";
  const res = await post("/api/rewrite", { hashes: [...selected], rules: r, dry_run: dry });
  if (!res.ok) toast(res.error || "Échec", "err");
  else pollJob();
};

// ---------- Actions ----------
const PARAM_DEFS = {
  delete: {
    title: "Supprimer des torrents",
    fields: `<label class="chk"><input type="checkbox" id="pf-deleteFiles"> Supprimer aussi les fichiers sur disque</label>`,
    collect: () => ({ deleteFiles: $("pf-deleteFiles").checked ? "true" : "false" }),
    confirm: (n) => `Supprimer ${n} torrent(s) ?`,
    danger: true,
  },
  setCategory: {
    title: "Définir une catégorie",
    fields: `<label>Catégorie<input id="pf-category" list="cat-list" placeholder="Nom de la catégorie"><datalist id="cat-list"></datalist></label>`,
    collect: () => ({ category: $("pf-category").value.trim() }),
    confirm: (n) => `Assigner la catégorie à ${n} torrent(s) ?`,
  },
  setLocation: {
    title: "Changer le dossier de téléchargement",
    fields: `<label>Dossier<input id="pf-location" placeholder="D:\\Torrents"></label>`,
    collect: () => ({ location: $("pf-location").value.trim() }),
    confirm: (n) => `Déplacer ${n} torrent(s) vers ce dossier ?`,
  },
  addTrackers: {
    title: "Ajouter des trackers",
    fields: `<label>URLs (une par ligne)<textarea id="pf-urls" rows="4" placeholder="https://tracker.example.com/announce"></textarea></label>`,
    collect: () => ({ urls: $("pf-urls").value }),
    confirm: (n) => `Ajouter ces trackers à ${n} torrent(s) ?`,
  },
  removeTrackers: {
    title: "Retirer des trackers",
    fields: `<label>URLs exactes à retirer (une par ligne)<textarea id="pf-urls" rows="4" placeholder="https://tracker.example.com/announce"></textarea></label>`,
    collect: () => ({ urls: $("pf-urls").value }),
    confirm: (n) => `Retirer ces trackers de ${n} torrent(s) ?`,
    danger: true,
  },
};

const SIMPLE_ACTIONS = {
  reannounce: ["Re-announce", "Forcer une annonce aux trackers", "Lancer un re-announce sur"],
  recheck: ["Re-vérifier", "Recheck des fichiers sur disque", "Lancer un recheck sur"],
  pause: ["Pause", "Mettre en pause", "Mettre en pause"],
  resume: ["Reprendre", "Reprendre les torrents", "Reprendre"],
  stop: ["Stop", "Arrêter complètement", "Arrêter", true],
};

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.onclick = async () => {
    if (!selected.size) return toast("Sélectionne au moins un torrent.", "err");
    const action = btn.dataset.action;
    if (btn.dataset.param) { openParamPanel(action); return; }
    const [title, , verb, danger] = SIMPLE_ACTIONS[action] || [action];
    if (!(await confirmDialog(`${verb} ${selected.size} torrent(s) ?`, { title, danger }))) return;
    $("job-log").textContent = "";
    const res = await post("/api/action", { action, hashes: [...selected] });
    if (!res.ok) toast(res.error || "Échec", "err");
    else pollJob();
  };
});

function openParamPanel(action) {
  const def = PARAM_DEFS[action];
  if (!def) return;
  pendingAction = action;
  $("param-title").textContent = def.title;
  $("param-fields").innerHTML = def.fields;
  if (action === "setCategory") {
    const cats = [...new Set(torrents.map((t) => t.category).filter(Boolean))].sort();
    $("cat-list").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  }
  $("param-panel").classList.remove("hidden");
  $("param-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("param-cancel").onclick = () => { pendingAction = null; $("param-panel").classList.add("hidden"); };
$("param-run").onclick = async () => {
  if (!pendingAction || !selected.size) return;
  const def = PARAM_DEFS[pendingAction];
  const params = def.collect();
  // light client-side validation
  if (pendingAction === "setCategory" && !params.category) return toast("Catégorie requise.", "err");
  if (pendingAction === "setLocation" && !params.location) return toast("Dossier requis.", "err");
  if ((pendingAction === "addTrackers" || pendingAction === "removeTrackers") &&
      !params.urls.split("\n").some((u) => u.trim())) return toast("Au moins une URL requise.", "err");
  if (!(await confirmDialog(def.confirm(selected.size), { title: def.title, danger: !!def.danger }))) return;
  $("job-log").textContent = "";
  const res = await post("/api/action", { action: pendingAction, hashes: [...selected], params });
  if (!res.ok) toast(res.error || "Échec", "err");
  else {
    toast(`${def.title} lancé sur ${selected.size} torrent(s)`, "ok");
    pollJob();
  }
  pendingAction = null;
  $("param-panel").classList.add("hidden");
};

// ---------- Job ----------
function pollJob() {
  if (jobTimer) return;
  jobTimer = setInterval(async () => {
    const j = await api("/api/job");
    if (j.state === "running") {
      $("job-card").classList.remove("hidden");
      const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
      $("job-fill").style.width = pct + "%";
      $("job-text").textContent = `${j.kind} — ${j.done}/${j.total}`;
      $("job-log").textContent = j.log.join("\n");
      $("job-log").scrollTop = $("job-log").scrollHeight;
    } else if (j.state === "done") {
      clearInterval(jobTimer); jobTimer = null;
      $("job-fill").style.width = "100%";
      $("job-text").textContent = "Terminé";
      $("job-log").textContent = j.log.join("\n");
      torrents = await api("/api/torrents");
      render();
      loadHistory();
      if (j.kind.startsWith("action:")) toast(`Action ${j.kind.slice(7)} terminée`, "ok");
    }
  }, 800);
}

// ---------- Historique ----------
async function loadHistory() {
  const runs = await api("/api/history");
  if (!runs.length) {
    $("history-list").innerHTML = '<div class="hist-empty">Aucun historique.</div>';
    return;
  }
  $("history-list").innerHTML = runs.map((r) => {
    const desc = r.kind === "rewrite" && r.rules
      ? r.rules.map((x) => `${x.regex ? "re:" : ""}${x.find}→${x.replace}`).join(" ; ")
      : r.kind || "";
    return `<div class="hist-row">
      <span class="hist-ts">${esc((r.ts || "").replace("T", " ").slice(0, 19))}</span>
      <span class="hist-kind">${esc(r.kind || "?")}</span>
      <span class="hist-desc" title="${esc(desc)}">${esc(desc.slice(0, 70))}${desc.length > 70 ? "…" : ""}</span>
      <span class="hist-n">${r.n} chg</span>
      <button class="btn sm btn-rollback" data-idx="${r.idx}">Restaurer</button>
    </div>`;
  }).join("");
  document.querySelectorAll(".btn-rollback").forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog("Restaurer les anciennes URLs de ce run ?", { title: "Rollback" }))) return;
      $("job-log").textContent = "";
      const res = await post("/api/rollback", { index: parseInt(b.dataset.idx, 10) });
      if (!res.ok) toast(res.error || "Échec", "err");
      else pollJob();
    };
  });
}

// ---------- Init ----------
loadConnPref();
loadRules();
(async () => {
  const st = await api("/api/status");
  if (st.connected) $("connect-msg").innerHTML =
    '<span style="color:var(--green)">Session qBittorrent active — reconnecte-toi pour continuer.</span>';
})();
