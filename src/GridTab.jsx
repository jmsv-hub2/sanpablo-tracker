import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";

// ── Grid-connection readiness planner (demo, local only) ────────────────────
// Computes the minimum set of SCBs / strings needed to satisfy a configurable
// list of grid-connection requirements (ERF2, VRE tests, per-MVPS and
// per-inverter minimums) and turns it into an execution program.
// Read-only: never writes to Sheets or touches any existing tracker state.

const STRING_KWP = 30 * 0.615;            // 18.45 kWp DC per string (30 modules × 615 Wp)
const MVPS_TYPE  = { 1:4.4, 2:8.8, 3:4.4, 4:4.4, 5:8.8, 6:4.4, 7:8.8, 8:8.8, 9:8.8 }; // Sungrow SG1100UD blocks
const VRE_GRID_DEFAULTS = { 1:73, 2:90, 3:90, 4:85, 5:55, 6:72, 7:80, 8:82, 9:80 };
const LS_KEY = "sp_grid_requirements_v1";

const CRITERIA = [
  { key:"scb", label:"Fewest SCBs", icon:"📦",
    info:"Builds the plan out of whole combiner boxes, always preferring the largest ones available. This minimises the number of SCBs that have to be wired, terminated, inspected and commissioned — usually the fastest electrical path to energisation — at the cost of including a few more strings than strictly necessary." },
  { key:"strings", label:"Fewest strings", icon:"🔗",
    info:"Hits every requirement with the exact number of strings, allowing the last SCB of each scope to be included only partially. This minimises the mechanical work (tables / strings to mount) but leaves more partially-used SCBs, so the electrical scope touches more boxes." },
  { key:"work", label:"Least remaining work", icon:"🔨",
    info:"Prefers the SCBs that are already closest to complete given today's real progress, minimising the number of tables still left to mount. Best when you want the cheapest route from the current state of the park to compliance. (With 'use current progress' off it behaves like Fewest SCBs.)" },
];

const DEFAULT_REQ = {
  minTotalMWp: 56,
  perInvOn:    true,
  perInvMWp:   1.0,
  perMvpsMWp:  0,
  vreOn:       false,
  vrePct:      { ...VRE_GRID_DEFAULTS },
  minScbs:     0,
  minStrings:  0,
  useProgress: true,
  criterion:   "scb",
};

function loadReq() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_REQ, vrePct: { ...VRE_GRID_DEFAULTS } };
    const o = JSON.parse(raw);
    return { ...DEFAULT_REQ, ...o, vrePct: { ...VRE_GRID_DEFAULTS, ...(o.vrePct || {}) } };
  } catch (e) { return { ...DEFAULT_REQ, vrePct: { ...VRE_GRID_DEFAULTS } }; }
}

const fmtMW = (mwp, d = 2) => mwp.toFixed(d);

export default function GridTab({ TABLES, SCB_LIST, BC, DIMS, phases, scbStatus, downloadXlsx, scbStatusEntry }) {
  const { CW, CH, RW, RH, ROX, ROY } = DIMS;
  const [req, setReq]     = useState(loadReq);
  const [hover, setHover] = useState(null);   // hovered SCB id on the map
  const [tip, setTip]     = useState(null);   // {text,x,y} info tooltip
  const [labels, setLabels] = useState(false);
  const [mvF, setMvF]     = useState(null);   // MVPS filter for map + program
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(req)); } catch (e) {} }, [req]);
  const setR = useCallback((patch) => setReq(p => ({ ...p, ...patch })), []);

  // ── Park model: SCBs → inverters (SG1100UD) → MVPS blocks ────────────────
  const model = useMemo(() => {
    const pos = {}; SCB_LIST.forEach(s => { pos[s.id] = s; });
    const byId = {};
    TABLES.forEach(t => {
      if (!t.scb) return;
      const m = t.scb.match(/^(\d+)([A-Z])/);
      if (!m) return;
      const e = byId[t.scb] || (byId[t.scb] = {
        id: t.scb, mv: +m[1], letter: m[2], inv: m[1] + m[2],
        x: pos[t.scb]?.x, y: pos[t.scb]?.y,
        total: 0, mounted: 0, missingIds: [],
      });
      e.total++;
      if ((phases?.[t.id] || 0) >= 5) e.mounted++; else e.missingIds.push(t.id);
    });
    const scbs = Object.values(byId).sort((a, b) => a.id.localeCompare(b.id));
    scbs.forEach(s => { s.missing = s.total - s.mounted; s.wiring = scbStatus?.[s.id] || 0; });
    const inverters = {};
    scbs.forEach(s => {
      const inv = inverters[s.inv] || (inverters[s.inv] = { key: s.inv, mv: s.mv, letter: s.letter, scbs: [], totalStrings: 0, mounted: 0 });
      inv.scbs.push(s); inv.totalStrings += s.total; inv.mounted += s.mounted;
    });
    const invList = Object.values(inverters).sort((a, b) => a.mv - b.mv || a.letter.localeCompare(b.letter));
    invList.forEach(inv => { inv.capMWp = inv.totalStrings * STRING_KWP / 1000; });
    const mvps = {};
    for (let z = 1; z <= 9; z++) mvps[z] = { mv: z, invs: [], capStrings: 0, mounted: 0, scbs: [] };
    invList.forEach(inv => { const m = mvps[inv.mv]; m.invs.push(inv); m.capStrings += inv.totalStrings; m.mounted += inv.mounted; m.scbs.push(...inv.scbs); });
    const totalStrings = scbs.reduce((a, s) => a + s.total, 0);
    return { scbs, byId, inverters, invList, mvps, totalStrings, capMWp: totalStrings * STRING_KWP / 1000 };
  }, [TABLES, SCB_LIST, phases, scbStatus]);

  // ── Plan solver: greedy selection under the active requirement set ───────
  const plan = useMemo(() => {
    const toStr = mwp => Math.ceil(mwp * 1000 / STRING_KWP - 1e-9);
    const mountedOf = s => (req.useProgress ? s.mounted : 0);
    const partial = req.criterion === "strings";
    const sel = {};      // scbId → selected strings
    const reasons = {};  // scbId → Set of driver tags
    const warnings = [];
    const cmp = {
      scb:     (a, b) => (b.total - (sel[b.id] || 0)) - (a.total - (sel[a.id] || 0)) || (a.missing - b.missing) || a.id.localeCompare(b.id),
      strings: (a, b) => (((sel[b.id] || 0) > 0) - ((sel[a.id] || 0) > 0)) || (mountedOf(b) - mountedOf(a)) || (b.total - a.total) || a.id.localeCompare(b.id),
      work:    (a, b) => ((a.total - mountedOf(a)) - (b.total - mountedOf(b))) || (b.total - a.total) || a.id.localeCompare(b.id),
    }[req.criterion] || ((a, b) => a.id.localeCompare(b.id));
    const tag = (id, t) => { (reasons[id] || (reasons[id] = new Set())).add(t); };
    const have = scope => scope.reduce((a, s) => a + (sel[s.id] || 0), 0);
    const ensure = (scope, needed, t) => {
      let h = have(scope);
      if (h >= needed) return;
      const cands = [...scope].sort(cmp);
      for (const s of cands) {
        if (h >= needed) break;
        const avail = s.total - (sel[s.id] || 0);
        if (avail <= 0) continue;
        const take = partial ? Math.min(avail, needed - h) : avail;
        sel[s.id] = (sel[s.id] || 0) + take; h += take; tag(s.id, t);
      }
    };

    // 1 · per-inverter minimum (ERF2: every SG1100UD unit ≥ perInvMWp DC)
    const perInv = {};
    let cappedInvs = [];
    if (req.perInvOn && req.perInvMWp > 0) {
      model.invList.forEach(inv => {
        const want = toStr(req.perInvMWp);
        const needed = Math.min(want, inv.totalStrings);
        const capped = want > inv.totalStrings;
        if (capped) cappedInvs.push(inv);
        perInv[inv.key] = { reqStrings: needed, capped };
        ensure(inv.scbs, needed, "Inverter min");
      });
      if (cappedInvs.length)
        warnings.push(`${cappedInvs.length} inverter${cappedInvs.length > 1 ? "s" : ""} (${cappedInvs.map(i => "MVPS" + i.mv + "-" + i.letter).join(", ")}) cannot physically reach ${fmtMW(req.perInvMWp)} MWp DC — they are treated as compliant at 100% of their design capacity (capped).`);
    }

    // 2 · per-MVPS minimums (VRE threshold % and/or flat MWp floor)
    const perMvps = {};
    for (let z = 1; z <= 9; z++) {
      const m = model.mvps[z];
      const vreStr  = req.vreOn ? Math.min(Math.ceil((Math.min(req.vrePct[z] ?? 0, 100) / 100) * m.capStrings - 1e-9), m.capStrings) : 0;
      const flatStr = req.perMvpsMWp > 0 ? Math.min(toStr(req.perMvpsMWp), m.capStrings) : 0;
      const needed = Math.max(vreStr, flatStr);
      perMvps[z] = { reqStrings: needed, vreStr, flatStr };
      if (needed > 0) ensure(m.scbs, needed, vreStr >= flatStr ? "VRE threshold" : "MVPS min");
    }

    // 3 · park-wide minimum total power
    let totalTargetStr = 0;
    if (req.minTotalMWp > 0) {
      const want = toStr(req.minTotalMWp);
      totalTargetStr = Math.min(want, model.totalStrings);
      if (want > model.totalStrings)
        warnings.push(`Total target ${fmtMW(req.minTotalMWp)} MWp exceeds park DC capacity (${fmtMW(model.capMWp)} MWp) — capped at 100%.`);
      ensure(model.scbs, totalTargetStr, "Total MWp");
    }

    // 4 · minimum number of strings (park-wide)
    if (req.minStrings > 0) {
      const needed = Math.min(req.minStrings, model.totalStrings);
      if (req.minStrings > model.totalStrings) warnings.push(`Minimum strings ${req.minStrings} exceeds the ${model.totalStrings} strings in the park — capped.`);
      ensure(model.scbs, needed, "Min strings");
    }

    // 5 · minimum number of SCBs (whole boxes — an SCB only counts once energised)
    if (req.minScbs > 0) {
      const wanted = Math.min(req.minScbs, model.scbs.length);
      if (req.minScbs > model.scbs.length) warnings.push(`Minimum SCBs ${req.minScbs} exceeds the ${model.scbs.length} SCBs in the park — capped.`);
      let count = model.scbs.filter(s => (sel[s.id] || 0) > 0).length;
      const cands = model.scbs.filter(s => !(sel[s.id] > 0))
        .sort((a, b) => (a.total - mountedOf(a)) - (b.total - mountedOf(b)) || a.id.localeCompare(b.id));
      for (const s of cands) {
        if (count >= wanted) break;
        sel[s.id] = s.total; count++; tag(s.id, "Min SCBs");
      }
    }

    // ── Results ──────────────────────────────────────────────────────────
    const rows = model.scbs.filter(s => (sel[s.id] || 0) > 0).map(s => {
      const n = sel[s.id];
      const toMount = Math.max(0, n - mountedOf(s));
      return {
        ...s, sel: n, partial: n < s.total, toMount,
        mwp: n * STRING_KWP / 1000,
        drivers: [...(reasons[s.id] || [])],
      };
    }).sort((a, b) => a.mv - b.mv || a.letter.localeCompare(b.letter) || a.id.localeCompare(b.id));
    let cum = 0; rows.forEach(r => { cum += r.mwp; r.cum = cum; });

    const selStrings = rows.reduce((a, r) => a + r.sel, 0);
    const selMWp = selStrings * STRING_KWP / 1000;
    const tablesToMount = rows.reduce((a, r) => a + r.toMount, 0);
    const scbsReady = rows.filter(r => r.toMount === 0).length;

    const invResults = model.invList.map(inv => {
      const s = have(inv.scbs);
      const p = perInv[inv.key];
      const reqStr = p ? p.reqStrings : 0;
      return { key: inv.key, mv: inv.mv, letter: inv.letter, capMWp: inv.capMWp,
        reqStrings: reqStr, selStrings: s, selMWp: s * STRING_KWP / 1000,
        reqMWp: reqStr * STRING_KWP / 1000, capped: !!p?.capped,
        ok: s >= reqStr, pct: reqStr ? Math.min(100, s / reqStr * 100) : 100 };
    });
    const mvpsResults = [];
    for (let z = 1; z <= 9; z++) {
      const m = model.mvps[z];
      const s = have(m.scbs);
      const p = perMvps[z];
      mvpsResults.push({ mv: z, capStrings: m.capStrings, capMWp: m.capStrings * STRING_KWP / 1000,
        reqStrings: p.reqStrings, reqMWp: p.reqStrings * STRING_KWP / 1000,
        selStrings: s, selMWp: s * STRING_KWP / 1000,
        ok: s >= p.reqStrings, active: p.reqStrings > 0,
        pct: p.reqStrings ? Math.min(100, s / p.reqStrings * 100) : 100 });
    }
    const totalOk = selStrings >= totalTargetStr;
    return { sel, rows, selStrings, selMWp, tablesToMount, scbsReady,
      invResults, mvpsResults, warnings, totalTargetStr,
      totalTargetMWp: totalTargetStr * STRING_KWP / 1000, totalOk,
      invOkCount: invResults.filter(i => i.ok).length,
      cappedCount: invResults.filter(i => i.capped).length,
      mvpsActive: mvpsResults.filter(m => m.active).length,
      mvpsOkCount: mvpsResults.filter(m => m.active && m.ok).length };
  }, [model, req]);

  // ── Independent pan/zoom for the plan map ────────────────────────────────
  const canvasRef = useRef(null);
  const groupRef  = useRef(null);
  const vRef      = useRef({ x: 10, y: 10, z: 1 });
  const dragRef   = useRef(null);
  const apply = useCallback(() => {
    if (groupRef.current) {
      const { x, y, z } = vRef.current;
      groupRef.current.setAttribute("transform", `translate(${x},${y}) scale(${z})`);
    }
  }, []);
  const fit = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const cw = c.clientWidth || 900, ch = c.clientHeight || 520, pad = 16;
    const z = Math.min((cw - pad * 2) / CW, (ch - pad * 2) / CH, 3);
    vRef.current = { x: (cw - CW * z) / 2, y: (ch - CH * z) / 2, z };
    apply();
  }, [apply, CW, CH]);
  const zoomBy = useCallback((f) => {
    const c = canvasRef.current; if (!c) return;
    const cx = c.clientWidth / 2, cy = c.clientHeight / 2;
    const oldZ = vRef.current.z, newZ = Math.min(Math.max(oldZ * f, 0.1), 12);
    vRef.current.x = cx - (cx - vRef.current.x) * (newZ / oldZ);
    vRef.current.y = cy - (cy - vRef.current.y) * (newZ / oldZ);
    vRef.current.z = newZ;
    apply();
  }, [apply]);
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const onWheel = e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const oldZ = vRef.current.z, newZ = Math.min(Math.max(oldZ * (e.deltaY > 0 ? 0.9 : 1.1), 0.1), 12);
      vRef.current.x = mx - (mx - vRef.current.x) * (newZ / oldZ);
      vRef.current.y = my - (my - vRef.current.y) * (newZ / oldZ);
      vRef.current.z = newZ;
      apply();
    };
    const onDown = e => { dragRef.current = { mx: e.clientX, my: e.clientY, px: vRef.current.x, py: vRef.current.y }; el.style.cursor = "grabbing"; };
    const onMove = e => {
      if (!dragRef.current) return;
      vRef.current.x = dragRef.current.px + (e.clientX - dragRef.current.mx);
      vRef.current.y = dragRef.current.py + (e.clientY - dragRef.current.my);
      apply();
    };
    const onUp = () => { dragRef.current = null; el.style.cursor = "grab"; };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onDown);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mouseleave", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("mouseleave", onUp);
    };
  }, [apply]);
  useEffect(() => { const t = setTimeout(fit, 60); return () => clearTimeout(t); }, [fit]);

  // ── Styles (mirrors the SCB tab look) ────────────────────────────────────
  const card = { background:"#12121f", border:"1px solid #1e1e35", borderRadius:8, padding:"12px 14px" };
  const btn  = { background:"#1a1a2e", border:"1px solid #2d2d4a", color:"#aaa", borderRadius:4, padding:"3px 9px", cursor:"pointer", fontSize:9, fontWeight:600 };
  const zBtn = { background:"#1a1a2e", border:"1px solid #2d2d4a", color:"#888", borderRadius:4, width:20, height:18, cursor:"pointer", fontSize:11, lineHeight:1, display:"inline-flex", alignItems:"center", justifyContent:"center", padding:0 };
  const numIn = { width:58, background:"#0d0d18", border:"1px solid #2d2d4a", color:"#ddd", borderRadius:4, fontSize:10, padding:"3px 5px", outline:"none", textAlign:"right" };
  const infoDot = { display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:"50%", border:"1px solid #3a3a55", color:"#666", fontSize:8, fontWeight:700, cursor:"help", marginLeft:4, lineHeight:1, userSelect:"none", flexShrink:0 };
  const Info = ({ text }) => (
    <span style={infoDot}
      onMouseEnter={e => setTip({ text, x: e.clientX, y: e.clientY })}
      onMouseMove={e => setTip({ text, x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTip(null)}>i</span>
  );
  const Toggle = ({ on, set }) => (
    <button onClick={() => set(!on)}
      style={{ background: on ? "#f5a623" : "#1e1e35", border:`1px solid ${on ? "#f5a623" : "#2d2d4a"}`,
        color: on ? "#000" : "#555", borderRadius:3, padding:"1px 8px", cursor:"pointer", fontSize:9, fontWeight:700 }}>
      {on ? "ON" : "OFF"}
    </button>
  );

  const hov = hover ? plan.rows.find(r => r.id === hover) || { ...model.byId[hover], sel:0, toMount:0, mwp:0, drivers:[], notInPlan:true } : null;
  const planIds = plan.sel;
  const scbColor = (s) => {
    const n = planIds[s.id] || 0;
    if (!n) return "#23233a";
    const mounted = req.useProgress ? s.mounted : 0;
    if (mounted >= n) return "#4ade80";
    if (mounted > 0)  return "#f5c518";
    return "#ef4444";
  };
  const today = new Date().toISOString().slice(0, 10);
  const rowsShown = plan.rows.filter(r => !mvF || r.mv === mvF);
  const pctOfTarget = plan.totalTargetStr ? Math.min(100, plan.selStrings / plan.totalTargetStr * 100) : 100;
  const pctOfPark = plan.selMWp / model.capMWp * 100;

  const kpis = [
    { label:"PLANNED DC POWER", val:`${fmtMW(plan.selMWp)} MWp`, sub:`target ${fmtMW(plan.totalTargetMWp)} · ${pctOfPark.toFixed(1)}% of park`, color: plan.totalOk ? "#4ade80" : "#fb923c",
      info:`Total DC power of every string included in the plan (1 string = 30 × 615 Wp = ${STRING_KWP.toFixed(2)} kWp). The plan may exceed the total target because per-inverter and per-MVPS minimums are hard constraints, and because whole-SCB criteria round work up to full boxes.` },
    { label:"STRINGS IN PLAN", val:`${plan.selStrings}`, sub:`of ${model.totalStrings} in the park`, color:"#818cf8",
      info:"Number of strings (= tables, 1 string per table) the plan needs mounted and connected. Includes strings already mounted today when 'use current progress' is on." },
    { label:"SCBs IN PLAN", val:`${plan.rows.length}`, sub:`of ${model.scbs.length} · ${plan.rows.filter(r=>r.partial).length} partial`, color:"#22d3ee",
      info:"Combiner boxes touched by the plan. 'Partial' boxes contribute only part of their strings (only possible under the Fewest-strings criterion); all other criteria always take whole boxes." },
    { label:"TABLES TO MOUNT", val:`${plan.tablesToMount}`, sub: req.useProgress ? "remaining mechanical work" : "greenfield (progress ignored)", color: plan.tablesToMount === 0 ? "#22c55e" : "#f5c518",
      info:"Tables still missing panels among the strings selected by the plan — the real mechanical work left to reach compliance. With 'use current progress' off, every selected string counts as work." },
    { label:"INVERTERS OK", val: req.perInvOn ? `${plan.invOkCount} / ${model.invList.length}` : "—", sub: req.perInvOn ? `${plan.cappedCount} capped at design capacity` : "per-inverter min off", color: req.perInvOn && plan.invOkCount === model.invList.length ? "#4ade80" : "#fb923c",
      info:`Inverters whose selected strings meet the per-inverter minimum (${fmtMW(req.perInvMWp)} MWp DC each → ${Math.ceil(req.perInvMWp*1000/STRING_KWP)} strings). ${plan.cappedCount} units cannot physically reach it and are counted as compliant at 100% of their design capacity: they are marked CAP.` },
    { label:"MVPS OK", val: plan.mvpsActive ? `${plan.mvpsOkCount} / ${plan.mvpsActive}` : "—", sub: plan.mvpsActive ? (req.vreOn ? "VRE thresholds active" : "flat MVPS minimum active") : "no MVPS constraint", color: plan.mvpsActive && plan.mvpsOkCount === plan.mvpsActive ? "#4ade80" : plan.mvpsActive ? "#fb923c" : "#666",
      info:"MVPS blocks whose selected strings meet their own minimum — the larger of the VRE-test threshold (% of the block's DC capacity) and the flat per-MVPS floor. Blocks with no active constraint are not counted." },
  ];

  return (
    <div style={{ flex:1, overflowY:"auto", background:"#0a0a12", padding:"14px 16px" }}>
      {/* header */}
      <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:12 }}>
        <span style={{ fontSize:14, fontWeight:800, color:"#f5a623" }}>⚡ Grid connection planner</span>
        <span style={{ fontSize:10, color:"#555" }}>
          Minimum MS / PV / SCB / string program to meet the energisation requirements · 9 Sungrow MVPS · 56 × SG1100UD units
        </span>
        <span style={{ fontSize:8, fontWeight:700, color:"#f87171", border:"1px solid #f8717155", borderRadius:3, padding:"1px 6px", letterSpacing:1 }}>DEMO · LOCAL ONLY</span>
        {mvF && (
          <button onClick={() => setMvF(null)}
            style={{ marginLeft:"auto", background:"#1e1e35", border:`1px solid ${BC[mvF]}`, color:BC[mvF], borderRadius:4, padding:"2px 9px", cursor:"pointer", fontSize:10, fontWeight:700 }}>
            MVPS {mvF} ✕
          </button>
        )}
      </div>

      {/* KPI row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:9, marginBottom:12 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ ...card, textAlign:"center" }}>
            <div style={{ fontSize:8, color:"#555", letterSpacing:1, marginBottom:5, display:"flex", alignItems:"center", justifyContent:"center" }}>
              {k.label}<Info text={k.info} />
            </div>
            <div style={{ fontSize:18, fontWeight:800, color:k.color, lineHeight:1.1 }}>{k.val}</div>
            <div style={{ fontSize:8, color:"#555", marginTop:4 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* progress towards target */}
      <div style={{ ...card, marginBottom:12, padding:"11px 14px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#888", marginBottom:5 }}>
          <span>Plan coverage of the <b style={{ color:"#bbb" }}>{fmtMW(plan.totalTargetMWp)} MWp</b> total target
            {req.perInvOn && <> · base case: 1 MW × 56 SG1100UD units → “ERF2 as a generator”</>}</span>
          <span style={{ color: plan.totalOk ? "#22c55e" : "#fb923c", fontWeight:700 }}>{pctOfTarget.toFixed(1)}%</span>
        </div>
        <div style={{ height:8, background:"#0d0d18", borderRadius:4, overflow:"hidden" }}>
          <div style={{ height:"100%", width:pctOfTarget + "%", background:"linear-gradient(90deg,#22c55e,#4ade80)", borderRadius:4, transition:"width .3s" }} />
        </div>
        {plan.warnings.map((w, i) => (
          <div key={i} style={{ fontSize:8, color:"#fb923c", marginTop:5 }}>⚠ {w}</div>
        ))}
      </div>

      {/* requirements + criterion */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 330px", gap:12, marginBottom:12 }}>
        <div style={card}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <span style={{ fontSize:9, color:"#666", letterSpacing:1 }}>REQUIREMENTS</span>
            <span style={{ fontSize:8, color:"#444" }}>every value is editable · plan recomputes instantly · saved locally</span>
            <button style={{ ...btn, marginLeft:"auto" }} onClick={() => setReq({ ...DEFAULT_REQ, vrePct: { ...VRE_GRID_DEFAULTS } })}>↺ Reset defaults</button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"10px 18px" }}>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                MIN TOTAL POWER (MWp DC)<Info text="Park-wide minimum installed DC power the plan must reach. The classic base case is 56 MW: 56 SG1100UD units × 1 MW each, the minimum to apply for ERF2 as a generator. Set to 0 to disable." />
              </div>
              <input type="number" min={0} step={0.5} value={req.minTotalMWp} style={numIn}
                onChange={e => setR({ minTotalMWp: Math.max(0, +e.target.value || 0) })} />
              <span style={{ fontSize:8, color:"#444", marginLeft:6 }}>park: {fmtMW(model.capMWp)} MWp</span>
            </div>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                MIN PER INVERTER (MWp DC)<Info text="Minimum DC power connected to every SG1100UD 1.1 MVA unit (ERF2 base requirement: 1 MW each). Eight units cannot physically reach 1.0 MWp DC even fully built (1D 0.96 · 2A 0.98 · 5A 0.85 · 5B 0.87 · 5C 0.72 · 5E 0.85 · 5G 0.81 · 5H 0.85): they are considered compliant at 100% of their design capacity and marked CAP." />
              </div>
              <input type="number" min={0} step={0.1} value={req.perInvMWp} style={{ ...numIn, opacity: req.perInvOn ? 1 : 0.4 }}
                disabled={!req.perInvOn}
                onChange={e => setR({ perInvMWp: Math.max(0, +e.target.value || 0) })} />
              <span style={{ marginLeft:6 }}><Toggle on={req.perInvOn} set={v => setR({ perInvOn: v })} /></span>
              <span style={{ fontSize:8, color:"#444", marginLeft:6 }}>= {Math.ceil(req.perInvMWp * 1000 / STRING_KWP)} strings</span>
            </div>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                MIN PER MVPS (MWp DC)<Info text="Flat DC floor applied to every one of the 9 MVPS blocks, on top of (and combined with) the VRE thresholds: for each block the binding value is the larger of the two. Set to 0 to disable." />
              </div>
              <input type="number" min={0} step={0.5} value={req.perMvpsMWp} style={numIn}
                onChange={e => setR({ perMvpsMWp: Math.max(0, +e.target.value || 0) })} />
            </div>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                MIN SCBs (count)<Info text="Minimum number of combiner boxes that must be part of the plan (an SCB counts only as a whole energised box, so this constraint always pulls in complete boxes). Set to 0 to disable." />
              </div>
              <input type="number" min={0} step={1} value={req.minScbs} style={numIn}
                onChange={e => setR({ minScbs: Math.max(0, Math.round(+e.target.value || 0)) })} />
              <span style={{ fontSize:8, color:"#444", marginLeft:6 }}>of {model.scbs.length}</span>
            </div>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                MIN STRINGS (count)<Info text="Minimum number of strings park-wide, independent of power targets. Set to 0 to disable." />
              </div>
              <input type="number" min={0} step={10} value={req.minStrings} style={numIn}
                onChange={e => setR({ minStrings: Math.max(0, Math.round(+e.target.value || 0)) })} />
              <span style={{ fontSize:8, color:"#444", marginLeft:6 }}>of {model.totalStrings}</span>
            </div>
            <div>
              <div style={{ fontSize:8, color:"#555", letterSpacing:0.5, marginBottom:3, display:"flex", alignItems:"center" }}>
                USE CURRENT PROGRESS<Info text="ON: the plan starts from today's real progress (tables already mounted count as done, and the criteria prefer work already advanced). OFF: greenfield plan — the park is treated as empty and every selected string is pending work." />
              </div>
              <Toggle on={req.useProgress} set={v => setR({ useProgress: v })} />
            </div>
          </div>
          {/* VRE thresholds */}
          <div style={{ marginTop:12, paddingTop:10, borderTop:"1px solid #1e1e35" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
              <span style={{ fontSize:8, color:"#555", letterSpacing:0.5, display:"flex", alignItems:"center" }}>
                VRE TEST THRESHOLDS (% of each MVPS DC capacity)
                <Info text="Minimum share of each MVPS block's DC capacity that must be connected for its VRE test, per the MSPV simulator. When ON, each block must reach its own percentage; the binding per-MVPS value is the larger of this and the flat per-MVPS floor." />
              </span>
              <Toggle on={req.vreOn} set={v => setR({ vreOn: v })} />
              <button style={{ ...btn, marginLeft:"auto", opacity: req.vreOn ? 1 : 0.4 }} disabled={!req.vreOn}
                onClick={() => setR({ vrePct: { ...VRE_GRID_DEFAULTS } })}>↺ Simulator defaults</button>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(9,1fr)", gap:6, opacity: req.vreOn ? 1 : 0.35 }}>
              {Array.from({ length:9 }, (_, i) => i + 1).map(z => (
                <div key={z} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:8, color:BC[z], fontWeight:700, marginBottom:2 }}>MVPS {z} <span style={{ color:"#444", fontWeight:500 }}>· {MVPS_TYPE[z]}</span></div>
                  <input type="number" min={0} max={100} step={1} value={req.vrePct[z]} disabled={!req.vreOn}
                    style={{ ...numIn, width:"85%", textAlign:"center" }}
                    onChange={e => setR({ vrePct: { ...req.vrePct, [z]: Math.max(0, Math.min(100, +e.target.value || 0)) } })} />
                  <div style={{ fontSize:7, color:"#444", marginTop:2 }}>{fmtMW(model.mvps[z].capStrings * STRING_KWP / 1000 * (Math.min(req.vrePct[z], 100) / 100))} MWp</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* criterion selector */}
        <div style={card}>
          <div style={{ fontSize:9, color:"#666", letterSpacing:1, marginBottom:8, display:"flex", alignItems:"center" }}>
            OPTIMISATION CRITERION
            <Info text="How the solver picks which SCBs and strings make up the minimum program. All three respect exactly the same requirements — they differ only in what they try to spend least of. Hover each option for details." />
          </div>
          {CRITERIA.map(c => (
            <button key={c.key} onClick={() => setR({ criterion: c.key })}
              onMouseEnter={e => setTip({ text: c.info, x: e.clientX, y: e.clientY })}
              onMouseMove={e => setTip({ text: c.info, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTip(null)}
              style={{ display:"flex", alignItems:"center", gap:8, width:"100%", textAlign:"left", marginBottom:6,
                background: req.criterion === c.key ? "#1e2a45" : "#141422",
                border:`1px solid ${req.criterion === c.key ? "#818cf8" : "#23233a"}`,
                color: req.criterion === c.key ? "#dbe2ff" : "#888",
                borderRadius:6, padding:"8px 10px", cursor:"pointer", fontSize:11, fontWeight:700 }}>
              <span>{c.icon}</span>{c.label}
              <span style={{ ...infoDot, marginLeft:"auto" }}>i</span>
            </button>
          ))}
          <div style={{ fontSize:8, color:"#555", lineHeight:1.5, marginTop:4 }}>
            {CRITERIA.find(c => c.key === req.criterion)?.info}
          </div>
        </div>
      </div>

      {/* map + hover panel */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 250px", gap:12, marginBottom:12 }}>
        <div style={{ ...card, padding:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, paddingLeft:4 }}>
            <span style={{ fontSize:9, color:"#666", letterSpacing:1 }}>EXECUTION MAP</span>
            <span style={{ fontSize:8, color:"#444" }}>squares = SCBs in plan · green = done · yellow = in progress · red = not started · grey = not needed</span>
            <span style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:4 }}>
              <span style={{ fontSize:8, color:"#666", letterSpacing:0.5 }}>🏷️ LABELS</span>
              <Toggle on={labels} set={setLabels} />
              <span style={{ width:8 }} />
              <button onClick={() => zoomBy(1.3)} style={zBtn} title="Zoom in">+</button>
              <button onClick={() => zoomBy(1 / 1.3)} style={zBtn} title="Zoom out">−</button>
              <button onClick={fit} style={{ ...zBtn, width:"auto", padding:"0 7px", fontSize:9 }} title="Fit to screen">↺ Fit</button>
            </span>
          </div>
          <div ref={canvasRef} style={{ height:520, overflow:"hidden", background:"#0d0d14", borderRadius:5, cursor:"grab", position:"relative" }}>
            <svg width="100%" height="100%">
              <g ref={groupRef} transform="translate(10,10) scale(1)">
                <rect x={-5} y={-5} width={CW + 10} height={CH + 10} fill="#0d0d14" />
                {TABLES.map(t => {
                  if (!t.scb) return null;
                  const inPlan = (planIds[t.scb] || 0) > 0;
                  const mounted = (phases?.[t.id] || 0) >= 5 && req.useProgress;
                  const dim = mvF && t.m !== mvF;
                  const onHov = hov && t.scb === hov.id;
                  return (
                    <rect key={`g-${t.id}`} x={t.x + ROX} y={t.y + ROY} width={RW} height={RH} rx={0.5}
                      fill={inPlan ? (mounted ? "#14532d" : "#7c3f12") : "#181826"}
                      fillOpacity={dim ? 0.12 : 1}
                      stroke={onHov ? "#ffffff" : "none"} strokeWidth={onHov ? 1.2 : 0} />
                  );
                })}
                {SCB_LIST.map(s => {
                  const it = model.byId[s.id];
                  if (!it) return null;
                  const dim = mvF && it.mv !== mvF;
                  const isHov = hover === s.id;
                  const partial = (planIds[s.id] || 0) > 0 && planIds[s.id] < it.total;
                  return (
                    <rect key={`gs-${s.id}`} x={s.x - 2.6} y={s.y - 2.6} width={5.2} height={5.2} rx={0.8}
                      fill={scbColor(it)} fillOpacity={dim ? 0.15 : 1}
                      stroke={isHov ? "#fff" : partial ? "#a78bfa" : "#07070d"} strokeWidth={isHov ? 1.6 : partial ? 1.1 : 0.9}
                      strokeDasharray={partial && !isHov ? "1.4 0.9" : "none"}
                      style={{ cursor:"pointer" }}
                      onMouseEnter={() => setHover(s.id)}
                      onMouseLeave={() => setHover(null)} />
                  );
                })}
                {labels && SCB_LIST.map(s => {
                  const it = model.byId[s.id];
                  if (!it) return null;
                  const dim = mvF && it.mv !== mvF;
                  return (
                    <text key={`gl-${s.id}`} x={s.x} y={s.y - 3.4}
                      textAnchor="middle" dominantBaseline="auto"
                      fontSize={2.4} fill={scbColor(it)} fillOpacity={dim ? 0.2 : 1}
                      fontWeight="700" pointerEvents="none"
                      style={{ userSelect:"none", fontFamily:"monospace", paintOrder:"stroke" }}
                      stroke="#07070d" strokeWidth={0.6}>
                      {s.id}{(planIds[s.id] || 0) > 0 && planIds[s.id] < it.total ? ` ${planIds[s.id]}/${it.total}` : ""}
                    </text>
                  );
                })}
              </g>
            </svg>
            <div style={{ position:"absolute", bottom:6, right:9, fontSize:8, color:"#3d3d55", pointerEvents:"none" }}>
              🔍 scroll = zoom · ✋ drag = pan
            </div>
          </div>
          <div style={{ display:"flex", gap:12, marginTop:7, paddingLeft:4, flexWrap:"wrap" }}>
            {[["#4ade80","In plan · already complete"],["#f5c518","In plan · partly mounted"],["#ef4444","In plan · not started"],["#23233a","Not needed"]].map(([c, l]) => (
              <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <div style={{ width:9, height:9, borderRadius:2, background:c }} />
                <span style={{ fontSize:9, color:"#888" }}>{l}</span>
              </div>
            ))}
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:9, height:9, borderRadius:2, background:"#23233a", border:"1.4px dashed #a78bfa", boxSizing:"border-box" }} />
              <span style={{ fontSize:9, color:"#888" }}>Partial SCB (dashed)</span>
            </div>
          </div>
        </div>
        <div style={{ ...card, padding:"11px 12px" }}>
          {hov ? (<>
            <div style={{ fontSize:13, fontWeight:800, color:"#fff" }}>{hov.id}</div>
            <div style={{ fontSize:9, color:BC[hov.mv], marginTop:1 }}>MVPS {hov.mv} · inverter {hov.letter} · {hov.total} strings</div>
            <div style={{ height:1, background:"#1e1e35", margin:"8px 0" }} />
            {hov.notInPlan ? (
              <div style={{ fontSize:16, fontWeight:800, color:"#555" }}>NOT IN PLAN</div>
            ) : (<>
              <div style={{ fontSize:20, fontWeight:800, color:scbColor(model.byId[hov.id]), lineHeight:1 }}>
                {hov.sel}{hov.partial ? ` / ${hov.total}` : ""} strings
              </div>
              <div style={{ fontSize:9, color:"#666", marginTop:3 }}>
                {fmtMW(hov.mwp, 3)} MWp · {hov.toMount > 0 ? `${hov.toMount} tables to mount` : "no work left"}
              </div>
              <div style={{ height:5, background:"#0d0d18", borderRadius:3, overflow:"hidden", margin:"7px 0" }}>
                <div style={{ height:"100%", width:(hov.sel ? Math.min(100, (req.useProgress ? hov.mounted : 0) / hov.sel * 100) : 0) + "%", background:scbColor(model.byId[hov.id]), borderRadius:3 }} />
              </div>
              <div style={{ fontSize:8, color:"#555" }}>drivers: {hov.drivers.join(" · ") || "—"}</div>
            </>)}
            <div style={{ fontSize:9, color:scbStatusEntry(hov.wiring).color, marginTop:6 }}>
              ⚑ {scbStatusEntry(hov.wiring).label}
            </div>
            {!hov.notInPlan && hov.missingIds?.length > 0 && (<>
              <div style={{ fontSize:8, color:"#555", letterSpacing:1, margin:"9px 0 4px" }}>PENDING TABLES</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:3, maxHeight:130, overflowY:"auto" }}>
                {hov.missingIds.map(id => (
                  <span key={id} style={{ fontSize:9, fontFamily:"monospace", background:"#2a1010", color:"#f87171", border:"1px solid #f8717133", borderRadius:3, padding:"1px 5px" }}>{id}</span>
                ))}
              </div>
            </>)}
          </>) : (
            <div style={{ fontSize:9, color:"#555", lineHeight:1.7 }}>
              <b style={{ color:"#888" }}>Hover an SCB square</b> to see its role in the plan: strings selected, remaining work and which requirement pulled it in.
              <div style={{ height:1, background:"#1e1e35", margin:"10px 0" }} />
              Click an MVPS header below to filter the map and the program.
            </div>
          )}
        </div>
      </div>

      {/* per-MVPS + per-inverter compliance */}
      <div style={{ ...card, marginBottom:12 }}>
        <div style={{ fontSize:9, color:"#666", letterSpacing:1, marginBottom:8, display:"flex", alignItems:"center" }}>
          COMPLIANCE BY MVPS AND INVERTER
          <Info text="Each column is one MVPS block (click its header to filter). The block bar compares selected MWp with the block's own requirement (VRE / flat floor). Each chip below is one SG1100UD unit: selected vs required MWp. CAP marks the eight units that cannot physically reach the per-inverter target and are compliant at 100% of design capacity." />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(9,1fr)", gap:8 }}>
          {plan.mvpsResults.map(m => (
            <div key={m.mv} style={{ background:"#0f0f1c", border:`1px solid ${mvF === m.mv ? BC[m.mv] : "#1e1e35"}`, borderRadius:6, padding:"7px 8px" }}>
              <div onClick={() => setMvF(f => f === m.mv ? null : m.mv)}
                style={{ display:"flex", justifyContent:"space-between", cursor:"pointer", marginBottom:4 }}>
                <span style={{ fontSize:9, fontWeight:800, color:BC[m.mv] }}>MVPS {m.mv}</span>
                <span style={{ fontSize:8, color:"#555" }}>{MVPS_TYPE[m.mv]} MW</span>
              </div>
              <div style={{ fontSize:10, fontWeight:800, color: m.active ? (m.ok ? "#4ade80" : "#fb923c") : "#888" }}>
                {fmtMW(m.selMWp)} <span style={{ fontSize:8, color:"#555", fontWeight:500 }}>/ {m.active ? fmtMW(m.reqMWp) : fmtMW(m.capMWp)} MWp</span>
              </div>
              <div style={{ height:4, background:"#0d0d18", borderRadius:2, overflow:"hidden", margin:"4px 0 6px" }}>
                <div style={{ height:"100%", width:(m.active ? m.pct : m.selMWp / m.capMWp * 100) + "%", background: m.active ? (m.ok ? "#4ade80" : "#fb923c") : "#818cf8", borderRadius:2 }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:3 }}>
                {plan.invResults.filter(i => i.mv === m.mv).map(i => (
                  <div key={i.key} title={`Inverter ${i.letter} — ${fmtMW(i.selMWp, 3)} / ${req.perInvOn ? fmtMW(i.reqMWp, 3) : fmtMW(i.capMWp, 3)} MWp${i.capped ? " (capped at design capacity)" : ""}`}
                    style={{ background: req.perInvOn ? (i.ok ? "#12241a" : "#241512") : "#141422",
                      border:`1px solid ${req.perInvOn ? (i.ok ? "#22c55e55" : "#fb923c66") : "#23233a"}`,
                      borderRadius:3, padding:"2px 4px", textAlign:"center" }}>
                    <span style={{ fontSize:8, fontWeight:800, color: req.perInvOn ? (i.ok ? "#4ade80" : "#fb923c") : "#888" }}>
                      {i.letter}
                    </span>
                    <span style={{ fontSize:7, color:"#666", marginLeft:3 }}>
                      {i.selStrings}{req.perInvOn ? `/${i.reqStrings}` : ""}
                    </span>
                    {i.capped && <span style={{ fontSize:6, fontWeight:800, color:"#a78bfa", marginLeft:2 }}>CAP</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* execution program */}
      <div style={card}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
          <span style={{ fontSize:9, color:"#666", letterSpacing:1 }}>EXECUTION PROGRAM</span>
          <span style={{ fontSize:8, color:"#444" }}>
            {rowsShown.length} SCBs{mvF ? ` · MVPS ${mvF} only` : ""} · sequenced by MVPS / inverter · strings in numbers of tables
          </span>
          <button style={{ ...btn, marginLeft:"auto", borderColor:"#2f6650", color:"#4ade80" }} disabled={rowsShown.length === 0}
            title="Download the program as a formatted Excel workbook"
            onClick={() => downloadXlsx(`Grid_program${mvF ? `_MVPS${mvF}` : ""}_${today}.xlsx`, {
              sheetName:"Grid program",
              title:"San Pablo Solar — grid connection execution program",
              subtitle:`${rowsShown.length} SCBs · ${plan.selStrings} strings · ${fmtMW(plan.selMWp)} MWp DC planned vs ${fmtMW(plan.totalTargetMWp)} MWp target · criterion: ${CRITERIA.find(c => c.key === req.criterion)?.label} · ${req.useProgress ? "from current progress" : "greenfield"} · generated ${today}`,
              columns:[
                { label:"SCB",             width:12, kind:"text" },
                { label:"MVPS",            width:8,  kind:"num"  },
                { label:"Inverter",        width:10, kind:"text" },
                { label:"Strings in plan", width:14, kind:"num"  },
                { label:"Total strings",   width:12, kind:"num"  },
                { label:"Mounted today",   width:13, kind:"num"  },
                { label:"Tables to mount", width:14 },
                { label:"MWp in plan",     width:12, kind:"num"  },
                { label:"Cumulative MWp",  width:14, kind:"num"  },
                { label:"Wiring status",   width:24, kind:"text" },
                { label:"Drivers",         width:28, kind:"text" },
                { label:"Pending tables",  width:46, kind:"mono" },
              ],
              rows: rowsShown.map(r => [
                r.id + (r.partial ? " (partial)" : ""), r.mv, `MVPS${r.mv}-${r.letter}`,
                r.sel, r.total, req.useProgress ? r.mounted : 0,
                { v: r.toMount, kind: r.toMount > 0 ? "warn" : undefined },
                +r.mwp.toFixed(3), +r.cum.toFixed(3),
                scbStatusEntry(r.wiring).label,
                r.drivers.join(", "),
                r.missingIds.join(", "),
              ]),
            })}>
            ⬇ Export program
          </button>
        </div>
        <div style={{ fontSize:8, color:"#555", lineHeight:1.6, marginBottom:8 }}>
          Every SCB the plan needs, with the strings it must contribute and the mechanical work still pending. “Drivers” shows
          which requirement pulled the box into the program. Partial boxes (Fewest-strings criterion) only need the stated
          number of strings — any of their pending tables can supply them.
        </div>
        <div style={{ maxHeight:420, overflowY:"auto", border:"1px solid #1e1e35", borderRadius:6 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:9 }}>
            <thead>
              <tr>
                {["SCB","MVPS","INVERTER","STRINGS","MOUNTED","TO MOUNT","MWp","CUM. MWp","WIRING","DRIVERS"].map(h => (
                  <th key={h} style={{ padding:"4px 8px", textAlign: h === "SCB" || h === "INVERTER" || h === "WIRING" || h === "DRIVERS" ? "left" : "right",
                    color:"#555", fontWeight:600, fontSize:8, letterSpacing:0.5, background:"#12121f",
                    position:"sticky", top:0, borderBottom:"1px solid #1e1e35", whiteSpace:"nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsShown.map(r => (
                <tr key={r.id}
                  onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)}
                  style={{ background: hover === r.id ? "#1a1a30" : "transparent", borderBottom:"1px solid #14142a" }}>
                  <td style={{ padding:"3px 8px", fontFamily:"monospace", color:"#ddd", fontWeight:700 }}>
                    {r.id}{r.partial && <span style={{ color:"#a78bfa", fontWeight:800 }}> ◧</span>}
                  </td>
                  <td style={{ padding:"3px 8px", textAlign:"right", color:BC[r.mv], fontWeight:700 }}>{r.mv}</td>
                  <td style={{ padding:"3px 8px", color:"#888" }}>MVPS{r.mv}-{r.letter}</td>
                  <td style={{ padding:"3px 8px", textAlign:"right", color:"#ccc" }}>{r.sel}{r.partial ? <span style={{ color:"#555" }}>/{r.total}</span> : ""}</td>
                  <td style={{ padding:"3px 8px", textAlign:"right", color:"#666" }}>{req.useProgress ? r.mounted : 0}</td>
                  <td style={{ padding:"3px 8px", textAlign:"right", fontWeight:700, color: r.toMount > 0 ? "#f5c518" : "#4ade80" }}>{r.toMount}</td>
                  <td style={{ padding:"3px 8px", textAlign:"right", color:"#ccc" }}>{r.mwp.toFixed(3)}</td>
                  <td style={{ padding:"3px 8px", textAlign:"right", color:"#666" }}>{r.cum.toFixed(2)}</td>
                  <td style={{ padding:"3px 8px", color:scbStatusEntry(r.wiring).color }}>{scbStatusEntry(r.wiring).label}</td>
                  <td style={{ padding:"3px 8px", color:"#666", fontSize:8 }}>{r.drivers.join(" · ")}</td>
                </tr>
              ))}
              {rowsShown.length === 0 && (
                <tr><td colSpan={10} style={{ padding:14, textAlign:"center", color:"#555" }}>No SCBs required — every active requirement is already satisfied.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* tooltip */}
      {tip && (
        <div style={{ position:"fixed", left:Math.min(tip.x + 14, window.innerWidth - 330), top:Math.min(tip.y + 16, window.innerHeight - 140), width:300,
          background:"#1a1a2e", border:"1px solid #3a3a55", borderRadius:6, padding:"9px 11px",
          fontSize:10, color:"#bbb", lineHeight:1.55, zIndex:1000, pointerEvents:"none", boxShadow:"0 6px 24px rgba(0,0,0,0.5)" }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
