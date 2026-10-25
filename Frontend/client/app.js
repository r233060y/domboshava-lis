/* Domboshava Ward 4 homestead register: map client.
   Plain JavaScript and Leaflet; no build step, no framework.
   Every element is built with DOM calls (never innerHTML with data):
   names typed by clerks must never be able to inject markup. */
"use strict";

// Serve the client from the API's own origin (default) or set
// window.DLIS_API = "http://localhost:3000" before this script loads.
const API = `${(window.DLIS_API || "").replace(/\/$/, "")}/api`;

const STATUS = {
  RECOGNISED:         { label: "Council-recognised", color: "#009e73" },
  CUSTOMARY_ONLY:     { label: "Village head only",  color: "#e69f00" },
  UNRECOGNISED_CLAIM: { label: "Claim, no lawful basis", color: "#d55e00" },
  DISPUTED:           { label: "Disputed",           color: "#cc79a7" },
  NO_RIGHT:           { label: "No right recorded",  color: "#6b7280" },
};
const STATUS_ORDER = ["RECOGNISED", "CUSTOMARY_ONLY", "UNRECOGNISED_CLAIM", "DISPUTED", "NO_RIGHT"];
const RECOGNISED_BY = { GRDC: "Goromonzi RDC", VILLAGE_HEAD: "Village head", NONE: "Nobody" };
const BQ_SHORT = { GNSS_HANDHELD: "handheld GNSS", IMAGERY_TRACED: "traced from imagery", SKETCH: "sketch map", UNKNOWN: "unknown" };

const state = {
  session: loadSession(),
  lookups: null,
  selected: null,          // UPI
  layers: new Map(),       // UPI -> Leaflet layer
  features: [],
  seq: 0,
  statuses: new Set(STATUS_ORDER),
  village: "",
};

// =====================================================================
// Small utilities
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function badge(status) {
  return h("span", { class: "badge" }, h("span", { class: `swatch s-${status}`, "aria-hidden": "true" }), STATUS[status].label);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
const today = () => new Date().toISOString().slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// =====================================================================
// API calls: honest about failure
// =====================================================================
class ApiError extends Error {
  constructor(status, code, description) { super(description); this.status = status; this.code = code; }
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.session) headers.Authorization = `Bearer ${state.session.token}`;
  let r;
  try {
    r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "offline", "The register could not be reached. Check your connection and try again.");
  }
  let data = null;
  try { data = await r.json(); } catch { /* empty or not JSON */ }
  if (!r.ok) {          // fetch does not throw on 404 or 500: check r.ok (Manual §6.3)
    if (r.status === 401 && state.session && auth) signOut("Your sign-in has expired. Sign in again.");
    throw new ApiError(r.status, data && data.code, (data && data.description) || `The register answered ${r.status}.`);
  }
  return data;
}

// =====================================================================
// Session (kept for this browser tab only)
// =====================================================================
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem("dlis.session") || "null");
    if (s && new Date(s.expiresAt) > new Date()) return s;
  } catch { /* storage unavailable */ }
  return null;
}
function saveSession(s) {
  state.session = s;
  try {
    if (s) sessionStorage.setItem("dlis.session", JSON.stringify(s));
    else sessionStorage.removeItem("dlis.session");
  } catch { /* storage unavailable: the session lives in memory only */ }
}
function signOut(message) {
  saveSession(null);
  renderCouncil(message);
  if (state.selected) showHomestead(state.selected, { switchTab: false });
}

// =====================================================================
// Map
// =====================================================================
const map = L.map("map", { zoomControl: true, minZoom: 12, maxZoom: 19 }).setView([-17.614, 31.150], 15);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  // OSM's tile usage policy requires a Referer on every tile request
  referrerPolicy: "strict-origin-when-cross-origin",
  // the attribution is a licence condition, not a courtesy
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const villageLayer = L.geoJSON(null, {
  interactive: false,
  style: { color: "#1f2a44", weight: 1.25, dashArray: "6 5", fill: false, opacity: 0.7 },
  onEachFeature: (f, layer) => layer.bindTooltip(f.properties.name, {
    permanent: true, direction: "center", className: "village-label",
  }),
}).addTo(map);

function styleFor(feature) {
  const s = feature.properties.status;
  const selected = feature.properties.upi === state.selected;
  if (s === "NO_RIGHT") {
    return { color: selected ? "#1f2a44" : STATUS.NO_RIGHT.color, weight: selected ? 3.5 : 2,
             dashArray: "5 4", fill: true, fillOpacity: 0.04, fillColor: "#ffffff" };
  }
  return { color: selected ? "#1f2a44" : STATUS[s].color, weight: selected ? 3.5 : 1.5,
           fillColor: STATUS[s].color, fillOpacity: selected ? 0.6 : 0.42 };
}

const homesteadLayer = L.geoJSON(null, {
  style: styleFor,
  onEachFeature: (f, layer) => {
    state.layers.set(f.properties.upi, layer);
    layer.on("click", () => selectHomestead(f.properties.upi, { fromMap: true }));
    layer.bindTooltip(`${f.properties.village} ${f.properties.homesteadNo}`, { sticky: true, direction: "top" });
  },
}).addTo(map);

// Legend: says what each colour means, and what the dashed outline means.
const Legend = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() {
    const body = h("div", { class: "legend-body", id: "legend-body" },
      h("ul", null, STATUS_ORDER.map((s) => h("li", null, h("span", { class: `swatch s-${s}`, "aria-hidden": "true" }), STATUS[s].label))),
      h("p", { class: "note" }, "Dashed outline: nothing recorded. Boundaries are indicative."));
    const toggle = h("button", { class: "btn-link legend-toggle", type: "button", "aria-expanded": "true", "aria-controls": "legend-body",
      onclick: () => {
        body.hidden = !body.hidden;
        toggle.setAttribute("aria-expanded", String(!body.hidden));
        toggle.textContent = body.hidden ? "Show key" : "Hide key";
      } }, "Hide key");
    const box = h("div", { class: "legend" }, h("h2", null, "Status of each homestead"), toggle, body);
    L.DomEvent.disableClickPropagation(box);
    if (window.matchMedia("(max-width: 820px)").matches) { body.hidden = true; toggle.textContent = "Show key"; toggle.setAttribute("aria-expanded", "false"); }
    return box;
  },
});
map.addControl(new Legend());

function setMapBar(text, isError = false, retry = false) {
  const bar = $("#map-bar");
  bar.replaceChildren();
  bar.classList.toggle("is-error", isError);
  if (!text) return;
  bar.append(text);
  if (retry) bar.append(" ", h("button", { class: "btn-link", type: "button", onclick: loadHomesteads }, "Try again"));
}

// Load only what is in view (Manual §6.3), debounced.
function bboxParam() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(6)).join(",");
}

async function loadHomesteads() {
  // a hidden map (printing, or a collapsed layout) has no extent to ask for
  const size = map.getSize();
  if (!size.x || !size.y) return;
  const seq = ++state.seq;
  setMapBar("Loading homesteads…");
  $("#list-count").textContent = "Loading…";
  const params = new URLSearchParams({ bbox: bboxParam(), limit: "500" });
  if (state.statuses.size && state.statuses.size < STATUS_ORDER.length) params.set("status", [...state.statuses].join(","));
  if (state.village) params.set("village", state.village);
  try {
    if (!state.statuses.size) {             // nothing ticked: nothing to ask for
      if (seq !== state.seq) return;
      state.features = [];
      homesteadLayer.clearLayers();
      state.layers.clear();
      renderList(0);
      setMapBar("");
      return;
    }
    const fc = await api(`/collections/homesteads/items?${params}`, { auth: false });
    if (seq !== state.seq) return;          // a newer request has started
    homesteadLayer.clearLayers();           // or features pile up on every pan
    state.layers.clear();
    homesteadLayer.addData(fc);
    state.features = fc.features;
    renderList(fc.numberMatched);
    setMapBar(fc.numberMatched > fc.numberReturned
      ? `Showing ${fc.numberReturned} of ${fc.numberMatched}. Zoom in to see the rest.` : "");
  } catch (e) {
    if (seq !== state.seq) return;
    setMapBar(e.message, true, true);
    $("#list-count").textContent = "";
    $("#list").replaceChildren(h("li", { class: "empty" }, e.message));
  }
}

let debounce;
map.on("moveend", () => { clearTimeout(debounce); debounce = setTimeout(loadHomesteads, 350); });

// =====================================================================
// "In view" list, synchronised with the map
// =====================================================================
function renderFilters() {
  const box = $("#filter-statuses");
  box.replaceChildren(...STATUS_ORDER.map((s) => h("label", null,
    h("input", { type: "checkbox", checked: state.statuses.has(s), onchange: (e) => {
      if (e.target.checked) state.statuses.add(s); else state.statuses.delete(s);
      loadHomesteads();
    } }),
    h("span", { class: `swatch s-${s}`, "aria-hidden": "true" }), STATUS[s].label)));
}

function renderList(matched) {
  const items = [...state.features].sort((a, b) => a.properties.upi.localeCompare(b.properties.upi));
  $("#list-count").textContent = items.length
    ? `${plural(matched, "homestead", "homesteads")} in this view${matched > items.length ? ` (first ${items.length} listed)` : ""}`
    : "";
  const list = $("#list");
  if (!items.length) {
    list.replaceChildren(h("li", { class: "empty" }, "No homesteads match in this view. Zoom out, move the map or tick more statuses."));
    return;
  }
  list.replaceChildren(...items.map((f) => {
    const p = f.properties;
    return h("li", { class: p.upi === state.selected ? "is-selected" : null, dataset: { upi: p.upi } },
      h("button", { type: "button",
        onclick: () => selectHomestead(p.upi, { zoom: true }),
        onmouseenter: () => { const l = state.layers.get(p.upi); if (l) l.setStyle({ weight: 3.5, color: "#1f2a44" }); },
        onmouseleave: () => { const l = state.layers.get(p.upi); if (l) homesteadLayer.resetStyle(l); },
      },
        h("span", { class: "upi" }, p.upi),
        h("span", { class: "where" }, `${p.village}, homestead ${p.homesteadNo}`),
        badge(p.status)));
  }));
}

// =====================================================================
// Tabs
// =====================================================================
const TABS = ["list", "homestead", "council"];
function showTab(name, focus = false) {
  for (const t of TABS) {
    const tab = $(`#tab-${t}`), view = $(`#view-${t}`);
    const on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    view.hidden = !on;
    if (on && focus) tab.focus();
  }
}
for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => showTab(t));
$(".tabs").addEventListener("keydown", (e) => {
  const i = TABS.findIndex((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true");
  if (e.key === "ArrowRight") showTab(TABS[(i + 1) % TABS.length], true);
  if (e.key === "ArrowLeft") showTab(TABS[(i + TABS.length - 1) % TABS.length], true);
});

// =====================================================================
// One homestead: the slip
// =====================================================================
function selectHomestead(upi, opts = {}) {
  const prev = state.selected;
  state.selected = upi;
  for (const u of [prev, upi]) {
    const l = u && state.layers.get(u);
    if (l) { homesteadLayer.resetStyle(l); if (u === upi) l.bringToFront(); }
  }
  for (const li of document.querySelectorAll("#list li")) li.classList.toggle("is-selected", li.dataset.upi === upi);
  showHomestead(upi, opts);
}

async function showHomestead(upi, { zoom = false, switchTab = true, fromMap = false } = {}) {
  const box = $("#homestead");
  if (switchTab) showTab("homestead");
  box.replaceChildren(h("p", { class: "empty" }, `Loading ${upi}…`));
  try {
    const [f, check] = await Promise.all([
      api(`/collections/homesteads/items/${encodeURIComponent(upi)}`),
      api(`/check?upi=${encodeURIComponent(upi)}`, { auth: false }),
    ]);
    if (state.selected !== upi) return;
    renderSlip(f, check);
    if (zoom) {
      const bounds = L.geoJSON(f).getBounds();
      map.flyToBounds(bounds, { maxZoom: 18, padding: [40, 40], duration: 0.6 });
    }
    if (fromMap && window.matchMedia("(max-width: 820px)").matches) {
      $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (e) {
    box.replaceChildren(h("p", { class: "form-error", role: "alert" }, e.message));
  }
}

function renderSlip(f, check) {
  const p = f.properties;
  const isClerk = Boolean(p.personalDataShown);
  const current = p.rights.filter((r) => r.kind === "RIGHT" && (r.current !== false));
  const past = isClerk ? p.rights.filter((r) => r.kind === "RIGHT" && r.current === false) : [];
  const restrictions = p.rights.filter((r) => r.kind === "RESTRICTION" && r.current !== false);

  const rightLine = (r, isPast) => h("li", { class: isPast ? "right-past" : null },
    h("span", { class: "right-label" }, r.label), " ",
    h("span", { class: "muted" },
      isPast ? `${fmtDate(r.startDate)} to ${fmtDate(r.endDate)}` : `since ${fmtDate(r.startDate)}`,
      `, recognised by ${RECOGNISED_BY[r.recognisedBy].toLowerCase()}`),
    isClerk
      ? h("div", { class: "holders" }, r.parties.length
          ? r.parties.map((x, i) => [i ? "; " : "", `${x.name} (${x.role.toLowerCase()}, ${x.share})`])
          : "No holder recorded")
      : h("div", { class: "holders" }, `${plural(r.partyCount, "holder", "holders")} on record`),
    isClerk && r.evidence.length
      ? h("div", { class: "evidence" }, "Evidence: ", r.evidence.map((d, i) => [i ? "; " : "", d.reference]))
      : null,
    isClerk && !r.evidence.length && !isPast ? h("div", { class: "evidence" }, "No evidence on file") : null);

  const slip = h("article", { class: "slip", "aria-labelledby": "slip-upi" },
    h("div", { class: "slip-head" },
      h("p", { class: "slip-upi", id: "slip-upi" }, p.upi),
      h("p", { class: "slip-where" }, `${p.village} village, homestead ${p.homesteadNo}, Ward ${p.ward}`)),
    h("p", { class: "slip-status" }, h("span", { class: `swatch s-${p.status}`, "aria-hidden": "true" }), check.statusLabel),
    h("p", { class: "slip-advice" }, check.advice),

    h("h3", null, current.length ? "Current rights" : "Current rights: none recorded"),
    current.length ? h("ul", null, current.map((r) => rightLine(r, false))) : null,

    restrictions.length ? [h("h3", null, "Restrictions"),
      h("ul", null, restrictions.map((r) => h("li", null, r.label, " ", h("span", { class: "muted" }, `since ${fmtDate(r.startDate)}`))))] : null,

    past.length ? [h("h3", null, "Earlier rights"), h("ul", null, past.map((r) => rightLine(r, true)))] : null,

    h("h3", null, "The land"),
    h("ul", null,
      h("li", null, `About ${Number(p.areaM2).toLocaleString("en-GB")} m², ${p.landUse.toLowerCase()} use`),
      h("li", null, `Boundary ${BQ_SHORT[p.boundaryQuality] || p.boundaryQuality}, indicative only`)),

    h("p", { class: "slip-notice" }, `Checked ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}. This is not a title deed.`),
    h("p", { class: "demo-print" }, "Demonstration register: every person and boundary is invented."),
    h("div", { class: "slip-actions" },
      h("button", { class: "btn btn-small", type: "button", onclick: () => window.print() }, "Print this check"),
      h("button", { class: "btn btn-small", type: "button", onclick: () => {
        map.flyToBounds(L.geoJSON(f).getBounds(), { maxZoom: 18, padding: [40, 40], duration: 0.6 });
        if (window.matchMedia("(max-width: 820px)").matches) $(".map-wrap").scrollIntoView({ behavior: "smooth" });
      } }, "Show on map")));

  const parts = [slip];
  if (isClerk) parts.push(recordRightForm(p, current.length), editDetailsForm(p));
  else if (!state.session) parts.push(h("p", { class: "clerk-block muted" }, "Council clerks: sign in on the Council tab to see holders and record rights."));
  $("#homestead").replaceChildren(...parts);
}

// =====================================================================
// Clerk: record a right
// =====================================================================
function fraction(holders) {
  // exact sum of fractions: a/b + c/d ... as num/den
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let num = 0, den = 1;
  for (const x of holders) {
    const n = Number(x.shareNum), d = Number(x.shareDen);
    if (!Number.isInteger(n) || !Number.isInteger(d) || n < 1 || d < 1) return null;
    num = num * d + n * den; den *= d;
    const g = gcd(num, den); num /= g; den /= g;
  }
  return { num, den };
}

function recordRightForm(p, currentCount) {
  const types = state.lookups.rrrTypes.filter((t) => t.kind === "RIGHT");
  const docTypes = state.lookups.docTypes;
  const holders = [{ fullName: "", sex: "", role: "HOLDER", shareNum: 1, shareDen: 1 }];
  const err = h("p", { class: "form-error", role: "alert", hidden: true });
  const total = h("p", { class: "share-total", "aria-live": "polite" });
  const holderBox = h("div", { class: "form-grid" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Record right");

  const typeSel = h("select", { required: true }, types.map((t) => h("option", { value: t.code }, t.label)));
  const start = h("input", { type: "date", value: today(), max: today(), required: true });
  const mode = currentCount ? "replace" : "new";

  const radio = (name, value, label, checked) => h("label", null,
    h("input", { type: "radio", name, value, checked }), label);

  const byBox = h("fieldset", { class: "choice" }, h("legend", null, "Recognised by"),
    radio(`by-${p.upi}`, "GRDC", "Goromonzi RDC (council consent on file)", true),
    radio(`by-${p.upi}`, "VILLAGE_HEAD", "Village head only", false),
    radio(`by-${p.upi}`, "NONE", "Nobody (record the claim as found)", false));

  const modeBox = h("fieldset", { class: "choice" }, h("legend", null, "What happens to the current right"),
    radio(`mode-${p.upi}`, "new", "There is no current right", mode === "new"),
    radio(`mode-${p.upi}`, "replace", currentCount ? `End the ${plural(currentCount, "current right", "current rights")} on the start date` : "End any current right on the start date", mode === "replace"),
    radio(`mode-${p.upi}`, "competing", "Keep it: record this as a competing claim", false));

  const docType = h("select", null, h("option", { value: "" }, "No document"), docTypes.map((d) => h("option", { value: d.code }, d.label)));
  const docRef = h("input", { type: "text", maxlength: 200, placeholder: "Reference, e.g. GRDC/W4/ALLOC/2026/301" });
  const docDate = h("input", { type: "date", max: today() });
  const note = h("textarea", { maxlength: 500, rows: 2 });

  function updateTotal() {
    const f = fraction(holders);
    const ok = f && f.num === f.den;
    total.textContent = !f ? "Enter each share as whole numbers."
      : ok ? "Shares add up to one whole." : `Shares add up to ${f.num}/${f.den}, not one whole.`;
    total.className = `share-total ${ok ? "is-ok" : "is-bad"}`;
    submit.disabled = !ok;         // a courtesy: the database is the guarantee
  }

  function renderHolders() {
    holderBox.replaceChildren(...holders.map((x, i) => h("div", { class: "holder" },
      h("label", { class: "field holder-name" }, h("span", null, `Holder ${i + 1}: full name`),
        h("input", { type: "text", value: x.fullName, maxlength: 120, required: true, autocomplete: "off",
          oninput: (e) => { x.fullName = e.target.value; } })),
      h("label", { class: "field" }, h("span", null, "Role"),
        h("select", { onchange: (e) => { x.role = e.target.value; } },
          ["HOLDER", "SPOUSE", "HEIR", "CLAIMANT"].map((r) => h("option", { value: r, selected: x.role === r }, r[0] + r.slice(1).toLowerCase())))),
      h("label", { class: "field" }, h("span", null, "Sex"),
        h("select", { required: true, onchange: (e) => { x.sex = e.target.value; } },
          h("option", { value: "" }, "–"), h("option", { value: "F", selected: x.sex === "F" }, "F"), h("option", { value: "M", selected: x.sex === "M" }, "M"))),
      h("div", { class: "field" }, h("span", null, "Share"),
        h("div", { class: "share" },
          h("input", { type: "number", min: 1, max: 1000, value: x.shareNum, "aria-label": `Holder ${i + 1} share numerator`,
            oninput: (e) => { x.shareNum = e.target.value; updateTotal(); } }),
          "/",
          h("input", { type: "number", min: 1, max: 1000, value: x.shareDen, "aria-label": `Holder ${i + 1} share denominator`,
            oninput: (e) => { x.shareDen = e.target.value; updateTotal(); } }))),
      holders.length > 1 ? h("button", { class: "btn-link holder-remove", type: "button",
        onclick: () => { holders.splice(i, 1); renderHolders(); } }, `Remove holder ${i + 1}`) : null)));
    updateTotal();
  }

  const addHolder = h("button", { class: "btn btn-small", type: "button", onclick: () => {
    // adding a second holder usually means a married couple: offer halves
    if (holders.length === 1 && holders[0].shareNum == 1 && holders[0].shareDen == 1) { holders[0].shareDen = 2; }
    holders.push({ fullName: "", sex: "", role: holders.length === 1 ? "SPOUSE" : "HOLDER", shareNum: 1, shareDen: 2 });
    renderHolders();
  } }, "Add a holder");

  const form = h("form", { class: "clerk-block", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    const by = form.querySelector(`input[name="by-${p.upi}"]:checked`).value;
    const md = form.querySelector(`input[name="mode-${p.upi}"]:checked`).value;
    if (holders.some((x) => !x.fullName.trim() || !x.sex)) {
      err.textContent = "Enter a full name and sex for every holder."; err.hidden = false; return;
    }
    if (docType.value && docRef.value.trim().length < 3) {
      err.textContent = "Enter the document's reference, or choose No document."; err.hidden = false; return;
    }
    const body = {
      mode: md, rrrType: typeSel.value, recognisedBy: by, startDate: start.value,
      holders: holders.map((x) => ({ fullName: x.fullName.trim(), sex: x.sex, role: x.role,
                                     shareNum: Number(x.shareNum), shareDen: Number(x.shareDen) })),
      evidence: docType.value ? [{ docType: docType.value, reference: docRef.value.trim(), issuedOn: docDate.value || null }] : [],
    };
    if (note.value.trim()) body.note = note.value.trim();
    submit.disabled = true;
    submit.textContent = "Recording…";
    try {
      const out = await api(`/collections/homesteads/items/${encodeURIComponent(p.upi)}/rights`, { method: "POST", body });
      toast(`Right recorded. ${p.upi} is now: ${STATUS[out.status].label}.`);
      await showHomestead(p.upi, { switchTab: false });
      loadHomesteads();
      if (state.session) refreshCouncil();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      submit.disabled = false; submit.textContent = "Record right";
    }
  } },
    h("h3", null, "Record a right"),
    h("div", { class: "form-grid" },
      h("label", { class: "field" }, h("span", null, "Type of right"), typeSel),
      byBox,
      h("label", { class: "field" }, h("span", null, "Start date"), start),
      modeBox,
      holderBox,
      total,
      addHolder,
      h("div", { class: "form-row" },
        h("label", { class: "field" }, h("span", null, "Evidence"), docType),
        h("label", { class: "field" }, h("span", null, "Issued on"), docDate)),
      h("label", { class: "field" }, h("span", null, "Document reference"), docRef),
      h("label", { class: "field" }, h("span", null, "Note (optional)"), note),
      err,
      submit));
  renderHolders();
  return form;
}

// =====================================================================
// Clerk: amend details (only the allow-listed fields exist in the form)
// =====================================================================
function editDetailsForm(p) {
  const err = h("p", { class: "form-error", role: "alert", hidden: true });
  const use = h("select", null, ["RESIDENTIAL", "MIXED", "AGRICULTURE"].map((u) => h("option", { value: u, selected: p.landUse === u }, u[0] + u.slice(1).toLowerCase())));
  const bq = h("select", null, state.lookups.boundaryQualities.map((b) => h("option", { value: b.code, selected: p.boundaryQuality === b.code }, b.label)));
  const save = h("button", { class: "btn", type: "submit" }, "Save changes");
  const rec = h("input", { type: "checkbox" });
  const form = h("form", { class: "clerk-block", onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    save.disabled = true;
    try {
      await api(`/collections/homesteads/items/${encodeURIComponent(p.upi)}`, {
        method: "PATCH", body: { landUse: use.value, boundaryQuality: bq.value, reconciled: rec.checked } });
      toast("Changes saved.");
      await showHomestead(p.upi, { switchTab: false });
      loadHomesteads();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    save.disabled = false;
  } },
    h("h3", null, "Homestead details"),
    h("div", { class: "form-grid" },
      h("label", { class: "field" }, h("span", null, "Land use"), use),
      h("label", { class: "field" }, h("span", null, "Boundary captured by"), bq),
      h("label", { class: "field field-inline" }, rec, h("span", null, "Checked against the council's records")),
      err, save));
  return form;
}

// =====================================================================
// Council tab: sign in, reconciliation, validation, recent changes
// =====================================================================
function renderCouncil(message) {
  const box = $("#council");
  if (!state.session) {
    const err = h("p", { class: "form-error", role: "alert", hidden: !message }, message || "");
    const user = h("input", { type: "text", autocomplete: "username", required: true, autocapitalize: "none", spellcheck: "false" });
    const pass = h("input", { type: "password", autocomplete: "current-password", required: true });
    const btn = h("button", { class: "btn btn-primary", type: "submit" }, "Sign in");
    box.replaceChildren(
      h("p", null, "Council clerks sign in here to see holders, record rights and reconcile the levy register."),
      h("form", { class: "form-grid clerk-block", onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        try {
          const s = await api("/auth/login", { method: "POST", body: { username: user.value, password: pass.value }, auth: false });
          saveSession(s);
          pass.value = "";
          toast(`Signed in as ${s.user.displayName}.`);
          refreshCouncil();
          if (state.selected) showHomestead(state.selected, { switchTab: false });
        } catch (ex) {
          err.textContent = ex.message; err.hidden = false;
        }
        btn.disabled = false;
      } },
        h("label", { class: "field" }, h("span", null, "Username"), user),
        h("label", { class: "field" }, h("span", null, "Password"), pass),
        err, btn));
    return;
  }
  refreshCouncil();
}

async function refreshCouncil() {
  const box = $("#council");
  const s = state.session;
  if (!s) return renderCouncil();
  const head = h("div", { class: "council-head" },
    h("p", null, `Signed in as ${s.user.displayName}`),
    h("button", { class: "btn-link", type: "button", onclick: () => signOut() }, "Sign out"));
  box.replaceChildren(head, h("p", { class: "empty" }, "Loading the council's view…"));
  try {
    const [rec, levy, unlevied, book, val, audit] = await Promise.all([
      api("/clerk/reconciliation"),
      api("/clerk/reconciliation/levy?status=unmatched"),
      api("/clerk/reconciliation/unlevied"),
      api("/clerk/reconciliation/book"),
      api("/clerk/validation"),
      api("/clerk/audit?limit=15"),
    ]);
    const t = rec.totals;
    const goTo = (upi) => h("button", { class: "btn-link", type: "button", onclick: () => selectHomestead(upi, { zoom: true }) }, upi);

    const runBtn = h("button", { class: "btn btn-small", type: "button", onclick: async () => {
      runBtn.disabled = true;
      try {
        const out = await api("/clerk/reconciliation/levy/run", { method: "POST" });
        toast(out.matched ? `Matched ${plural(out.matched, "levy account", "levy accounts")}.` : "No further accounts could be matched automatically.");
        refreshCouncil();
      } catch (ex) { toast(ex.message); runBtn.disabled = false; }
    } }, "Match levy accounts automatically");

    box.replaceChildren(
      head,
      h("div", { class: "figures" },
        figure(`${t.levy_matched} of ${t.levy_accounts}`, "levy accounts matched to a homestead"),
        figure(t.occupied_unlevied, "occupied homesteads pay no levy"),
        figure(t.disputed + t.no_right, "homesteads disputed or with no right"),
        figure(t.book_unmatched, "allocation-book entries match no homestead")),

      h("section", { class: "council-section" },
        h("h3", null, "By village"),
        h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, ["Village", "Home­steads", "Recog­nised", "Village head only", "No lawful basis", "Dis­puted", "No right", "Levy matched", "No levy"].map((c) => h("th", { scope: "col" }, c)))),
          h("tbody", null, rec.villages.map((v) => h("tr", null,
            h("th", { scope: "row" }, v.village), h("td", null, v.homesteads), h("td", null, v.recognised),
            h("td", null, v.customary_only), h("td", null, v.unrecognised_claim), h("td", null, v.disputed),
            h("td", null, v.no_right), h("td", null, `${v.levy_matched}/${v.levy_accounts}`), h("td", null, v.occupied_unlevied))))))),

      h("section", { class: "council-section" },
        h("h3", null, "Levy accounts to match by hand"),
        h("p", null, "References the automatic match could not read, and accounts for homesteads that are not on the ground."),
        runBtn,
        levy.accounts.length
          ? h("ul", { class: "task-list" }, levy.accounts.map((a) => levyRow(a)))
          : h("p", { class: "empty" }, "Every levy account is matched.")),

      h("section", { class: "council-section" },
        h("h3", null, `Occupied homesteads with no levy account (${unlevied.homesteads.length})`),
        unlevied.homesteads.length
          ? h("ul", { class: "task-list" }, unlevied.homesteads.map((x) => h("li", null,
              h("div", { class: "row-head" }, goTo(x.upi), badge(x.status)))))
          : h("p", { class: "empty" }, "None.")),

      h("section", { class: "council-section" },
        h("h3", null, `Allocation-book entries that match no homestead (${book.entries.length})`),
        book.entries.length
          ? h("ul", { class: "task-list" }, book.entries.map((x) => h("li", null,
              h("div", null, x.reference),
              h("div", { class: "muted" }, `${x.village}: written as "${x.homesteadRef}", ${x.holder || "no name"}${x.issuedOn ? `, ${fmtDate(x.issuedOn)}` : ""}`))))
          : h("p", { class: "empty" }, "None.")),

      h("section", { class: "council-section" },
        h("h3", null, `Homesteads that need attention (${val.homesteads.length})`),
        val.homesteads.length
          ? h("ul", { class: "task-list" }, val.homesteads.map((x) => h("li", null,
              h("div", { class: "row-head" }, goTo(x.upi), h("span", { class: "muted" }, x.village)),
              h("div", null, x.issues.join(". ") + "."))))
          : h("p", { class: "empty" }, "Nothing flagged.")),

      h("section", { class: "council-section" },
        h("h3", null, "Recent changes"),
        audit.entries.length
          ? h("ul", { class: "task-list" }, audit.entries.map((x) => h("li", null,
              h("div", { class: "row-head" }, h("span", null, `${x.by} ${x.action} a ${x.table.replace("_", " ")} record`),
                h("span", { class: "muted" }, new Date(x.at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }))),
              x.fields ? h("div", { class: "muted" }, `Fields: ${x.fields.join(", ")}`) : null)))
          : h("p", { class: "empty" }, "No changes yet by anyone signed in.")));
  } catch (e) {
    if (state.session) box.replaceChildren(head, h("p", { class: "form-error", role: "alert" }, e.message));
  }
}

function figure(n, label) {
  return h("div", { class: "figure" }, h("strong", null, String(n)), h("span", null, label));
}

function levyRow(a) {
  const input = h("input", { type: "text", placeholder: `GRD-W4${a.villageCode || "XXX"}-000..`, "aria-label": `Homestead for account ${a.accountNo}`, autocomplete: "off" });
  const err = h("div", { class: "form-error", hidden: true });
  return h("li", null,
    h("div", { class: "row-head" }, h("strong", null, a.accountNo), h("span", { class: "muted" }, a.village || "")),
    h("div", null, `Written as "${a.homesteadRef}", payer ${a.payer}`),
    h("form", { class: "match-form", onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        await api(`/clerk/reconciliation/levy/${encodeURIComponent(a.accountNo)}`, { method: "PATCH", body: { upi: input.value } });
        toast(`${a.accountNo} matched to ${input.value.toUpperCase()}.`);
        refreshCouncil();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    } }, input, h("button", { class: "btn btn-small", type: "submit" }, "Match")),
    err);
}

// =====================================================================
// Stand check
// =====================================================================
$("#check-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const village = $("#check-village"), num = $("#check-number"), err = $("#check-error");
  err.hidden = true;
  village.removeAttribute("aria-invalid"); num.removeAttribute("aria-invalid");
  if (!village.value) { village.setAttribute("aria-invalid", "true"); err.textContent = "Choose the village."; err.hidden = false; village.focus(); return; }
  if (!/^\d{1,5}$/.test(num.value.trim())) { num.setAttribute("aria-invalid", "true"); err.textContent = "Enter the homestead number in digits, for example 12."; err.hidden = false; num.focus(); return; }
  try {
    const c = await api(`/check?village=${encodeURIComponent(village.value)}&homestead=${encodeURIComponent(num.value.trim())}`, { auth: false });
    selectHomestead(c.upi, { zoom: true });
    if (window.matchMedia("(max-width: 820px)").matches) $("#panel").scrollIntoView({ behavior: "smooth" });
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  }
});

// =====================================================================
// Start
// =====================================================================
async function start() {
  renderFilters();
  renderCouncil();
  try {
    state.lookups = await api("/lookups", { auth: false });
    const opts = state.lookups.villages.map((v) => h("option", { value: v.code }, v.name));
    $("#check-village").append(...opts.map((o) => o.cloneNode(true)));
    $("#filter-village").append(...opts);
    $("#filter-village").addEventListener("change", (e) => { state.village = e.target.value; loadHomesteads(); });
    const villages = await api("/collections/villages/items", { auth: false });
    villageLayer.addData(villages);
    if (villages.features.length) map.fitBounds(villageLayer.getBounds(), { padding: [20, 20] });
  } catch (e) {
    setMapBar(e.message, true, true);
  }
  loadHomesteads();
}
start();
