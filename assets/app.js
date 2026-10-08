/* Sepsis Watch Board: static replay of precomputed research scores.
   Data comes from data/patients.json and data/results.json (tools/export_data.py). */
(function () {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";
  const STATES = {
    monitoring: "Monitoring",
    alerted: "Alert",
    acknowledged: "Acknowledged",
    cooldown: "Cooldown",
    data_unavailable: "Data unavailable",
    ended: "Record ended",
  };
  const VITAL_INFO = [
    ["HR", "Heart rate", "bpm"], ["MAP", "Mean art. pressure", "mmHg"], ["SBP", "Systolic BP", "mmHg"],
    ["Resp", "Resp. rate", "/min"], ["Temp", "Temperature", "°C"], ["O2Sat", "SpO2", "%"],
  ];
  const LAB_UNITS = { Lactate: "mmol/L", WBC: "×10³/µL", Creatinine: "mg/dL", Platelets: "×10³/µL",
    Bilirubin_total: "mg/dL", BUN: "mg/dL", pH: "", FiO2: "", Glucose: "mg/dL" };
  const RUN_LABELS = {
    "logistic-20261003": "Logistic regression",
    "lightgbm-20261003-v2": "LightGBM",
    "lightgbm_extended-20261003-v2": "LightGBM + measurement patterns",
    "lgbm-v2-basic": "v2 bag, physiology only",
    "lgbm-v2-extended": "v2 bag + measurement patterns",
    "lgbm-v2-extended_time": "v2 bag + time in ICU (ablation)",
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const S = {
    data: null, results: null, t: 0, maxT: 0, playing: false, timer: null, sel: 0,
    showLabels: store.get("sw.labels", false), acked: new Set(),
  };

  // ---------- helpers ----------
  function el(tag, attrs = {}, kids = []) {
    const svg = ["svg", "g", "line", "path", "circle", "rect", "text", "polyline"].includes(tag);
    const n = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of [].concat(kids)) if (k !== null && k !== undefined) n.append(k);
    return n;
  }
  const fmt = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
  const pct = (x, d = 1) => (x === null || x === undefined ? "–" : (100 * x).toFixed(d) + "%");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function humanFeature(f) {
    const fixed = {
      Age: "Age", Gender: "Gender code", ShockIndex: "Shock index (HR/SBP)", PulsePressure: "Pulse pressure",
      SF_ratio: "SpO2/FiO2 ratio", SIRS_partial: "Partial SIRS count", qSOFA_partial: "Partial qSOFA",
      SOFA_partial: "Partial SOFA", SOFA_components: "SOFA components available", SOFA_coag: "SOFA coagulation",
      SOFA_liver: "SOFA liver", SOFA_renal: "SOFA renal", SOFA_cardio_map: "SOFA cardiovascular (MAP)",
      abnormal_vitals: "Abnormal vital count",
    };
    if (fixed[f]) return fixed[f];
    const [v, rest] = f.split("__");
    const name = { O2Sat: "SpO2", Bilirubin_total: "Total bilirubin", Bilirubin_direct: "Direct bilirubin",
      Alkalinephos: "Alk. phosphatase", TroponinI: "Troponin I", BaseExcess: "Base excess" }[v] || v;
    if (!rest) return name;
    if (rest === "last") return `${name}, latest`;
    if (rest === "delta") return `${name}, change since previous`;
    if (rest === "from_first") return `${name}, change from first value`;
    if (rest === "hours_since") return `Hours since ${name} charted`;
    if (rest === "observed") return `${name} charted this hour`;
    let m = rest.match(/^count_(\d+)h$/);
    if (m) return `${name} measurements in ${m[1]} h`;
    m = rest.match(/^(mean|min|max|std|slope)_(\d+)h$/);
    if (m) return `${name} ${{ mean: "mean", min: "min", max: "max", std: "variability", slope: "trend" }[m[1]]}, ${m[2]} h`;
    return f;
  }

  // Display state: an emitted alert the viewer acknowledged reads "acknowledged" until the score falls.
  function openAlertHour(p, i) {
    if (p.hours[i].st !== "alerted") return -1;
    for (let j = i; j >= 0; j--) {
      if (p.hours[j].st !== "alerted") return -1;
      if (p.hours[j].a) return j;
    }
    return -1;
  }
  function stateAt(p, i) {
    const j = openAlertHour(p, i);
    if (j < 0) return p.hours[i].st;
    return S.acked.has(`${p.bed}@${j}`) ? "acknowledged" : "alerted";
  }
  function idxOf(p) { return Math.min(S.t, p.n_hours - 1); }
  function ended(p) { return S.t > p.n_hours - 1; }

  // ---------- tooltip ----------
  const tip = $("#tooltip");
  function showTip(evt, html) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + 14, y = evt.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.hidden = true; }

  // ---------- tabs ----------
  const VIEWS = ["monitor", "performance", "about"];
  function route() {
    const h = location.hash.replace("#", "");
    const cur = VIEWS.includes(h) ? h : "monitor";
    for (const v of VIEWS) {
      $("#view-" + v).hidden = v !== cur;
      $("#tab-" + v).setAttribute("aria-selected", v === cur ? "true" : "false");
    }
    if (cur === "performance" && S.results && !S.perfDrawn) { drawPerformance(); S.perfDrawn = true; }
  }
  window.addEventListener("hashchange", route);

  // ---------- replay transport ----------
  function setT(t) {
    S.t = Math.max(0, Math.min(S.maxT, t));
    if (S.t >= S.maxT) stop();
    renderMonitor();
  }
  function play() {
    if (S.t >= S.maxT) S.t = 0;
    S.playing = true;
    $("#btn-play").textContent = "Pause"; $("#btn-play").setAttribute("aria-pressed", "true");
    clearInterval(S.timer);
    S.timer = setInterval(() => setT(S.t + 1), +$("#speed").value);
  }
  function stop() {
    S.playing = false; clearInterval(S.timer);
    $("#btn-play").textContent = "Play"; $("#btn-play").setAttribute("aria-pressed", "false");
  }

  // ---------- monitor ----------
  function sparkline(p, i, w, h, opts = {}) {
    const n = p.n_hours, ymax = opts.ymax || Math.max(0.2, ...p.hours.map((x) => x.s || 0)) * 1.08;
    const X = (k) => (n <= 1 ? 0 : (k / (n - 1)) * w), Y = (v) => h - (v / ymax) * h;
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    if (S.showLabels) {
      const first = p.hours.findIndex((x) => x.y === 1);
      if (first >= 0) svg.append(el("rect", { x: X(first), y: 0, width: Math.max(1, X(n - 1) - X(first)), height: h, fill: "var(--label)", "fill-opacity": 0.1 }));
    }
    svg.append(el("line", { x1: 0, x2: w, y1: Y(S.data.policy.threshold), y2: Y(S.data.policy.threshold), stroke: "var(--alert)", "stroke-dasharray": "3 3", "stroke-width": 1, "vector-effect": "non-scaling-stroke", "stroke-opacity": 0.7 }));
    let d = "", pen = false;
    for (let k = 0; k <= i; k++) {
      const s = p.hours[k].s;
      if (s === null) { pen = false; continue; }
      d += (pen ? "L" : "M") + X(k).toFixed(1) + " " + Y(s).toFixed(1);
      pen = true;
    }
    svg.append(el("path", { d, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
    return svg;
  }

  function renderSummary() {
    const P = S.data.patients;
    let active = 0, alerting = 0, na = 0, emitted = 0, septicReached = 0;
    for (const p of P) {
      if (ended(p)) continue;
      active++;
      const i = idxOf(p), st = stateAt(p, i);
      if (st === "alerted") alerting++;
      if (st === "data_unavailable") na++;
      if (S.showLabels && p.septic && p.onset_hour !== null && i >= p.onset_hour) septicReached++;
    }
    for (const p of P) for (let k = 0; k <= idxOf(p); k++) if (p.hours[k].a) emitted++;
    const cards = [
      ["Beds in replay", active, `of ${P.length} records`],
      ["Unacknowledged alerts", alerting, "beds with an open alert", alerting > 0],
      ["Alerts emitted", emitted, "since replay start"],
      ["Data unavailable", na, "no valid vital sign in window"],
    ];
    if (S.showLabels) cards.push(["Past sepsis onset", septicReached, "retrospective label"]);
    $("#summary").replaceChildren(...cards.map(([k, v, s, hot]) =>
      el("div", { class: "stat" + (hot ? " hot" : "") }, [el("span", { text: k }), el("b", { text: v }), el("span", { text: s })])));
  }

  function renderBoard() {
    const board = $("#board");
    const tiles = S.data.patients.map((p, n) => {
      const i = idxOf(p), h = p.hours[i], st = ended(p) ? "ended" : stateAt(p, i);
      const truth = S.showLabels && p.septic ? el("span", { class: "pill truth", text: i >= p.onset_hour ? "past onset" : "sepsis later" }) : null;
      return el("button", {
        type: "button", class: `bed s-${st}`, "aria-pressed": n === S.sel ? "true" : "false",
        "aria-label": `${p.bed}, ${STATES[st]}, score ${fmt(h.s)}`,
        onclick: () => { S.sel = n; renderMonitor(); if (window.innerWidth < 900) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" }); },
      }, [
        el("span", { class: "bed-id", text: p.bed }),
        el("span", { class: "bed-score", html: `${h.s === null ? "–" : fmt(h.s)}<small>score</small>` }),
        el("span", { class: "bed-meta", text: `${p.age ?? "?"} y · ${p.gender_code === 1 ? "M" : p.gender_code === 0 ? "F" : "?"} · h ${i}${ended(p) ? " (end)" : ""}` }),
        sparkline(p, i, 140, 34),
        el("span", { class: "bed-foot" }, [el("span", { class: `pill s-${st}`, text: STATES[st] }), truth]),
      ]);
    });
    board.replaceChildren(...tiles);
  }

  function scoreChart(p, i) {
    const W = 560, H = 190, m = { l: 38, r: 10, t: 10, b: 24 };
    const n = p.n_hours, ymax = Math.max(0.2, ...p.hours.map((x) => x.s || 0)) * 1.1;
    const X = (k) => m.l + (n <= 1 ? 0 : (k / (n - 1)) * (W - m.l - m.r));
    const Y = (v) => m.t + (1 - v / ymax) * (H - m.t - m.b);
    const thr = S.data.policy.threshold;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Score trajectory for ${p.bed}` });
    const grid = el("g", { class: "grid" });
    const step = ymax > 0.4 ? 0.1 : 0.05;
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      grid.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
      grid.append(el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", text: v.toFixed(2) }));
    }
    const xs = n > 60 ? 12 : n > 30 ? 6 : 4;
    for (let k = 0; k < n; k += xs) grid.append(el("text", { x: X(k), y: H - 6, "text-anchor": "middle", text: k + " h" }));
    svg.append(grid);
    // unavailable hours as hatched bands
    p.hours.forEach((x, k) => { if (k <= i && x.st === "data_unavailable") svg.append(el("rect", { x: X(k) - 2, y: m.t, width: 4, height: H - m.t - m.b, fill: "var(--na)", "fill-opacity": 0.25 })); });
    if (S.showLabels) {
      const first = p.hours.findIndex((x) => x.y === 1);
      if (first >= 0) {
        svg.append(el("rect", { x: X(first), y: m.t, width: X(n - 1) - X(first), height: H - m.t - m.b, fill: "var(--label)", "fill-opacity": 0.08 }));
        if (p.onset_hour !== null && p.onset_hour < n) {
          svg.append(el("line", { x1: X(p.onset_hour), x2: X(p.onset_hour), y1: m.t, y2: H - m.b, stroke: "var(--label)", "stroke-width": 1.5 }));
          svg.append(el("text", { x: X(p.onset_hour) - 4, y: m.t + 10, "text-anchor": "end", style: "fill:var(--label)", text: "onset proxy" }));
        }
      }
    }
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(thr), y2: Y(thr), stroke: "var(--alert)", "stroke-dasharray": "5 4", "stroke-width": 1.2 }));
    svg.append(el("text", { x: W - m.r, y: Y(thr) - 5, "text-anchor": "end", style: "fill:var(--alert)", text: `alert threshold ${thr.toFixed(3)}` }));
    let d = "", pen = false;
    for (let k = 0; k <= i; k++) {
      const s = p.hours[k].s;
      if (s === null) { pen = false; continue; }
      d += (pen ? "L" : "M") + X(k).toFixed(1) + " " + Y(s).toFixed(1); pen = true;
    }
    svg.append(el("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round" }));
    p.hours.forEach((x, k) => { if (k <= i && x.a) svg.append(el("circle", { cx: X(k), cy: Y(x.s), r: 5, fill: "var(--alert)", stroke: "var(--surface)", "stroke-width": 2 })); });
    if (p.hours[i].s !== null) svg.append(el("circle", { cx: X(i), cy: Y(p.hours[i].s), r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));
    // hover crosshair
    const cross = el("line", { y1: m.t, y2: H - m.b, stroke: "var(--ink-3)", "stroke-width": 1, visibility: "hidden" });
    svg.append(cross);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const k = Math.round(((e.clientX - r.left) / r.width * W - m.l) / (W - m.l - m.r) * (n - 1));
      if (k < 0 || k > i) { cross.setAttribute("visibility", "hidden"); hideTip(); return; }
      const x = p.hours[k];
      cross.setAttribute("x1", X(k)); cross.setAttribute("x2", X(k)); cross.setAttribute("visibility", "visible");
      showTip(e, `Hour <b>${k}</b><br>Score <b>${fmt(x.s)}</b><br>${STATES[stateAt(p, k)]}${x.a ? " · alert emitted" : ""}${S.showLabels ? `<br>Label ${x.y}` : ""}`);
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(hit);
    return svg;
  }

  function lastObserved(p, i, key, group) {
    for (let k = i; k >= 0; k--) { const v = p.hours[k][group][key]; if (v !== undefined) return [v, i - k]; }
    return [null, null];
  }

  function renderDetail() {
    const p = S.data.patients[S.sel], i = idxOf(p), h = p.hours[i], st = ended(p) ? "ended" : stateAt(p, i);
    const det = $("#detail");
    const aj = ended(p) ? -1 : openAlertHour(p, i);
    const alertHere = aj >= 0 && !S.acked.has(`${p.bed}@${aj}`) ? el("button", { type: "button", class: "btn small", text: `Acknowledge alert from hour ${aj}`, onclick: () => { S.acked.add(`${p.bed}@${aj}`); renderMonitor(); } }) : null;

    // drivers
    const c = h.c || [];
    const cmax = Math.max(0.3, ...c.map((x) => Math.abs(x[1])));
    const drivers = c.length ? el("ul", { class: "drivers" }, c.map(([f, v, x]) => el("li", {}, [
      el("span", { class: "name", text: humanFeature(f) }),
      el("span", { class: "bar", title: `${v > 0 ? "+" : ""}${v.toFixed(3)} log-odds` }, [el("i", { class: v > 0 ? "up" : "down", style: `width:${(Math.abs(v) / cmax) * 50}%` })]),
      el("span", { class: "val", text: `value ${x === null ? "missing" : x} · ${v > 0 ? "raises" : "lowers"} ${Math.abs(v).toFixed(2)}` }),
    ]))) : el("p", { class: "note", text: "No score this hour, so no drivers." });

    // vitals
    const vit = el("div", { class: "vitals" }, VITAL_INFO.map(([k, name, unit]) => {
      const [v, ago] = lastObserved(p, i, k, "v");
      const pts = []; for (let j = 0; j <= i; j++) if (p.hours[j].v[k] !== undefined) pts.push([j, p.hours[j].v[k]]);
      const svg = el("svg", { viewBox: "0 0 100 22", preserveAspectRatio: "none", "aria-hidden": "true" });
      if (pts.length > 1) {
        const lo = Math.min(...pts.map((q) => q[1])), hi = Math.max(...pts.map((q) => q[1])), span = hi - lo || 1;
        const X = (j) => (j / Math.max(1, p.n_hours - 1)) * 100, Y = (y) => 20 - ((y - lo) / span) * 18;
        svg.append(el("polyline", { points: pts.map(([j, y]) => `${X(j).toFixed(1)},${Y(y).toFixed(1)}`).join(" "), fill: "none", stroke: "var(--ink-2)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      }
      return el("div", { class: "vital" }, [
        el("span", { class: "k", text: name }),
        el("span", { class: "v", html: v === null ? "–" : `${v} <small>${unit}${ago ? ` · ${ago} h ago` : ""}</small>` }),
        svg,
      ]);
    }));

    const labs = el("div", { class: "labs" }, S.data.labs_shown.map((k) => {
      const [v, ago] = lastObserved(p, i, k, "l");
      return v === null ? null : el("span", { class: "lab", html: `${esc(humanFeature(k))} ${v} <em>${LAB_UNITS[k] || ""} · ${ago === 0 ? "now" : ago + " h ago"}</em>` });
    }).filter(Boolean));

    const truth = S.showLabels
      ? el("p", { class: "note", html: p.septic ? `Retrospective label: <strong>meets the challenge sepsis definition</strong>, onset proxy at hour ${p.onset_hour}.` : "Retrospective label: <strong>no sepsis</strong> in this record." })
      : el("p", { class: "note", text: "Outcome hidden. Turn on retrospective labels to see the onset proxy." });

    det.replaceChildren(...[
      el("div", { class: "detail-head" }, [
        el("div", {}, [
          el("span", { class: "eyebrow", text: "Selected bed" }),
          el("h2", { text: p.bed }),
          el("p", { text: `Record ${p.record} · age ${p.age ?? "?"} · ${p.gender_code === 1 ? "male" : p.gender_code === 0 ? "female" : "gender unknown"} · ${p.n_hours} h recorded` }),
        ]),
        el("div", { class: "big-score" }, [
          el("b", { text: h.s === null ? "–" : fmt(h.s) }),
          el("span", { class: `pill s-${st}`, text: STATES[st] }),
        ]),
      ]),
      alertHere,
      el("div", { class: "subhead" }, [el("h3", { text: "Score trajectory" }), el("span", { text: `hour ${i} of stay` })]),
      el("div", { class: "chart" }, scoreChart(p, i)),
      truth,
      el("div", { class: "subhead" }, [el("h3", { text: "Strongest drivers this hour" }), el("span", { text: "TreeSHAP, log-odds" })]),
      drivers,
      el("div", { class: "subhead" }, [el("h3", { text: "Vital signs" }), el("span", { text: "last charted value" })]),
      vit,
      el("div", { class: "subhead" }, [el("h3", { text: "Labs" }), el("span", { text: "last value within the stay" })]),
      labs.childElementCount ? labs : el("p", { class: "note", text: "No labs charted yet." }),
    ].filter(Boolean));
  }

  function renderLog() {
    const rows = [];
    S.data.patients.forEach((p) => {
      for (let k = 0; k <= idxOf(p); k++) if (p.hours[k].a) rows.push({ p, k });
    });
    rows.sort((a, b) => b.k - a.k);
    const head = el("tr", {}, ["Hour of stay", "Bed", "Score", "Review", S.showLabels ? "Outcome (retrospective)" : null].filter(Boolean).map((t, j) => el("th", { class: j === 0 || j === 2 ? "num" : null, text: t })));
    const body = rows.length ? rows.map(({ p, k }) => {
      const key = `${p.bed}@${k}`, ack = S.acked.has(key);
      let outcome = null;
      if (S.showLabels) {
        if (!p.septic) outcome = el("span", { class: "tag bad", text: "No sepsis in record" });
        else if (k < p.onset_hour) outcome = el("span", { class: "tag good", text: `${p.onset_hour - k} h before onset` });
        else outcome = el("span", { class: "tag mid", text: "After onset" });
      }
      return el("tr", {}, [
        el("td", { class: "num", text: k }),
        el("td", {}, el("a", { href: "#monitor", text: p.bed, onclick: (e) => { e.preventDefault(); S.sel = S.data.patients.indexOf(p); renderMonitor(); $("#detail").scrollIntoView({ behavior: "smooth", block: "start" }); } })),
        el("td", { class: "num", text: fmt(p.hours[k].s) }),
        el("td", {}, ack ? el("span", { class: "pill s-acknowledged", text: "Acknowledged" })
          : el("button", { type: "button", class: "btn small", text: "Acknowledge", onclick: () => { S.acked.add(key); renderMonitor(); } })),
        S.showLabels ? el("td", {}, outcome) : null,
      ]);
    }) : [el("tr", {}, el("td", { class: "empty", colspan: 5, text: "No alerts yet. Press Play or drag the slider to advance the replay." }))];
    $("#alert-log").replaceChildren(el("thead", {}, head), el("tbody", {}, body));
  }

  function renderMonitor() {
    $("#clock-hour").textContent = S.t;
    $("#scrub").value = S.t;
    $("#btn-back").disabled = S.t <= 0;
    $("#btn-fwd").disabled = S.t >= S.maxT;
    renderSummary(); renderBoard(); renderDetail(); renderLog();
  }

  // ---------- performance ----------
  function drawPerformance() {
    const R = S.results, prom = R.runs.find((r) => r.run === R.promoted);
    const A = prom.evals.a_test, B = prom.evals.b_external;
    $("#promoted-line").textContent = `${RUN_LABELS[R.promoted] || R.promoted} (${R.promoted}), chosen by ${R.promotion.rule}. Hospital A test: ${A.records.toLocaleString()} records. Hospital B: ${B.records.toLocaleString()} records.`;

    const sw = (c) => `<i class="sw" style="background:var(${c})"></i>`;
    const kp = [
      ["Hourly AUROC", "auroc", (x) => fmt(x, 3)], ["Hourly AUPRC", "auprc", (x) => fmt(x, 3)],
      ["Official utility", "utility", (x) => fmt(x, 3)], ["Early detection", "early_sensitivity", (x) => pct(x)],
      ["Alert precision", "alert_precision", (x) => pct(x)], ["Alerts / 100 patient-days", "alerts_per_100pd", (x) => fmt(x, 1)],
    ];
    $("#kpis").replaceChildren(...kp.map(([k, key, f]) => el("div", { class: "kpi" }, [
      el("span", { class: "k", text: k }),
      el("div", { class: "pair", html: `<span>${sw("--series-a")}Hospital A</span><b>${f(A[key])}</b><span>${sw("--series-b")}Hospital B</span><b>${f(B[key])}</b>` }),
    ])));

    drawReliability(R.reliability);
    drawBudgets(R.budgets, R.promoted && prom.policy);
    drawRunsTable(R);
    drawFamilies(R.explain.family_share);
    drawFeatures(R.explain.top_features);
    drawSubgroups(R.subgroups);
  }

  function legend(items) {
    return el("div", { class: "chart-legend" }, items.map(([label, color, line]) =>
      el("span", {}, [el("i", { class: line ? "line" : null, style: line ? null : `background:var(${color})` }), label])));
  }

  function axesFrame(svg, W, H, m, X, Y, xt, yt, xfmt, yfmt) {
    const g = el("g", { class: "grid" });
    yt.forEach((v) => { g.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) })); g.append(el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", text: yfmt(v) })); });
    xt.forEach((v) => g.append(el("text", { x: X(v), y: H - m.b + 16, "text-anchor": "middle", text: xfmt(v) })));
    svg.append(g);
  }

  function drawReliability(rel) {
    const W = 420, H = 300, m = { l: 44, r: 12, t: 12, b: 40 }, lim = 0.5;
    const X = (v) => m.l + (v / lim) * (W - m.l - m.r), Y = (v) => H - m.b - (v / lim) * (H - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Calibration curves for hospital A and B" });
    const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    axesFrame(svg, W, H, m, X, Y, ticks, ticks, (v) => v.toFixed(1), (v) => v.toFixed(1));
    svg.append(el("text", { x: (W + m.l) / 2, y: H - 4, "text-anchor": "middle", text: "mean predicted score" }));
    svg.append(el("text", { x: 12, y: (H - m.b) / 2, transform: `rotate(-90 12 ${(H - m.b) / 2})`, "text-anchor": "middle", text: "observed rate" }));
    svg.append(el("line", { x1: X(0), y1: Y(0), x2: X(lim), y2: Y(lim), stroke: "var(--ink-3)", "stroke-dasharray": "4 4" }));
    [["a_test", "--series-a", "Hospital A test"], ["b_external", "--series-b", "Hospital B"]].forEach(([k, c, name]) => {
      const pts = rel[k].filter((b) => b.n >= 50 && b.mean_predicted <= lim);
      svg.append(el("polyline", { points: pts.map((b) => `${X(b.mean_predicted)},${Y(b.observed_rate)}`).join(" "), fill: "none", stroke: `var(${c})`, "stroke-width": 2 }));
      pts.forEach((b) => {
        const dot = el("circle", { cx: X(b.mean_predicted), cy: Y(b.observed_rate), r: 5, fill: `var(${c})`, stroke: "var(--surface)", "stroke-width": 2 });
        dot.addEventListener("mousemove", (e) => showTip(e, `${name}<br>Bin ${b.bin_lower.toFixed(1)}–${b.bin_upper.toFixed(1)}<br>Predicted <b>${b.mean_predicted.toFixed(3)}</b><br>Observed <b>${b.observed_rate.toFixed(3)}</b><br>${b.n.toLocaleString()} hours`));
        dot.addEventListener("mouseleave", hideTip);
        svg.append(dot);
      });
    });
    $("#chart-reliability").replaceChildren(legend([["Hospital A test", "--series-a"], ["Hospital B", "--series-b"], ["Perfect calibration", null, true]]), svg);
  }

  function drawBudgets(by) {
    const keys = Object.keys(by).filter((k) => by[k].feasible).sort((a, b) => +a - +b);
    const W = 420, H = 300, m = { l: 44, r: 12, t: 12, b: 40 };
    const ymax = Math.ceil(Math.max(...keys.flatMap((k) => [by[k].early_sensitivity, by[k].alert_precision])) * 10) / 10;
    const X = (j) => m.l + 20 + (j / (keys.length - 1)) * (W - m.l - m.r - 40), Y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Early detection and alert precision by alert budget" });
    const yt = []; for (let v = 0; v <= ymax + 1e-9; v += 0.1) yt.push(v);
    axesFrame(svg, W, H, m, X, Y, keys.map((_, j) => j), yt, (j) => keys[j], (v) => Math.round(v * 100) + "%");
    svg.append(el("text", { x: (W + m.l) / 2, y: H - 4, "text-anchor": "middle", text: "alert budget (alerts per 100 patient-days)" }));
    const primary = keys.indexOf("10");
    if (primary >= 0) svg.append(el("rect", { x: X(primary) - 16, y: m.t, width: 32, height: H - m.t - m.b, fill: "var(--accent-soft)" }));
    [["early_sensitivity", "--series-a", "Early detection"], ["alert_precision", "--series-b", "Alert precision"]].forEach(([f, c, name]) => {
      svg.append(el("polyline", { points: keys.map((k, j) => `${X(j)},${Y(by[k][f])}`).join(" "), fill: "none", stroke: `var(${c})`, "stroke-width": 2 }));
      keys.forEach((k, j) => {
        const dot = el("circle", { cx: X(j), cy: Y(by[k][f]), r: 5, fill: `var(${c})`, stroke: "var(--surface)", "stroke-width": 2 });
        dot.addEventListener("mousemove", (e) => showTip(e, `Budget <b>${k}</b><br>${name} <b>${pct(by[k][f])}</b><br>Actual alerts <b>${fmt(by[k].alerts_per_100_patient_days, 1)}</b> / 100 pd<br>Threshold ${fmt(by[k].threshold, 3)} · cooldown ${by[k].cooldown_h} h`));
        dot.addEventListener("mouseleave", hideTip);
        svg.append(dot);
      });
    });
    $("#chart-budgets").replaceChildren(legend([["Early detection", "--series-a"], ["Alert precision", "--series-b"]]), svg);
  }

  function drawRunsTable(R) {
    const ci = (c) => (c ? `<span class="ci"> ${fmt(c[0], 3)}–${fmt(c[1], 3)}</span>` : "");
    const head = el("tr", {}, ["Model", "Split", "AUROC", "AUPRC", "Utility", "Early det.", "Precision", "Alerts/100 pd"].map((t, j) => el("th", { class: j > 1 ? "num" : null, text: t })));
    const order = ["logistic-20261003", "lightgbm-20261003-v2", "lightgbm_extended-20261003-v2", "lgbm-v2-basic", "lgbm-v2-extended", "lgbm-v2-extended_time"];
    const runs = [...R.runs].sort((a, b) => order.indexOf(a.run) - order.indexOf(b.run));
    const rows = [];
    runs.forEach((r) => ["a_test", "b_external"].forEach((s, j) => {
      const e = r.evals[s]; if (!e) return;
      rows.push(el("tr", { class: r.run === R.promoted ? "promoted" : null }, [
        el("td", { html: j === 0 ? `${esc(RUN_LABELS[r.run] || r.run)}${r.run === R.promoted ? " · promoted" : ""}<br><code>${esc(r.run)}</code>` : "" }),
        el("td", { text: s === "a_test" ? "Hospital A test" : "Hospital B" }),
        el("td", { class: "num", html: fmt(e.auroc) + ci(e.auroc_ci) }),
        el("td", { class: "num", text: fmt(e.auprc) }),
        el("td", { class: "num", html: fmt(e.utility) + ci(e.utility_ci) }),
        el("td", { class: "num", text: pct(e.early_sensitivity) }),
        el("td", { class: "num", text: pct(e.alert_precision) }),
        el("td", { class: "num", text: fmt(e.alerts_per_100pd, 1) }),
      ]));
    }));
    $("#runs-table").replaceChildren(el("thead", {}, head), el("tbody", {}, rows));
  }

  function drawFamilies(share) {
    const items = Object.entries(share).sort((a, b) => b[1] - a[1]);
    const W = 420, rowH = 30, m = { l: 140, r: 50 }, H = items.length * rowH + 6;
    const X = (v) => (v / items[0][1]) * (W - m.l - m.r);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Importance share by feature family" });
    items.forEach(([k, v], j) => {
      const y = j * rowH + 4;
      svg.append(el("text", { x: m.l - 8, y: y + 15, "text-anchor": "end", text: k }));
      const bar = el("rect", { x: m.l, y: y + 4, width: Math.max(2, X(v)), height: 16, rx: 3, fill: "var(--series-a)" });
      bar.addEventListener("mousemove", (e) => showTip(e, `${esc(k)}<br><b>${pct(v)}</b> of importance`));
      bar.addEventListener("mouseleave", hideTip);
      svg.append(bar);
      svg.append(el("text", { x: m.l + X(v) + 6, y: y + 16, text: pct(v) }));
    });
    $("#chart-families").replaceChildren(svg);
  }

  function drawFeatures(top) {
    const head = el("tr", {}, ["Feature", "Importance", "Missing A", "Missing B"].map((t, j) => el("th", { class: j ? "num" : null, text: t })));
    const rows = top.slice(0, 10).map((f) => el("tr", {}, [
      el("td", { html: `${esc(humanFeature(f.feature))}<br><span class="ci">${esc(f.family)}</span>` }),
      el("td", { class: "num", text: pct(f.importance_share) }),
      el("td", { class: "num", text: pct(f.missing_a_train, 0) }),
      el("td", { class: "num", text: pct(f.missing_b, 0) }),
    ]));
    $("#features-table").replaceChildren(el("thead", {}, head), el("tbody", {}, rows));
  }

  function drawSubgroups(sub) {
    const names = sub.b_external.map((s) => s.subgroup);
    const W = 760, rowH = 34, m = { l: 170, r: 20, t: 8, b: 34 }, H = names.length * rowH + m.t + m.b;
    const lo = 0.65, hi = 0.9;
    const X = (v) => m.l + ((v - lo) / (hi - lo)) * (W - m.l - m.r);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Subgroup AUROC with intervals" });
    const g = el("g", { class: "grid" });
    for (let v = lo; v <= hi + 1e-9; v += 0.05) {
      g.append(el("line", { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b }));
      g.append(el("text", { x: X(v), y: H - m.b + 16, "text-anchor": "middle", text: v.toFixed(2) }));
    }
    svg.append(g);
    svg.append(el("text", { x: (W + m.l) / 2, y: H - 2, "text-anchor": "middle", text: "hourly AUROC" }));
    names.forEach((nm, j) => {
      const y = m.t + j * rowH + rowH / 2;
      svg.append(el("text", { x: m.l - 10, y: y + 4, "text-anchor": "end", text: nm.replace(" (source code)", "") }));
      [["a_test", "--series-a", -6, "Hospital A test"], ["b_external", "--series-b", 6, "Hospital B"]].forEach(([k, c, off, label]) => {
        const s = sub[k].find((q) => q.subgroup === nm); if (!s) return;
        const [a, b] = s.auroc_ci || [s.auroc, s.auroc];
        svg.append(el("line", { x1: X(Math.max(lo, a)), x2: X(Math.min(hi, b)), y1: y + off, y2: y + off, stroke: `var(${c})`, "stroke-width": 2, "stroke-linecap": "round" }));
        const dot = el("circle", { cx: X(s.auroc), cy: y + off, r: 5, fill: `var(${c})`, stroke: "var(--surface)", "stroke-width": 2 });
        dot.addEventListener("mousemove", (e) => showTip(e, `${label} · ${esc(nm)}<br>AUROC <b>${fmt(s.auroc)}</b> (${fmt(a)}–${fmt(b)})<br>${s.stays.toLocaleString()} stays · ${s.septic_stays} septic`));
        dot.addEventListener("mouseleave", hideTip);
        svg.append(dot);
      });
    });
    const wrap = el("div", { style: "overflow-x:auto" }, el("div", { style: "min-width:560px" }, svg));
    $("#chart-subgroups").replaceChildren(legend([["Hospital A test", "--series-a"], ["Hospital B", "--series-b"]]), wrap);
  }

  // ---------- boot ----------
  function legendStates() {
    $("#legend-states").replaceChildren(...["monitoring", "alerted", "acknowledged", "cooldown", "data_unavailable"].map((s) =>
      el("span", { class: `pill s-${s}`, text: STATES[s] })));
  }

  async function boot() {
    route();
    let pd, rd;
    try {
      [pd, rd] = await Promise.all([fetch("data/patients.json").then((r) => r.json()), fetch("data/results.json").then((r) => r.json())]);
    } catch (e) {
      $("#summary").replaceChildren(el("div", { class: "stat hot" }, [el("span", { text: "Data did not load" }), el("span", { text: "Serve this folder over HTTP (for example: python -m http.server) and reload. Browsers block data files opened directly from disk." })]));
      return;
    }
    S.data = pd; S.results = rd;
    S.maxT = Math.max(...pd.patients.map((p) => p.n_hours - 1));
    S.sel = Math.max(0, pd.patients.findIndex((p) => p.hours.some((h) => h.a)));
    const pol = pd.policy;
    $("#policy-line").textContent = `Policy ${pol.policy_version}: alert when the score reaches ${pol.threshold.toFixed(3)} for ${pol.consecutive} h, then ${pol.cooldown_h} h cooldown. Chosen on hospital A validation for ${pol.budget_alerts_per_100_patient_days} alerts per 100 patient-days.`;
    $("#foot-run").textContent = `model ${pd.run} · ${pd.feature_schema_version}`;
    $("#scrub").max = S.maxT;
    $("#show-labels").checked = S.showLabels;
    legendStates();

    $("#btn-play").addEventListener("click", () => (S.playing ? stop() : play()));
    $("#btn-fwd").addEventListener("click", () => { stop(); setT(S.t + 1); });
    $("#btn-back").addEventListener("click", () => { stop(); setT(S.t - 1); });
    $("#btn-reset").addEventListener("click", () => { stop(); S.acked.clear(); setT(0); });
    $("#scrub").addEventListener("input", (e) => { stop(); setT(+e.target.value); });
    $("#speed").addEventListener("change", () => { if (S.playing) play(); });
    $("#show-labels").addEventListener("change", (e) => { S.showLabels = e.target.checked; store.set("sw.labels", S.showLabels); renderMonitor(); });
    document.addEventListener("keydown", (e) => {
      if ($("#view-monitor").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight") { stop(); setT(S.t + 1); }
      else if (e.key === "ArrowLeft") { stop(); setT(S.t - 1); }
      else if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); S.playing ? stop() : play(); }
    });

    setT(30);
    route();
  }
  boot();
})();
