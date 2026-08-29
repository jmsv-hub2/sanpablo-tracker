import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import {
  SCENARIOS, DEFAULT_ENV, TAMB_MONTH, PVSYST_MONTHLY, PVSYST_REPORT_MONTHS,
  SCB_STATUS_LABELS, STRING_KWP, TOTAL_STRINGS, TOTAL_MWDC,
  solarPos, dayOfYear, instant, kPeak, dcRequired, minutesAbove, bendtFreq,
  projectTables, findCrossing, isWorkday, addDays, dayKey, buildPark, forcedIntoDark,
} from './model.js';
import { TABLES, BC } from './parkdata.js';

// ── ER3 readiness planner (demo, local only) ────────────────────────────────
// Interactive front-end for the audited minimum-DC model: how much DC must be
// mounted, by when, to demonstrate the AC target at the delivery point under
// ER3 — against live mounting progress from the tracker's read-only endpoints.

const API_URL = 'https://script.google.com/macros/s/AKfycbwJQNUg5oRFeUABFEf_QfPGFa9XJBekbZs2gtreickGGCXxP-74UC_tvtPiX8x60DqGUg/exec';

const card = { background: '#12121f', border: '1px solid #1e1e35', borderRadius: 8, padding: '12px 14px' };
const btn = { background: '#1a1a2e', border: '1px solid #2d2d4a', color: '#aaa', borderRadius: 4, padding: '3px 9px', cursor: 'pointer', fontSize: 9, fontWeight: 600 };
const numIn = { width: 58, background: '#0d0d18', border: '1px solid #2d2d4a', color: '#ddd', borderRadius: 4, fontSize: 10, padding: '3px 5px', outline: 'none', textAlign: 'right' };
const infoDot = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 11, height: 11, borderRadius: '50%', border: '1px solid #3a3a55', color: '#666', fontSize: 8, fontWeight: 700, cursor: 'help', marginLeft: 4, lineHeight: 1, userSelect: 'none', flexShrink: 0 };
const lbl = { fontSize: 8, color: '#555', letterSpacing: 0.5, marginBottom: 3, display: 'flex', alignItems: 'center' };
const thS = { padding: '4px 8px', color: '#555', fontWeight: 600, fontSize: 8, letterSpacing: 0.5, background: '#12121f', position: 'sticky', top: 0, borderBottom: '1px solid #1e1e35', whiteSpace: 'nowrap' };
const tdS = { padding: '3px 8px', borderBottom: '1px solid #14142a' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtD = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
const fmtDY = (d) => `${fmtD(d)} ${String(d.getFullYear()).slice(2)}`;
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const todayNoon = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); };

let TipCtx = React.createContext(() => {});
const Info = ({ text }) => {
  const setTip = React.useContext(TipCtx);
  return (
    <span style={infoDot}
      onMouseEnter={(e) => setTip({ text, x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTip({ text, x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTip(null)}>i</span>
  );
};
const Toggle = ({ on, set }) => (
  <button onClick={() => set(!on)}
    style={{ background: on ? '#f5a623' : '#1e1e35', border: `1px solid ${on ? '#f5a623' : '#2d2d4a'}`, color: on ? '#000' : '#555', borderRadius: 3, padding: '1px 8px', cursor: 'pointer', fontSize: 9, fontWeight: 700 }}>
    {on ? 'ON' : 'OFF'}
  </button>
);

// ── Sun & irradiance panel (self-contained animation state) ─────────────────
const SUN_START = new Date(2026, 7, 1, 12);
const SUN_DAYS = 242; // through 31 Mar 2027

const SunPanel = memo(function SunPanel({ env, targetMW, projLookup, mountedMW }) {
  const [idx, setIdx] = useState(() => Math.min(SUN_DAYS, Math.max(0, Math.round((todayNoon() - SUN_START) / 86400e3))));
  const [t, setT] = useState(12);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(null);
  const last = useRef(0);
  const stateRef = useRef({ t: 12, idx: 0 });
  stateRef.current.idx = idx;

  const date = useMemo(() => addDays(SUN_START, idx), [idx]);
  const dcInstalled = projLookup(dayKey(date)) ?? mountedMW;

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last.current) / 1000);
      last.current = now;
      let nt = stateRef.current.t + dt * 2.4; // 2.4 solar hours per second
      if (nt > 18.5) {
        nt = 5.5;
        setIdx((i) => (i + 1) % (SUN_DAYS + 1));
      }
      stateRef.current.t = nt;
      setT(nt);
    };
    raf.current = setInterval(tick, 40);
    return () => clearInterval(raf.current);
  }, [playing]);

  const setTime = (v) => { stateRef.current.t = v; setT(v); };

  // geometry: x = solar time 5..19 → 40..1160, y = elevation 0..90° → 250..30
  // (panoramic 1200×300 viewBox so the panel stays short at full browser width)
  const X = (tt) => 40 + (tt - 5) / 14 * 1120;
  const Y = (el) => 250 - Math.max(0, el) / 90 * 220;
  const arcFor = (n) => {
    const pts = [];
    for (let tt = 5; tt <= 19; tt += 0.1) {
      const { elev } = solarPos(n, tt);
      if (elev > -1) pts.push(`${X(tt).toFixed(1)},${Y(Math.max(0, elev)).toFixed(1)}`);
    }
    return pts.join(' ');
  };
  const n = dayOfYear(date);
  const arc = useMemo(() => arcFor(n), [n]);
  const arcJun = useMemo(() => arcFor(172), []);
  const arcDec = useMemo(() => arcFor(355), []);
  const noon = solarPos(n, 12);
  const pos = solarPos(n, t);
  const inst = instant(date, t, env);
  const peak = useMemo(() => kPeak(date, env), [date, env]);
  const dcReq = peak ? targetMW / peak.k : Infinity;
  const mins = useMemo(() => minutesAbove(date, env, dcInstalled, targetMW), [date, env, dcInstalled, targetMW]);

  // output strip: plant MW = k(t)·DC vs target, 6..18h
  const out = useMemo(() => {
    const pts = [];
    for (let m = 5 * 60; m <= 19 * 60; m += 5) {
      const p = instant(date, m / 60, env);
      pts.push({ t: m / 60, mw: p ? p.k * dcInstalled : 0 });
    }
    return pts;
  }, [date, env, dcInstalled]);
  const maxMW = Math.max(targetMW * 1.15, ...out.map(p => p.mw)) * 1.05;
  const OY = (mw) => 96 - mw / maxMW * 88;
  const outPath = out.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${OY(p.mw).toFixed(1)}`).join(' ');

  const sunUp = pos.elev > 0;
  const sx = X(t), sy = Y(pos.elev);

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg viewBox="0 0 1200 300" style={{ width: '100%', display: 'block', background: 'linear-gradient(#07070f 0%, #0c1024 55%, #11142a 84%, #0d0d18 84.5%)', borderRadius: 6 }}>
          <defs>
            <radialGradient id="sunGlow">
              <stop offset="0%" stopColor="#f5a623" stopOpacity="0.85" />
              <stop offset="45%" stopColor="#f5a623" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#f5a623" stopOpacity="0" />
            </radialGradient>
          </defs>
          {[15, 30, 45, 60, 75].map((el) => (
            <g key={el}>
              <line x1={40} y1={Y(el)} x2={1160} y2={Y(el)} stroke="#1e1e35" strokeWidth={0.6} strokeDasharray="3 5" />
              <text x={1168} y={Y(el) + 2.5} fontSize={7} fill="#3d3d55">{el}°</text>
            </g>
          ))}
          {/* ghost solstice arcs */}
          <polyline points={arcJun} fill="none" stroke="#2d2d4a" strokeWidth={1} strokeDasharray="2 4" />
          <polyline points={arcDec} fill="none" stroke="#2d2d4a" strokeWidth={1} strokeDasharray="2 4" />
          <text x={X(12) - 14} y={Y(solarPos(172, 12).elev) - 5} fontSize={7} fill="#3d3d55">21 Jun</text>
          <text x={X(12) - 14} y={Y(solarPos(355, 12).elev) - 5} fontSize={7} fill="#3d3d55">21 Dec</text>
          {/* today's arc */}
          <polyline points={arc} fill="none" stroke="#f5a62388" strokeWidth={1.6} />
          {/* horizon + ground + array */}
          <line x1={30} y1={250} x2={1170} y2={250} stroke="#2d2d4a" strokeWidth={1.2} />
          <g transform="translate(555,250)">
            {[0, 30, 60].map((dx) => (
              <polygon key={dx} points={`${dx},-1 ${dx + 22},-8 ${dx + 26},-6 ${dx + 4},1`} fill="#1e2a45" stroke="#818cf8" strokeWidth={0.7} />
            ))}
            <text x={45} y={26} fontSize={7} fill="#3d3d55" textAnchor="middle">fixed array · tilt 9.1° · az 11.6°</text>
          </g>
          {/* sun */}
          {sunUp && (<g>
            <circle cx={sx} cy={sy} r={26} fill="url(#sunGlow)" />
            <circle cx={sx} cy={sy} r={7} fill="#ffd166" stroke="#f5a623" strokeWidth={1.5} />
            <line x1={sx} y1={sy} x2={sx} y2={250} stroke="#f5a62333" strokeWidth={0.8} strokeDasharray="2 3" />
          </g>)}
          {/* time axis */}
          {[6, 9, 12, 15, 18].map((h) => (
            <text key={h} x={X(h)} y={262} fontSize={7.5} fill="#555" textAnchor="middle">{String(h).padStart(2, '0')}:00</text>
          ))}
          <text x={40} y={262} fontSize={7.5} fill="#3d3d55" textAnchor="end">E</text>
          <text x={1162} y={262} fontSize={7.5} fill="#3d3d55">W</text>
        </svg>
        {/* output vs target strip */}
        <svg viewBox="0 0 1200 110" style={{ width: '100%', display: 'block', background: '#0d0d14', borderRadius: 6, marginTop: 6 }}>
          <path d={outPath + ` L${X(19)},96 L${X(5)},96 Z`} fill="#818cf826" />
          <path d={outPath} fill="none" stroke="#818cf8" strokeWidth={1.4} />
          {/* highlight above-target section */}
          <clipPath id="aboveClip"><rect x={0} y={0} width={1200} height={Math.max(0, OY(targetMW))} /></clipPath>
          <path d={outPath} fill="none" stroke="#4ade80" strokeWidth={2} clipPath="url(#aboveClip)" />
          <line x1={40} y1={OY(targetMW)} x2={1160} y2={OY(targetMW)} stroke="#f5a623" strokeWidth={1} strokeDasharray="5 4" />
          <text x={44} y={OY(targetMW) - 4} fontSize={8} fill="#f5a623" fontWeight={700}>{targetMW} MWac target</text>
          {sunUp && <line x1={sx} y1={8} x2={sx} y2={100} stroke="#ffd16644" strokeWidth={1} />}
          <text x={1160} y={16} fontSize={8} fill="#555" textAnchor="end">plant output at {dcInstalled.toFixed(1)} MWdc installed</text>
          <text x={1160} y={104} fontSize={8} fill={mins > 0 ? '#4ade80' : '#ef4444'} textAnchor="end" fontWeight={700}>
            {mins > 0 ? `${mins} min/day ≥ target` : 'never reaches target'}
          </text>
        </svg>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button style={{ ...btn, width: 56, borderColor: playing ? '#f5a623' : '#2d2d4a', color: playing ? '#f5a623' : '#aaa' }}
            onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <input type="range" min={0} max={SUN_DAYS} value={idx} onChange={(e) => setIdx(+e.target.value)} style={{ flex: 1, accentColor: '#f5a623' }} />
          <input type="range" min={5.5} max={18.5} step={0.05} value={t} onChange={(e) => setTime(+e.target.value)} style={{ width: 130, accentColor: '#818cf8' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {[['Today', Math.round((todayNoon() - SUN_START) / 86400e3)], ['30 Sep', 60], ['31 Oct', 91], ['21 Dec', 142], ['31 Mar', 242]].map(([l, i]) => (
            <button key={l} style={{ ...btn, opacity: idx === i ? 1 : 0.6, borderColor: idx === i ? '#818cf8' : '#2d2d4a' }} onClick={() => setIdx(Math.min(SUN_DAYS, Math.max(0, i)))}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ width: 172, flexShrink: 0, fontSize: 9, color: '#888', lineHeight: 1.6 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#fff' }}>{fmtDY(date)}</div>
        <div style={{ color: '#555' }}>solar {String(Math.floor(t)).padStart(2, '0')}:{String(Math.floor((t % 1) * 60)).padStart(2, '0')} · dec {pos.dec.toFixed(1)}°</div>
        <div style={{ height: 1, background: '#1e1e35', margin: '7px 0' }} />
        <div>☀ elevation <b style={{ color: '#ffd166' }}>{Math.max(0, pos.elev).toFixed(1)}°</b> <span style={{ color: '#555' }}>(noon {noon.elev.toFixed(1)}°)</span></div>
        <div>POA <b style={{ color: '#ddd' }}>{inst ? inst.poa.toFixed(0) : 0} W/m²</b></div>
        <div>Tcell <b style={{ color: '#ddd' }}>{inst ? inst.tcell.toFixed(1) : '—'} °C</b> · k <b style={{ color: '#818cf8' }}>{inst ? inst.k.toFixed(3) : '—'}</b></div>
        <div style={{ height: 1, background: '#1e1e35', margin: '7px 0' }} />
        <div style={{ color: '#555', letterSpacing: 0.5, fontSize: 8 }}>THIS DAY · {SCENARIOS.find((s) => s.key === env.scenario)?.label?.toUpperCase() || 'CUSTOM'}</div>
        <div>k peak <b style={{ color: '#4ade80' }}>{peak ? peak.k.toFixed(3) : '—'}</b> at {peak ? `${String(Math.floor(peak.t)).padStart(2, '0')}:${String(Math.round((peak.t % 1) * 60)).padStart(2, '0')}` : '—'}</div>
        <div>POA peak <b style={{ color: '#ddd' }}>{peak ? peak.poa.toFixed(0) : '—'}</b> W/m²</div>
        <div>DC needed <b style={{ color: dcReq > TOTAL_MWDC ? '#ef4444' : '#f5a623' }}>{dcReq > 200 ? '—' : dcReq.toFixed(1)} MWdc</b></div>
        {dcReq > TOTAL_MWDC && <div style={{ color: '#ef4444', fontWeight: 700 }}>&gt; park cap — not feasible</div>}
        <div style={{ marginTop: 5, color: '#555', fontSize: 8 }}>installed that day (projection): <b style={{ color: '#888' }}>{dcInstalled.toFixed(1)} MWdc</b></div>
      </div>
    </div>
  );
});

// ── Main chart: DC required vs date + projected DC ──────────────────────────
const MainChart = memo(function MainChart({ curves, activeKey, proj, crossing, targetMW, startKey }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const days = curves[0].points;
  const N = days.length;
  const W = 1200, H = 300, L = 46, R = 1154, T = 14, B = 272;
  const feasible = curves.flatMap((c) => c.points.map((p) => p.req)).filter((v) => v <= TOTAL_MWDC + 3);
  const lo = Math.min(...feasible, ...proj.map((p) => p.mw), TOTAL_MWDC);
  const hi = Math.min(Math.max(...feasible, TOTAL_MWDC) + 1.5, 78);
  const ymin = Math.floor((lo - 2) / 5) * 5, ymax = Math.ceil(hi / 2.5) * 2.5;
  const Xi = (i) => L + i / (N - 1) * (R - L);
  const Yv = (v) => B - (Math.min(v, ymax) - ymin) / (ymax - ymin) * (B - T);
  const pathFor = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${Xi(i).toFixed(1)},${Yv(p.req).toFixed(1)}`).join(' ');
  const projPath = proj.map((p, i) => `${i ? 'L' : 'M'}${Xi(i).toFixed(1)},${Yv(p.mw).toFixed(1)}`).join(' ');
  const active = curves.find((c) => c.sc.key === activeKey) || curves[1];
  // infeasible ranges of the active scenario
  const infeas = [];
  let run = null;
  active.points.forEach((p, i) => {
    if (p.req > TOTAL_MWDC) { if (!run) run = [i, i]; else run[1] = i; }
    else if (run) { infeas.push(run); run = null; }
  });
  if (run) infeas.push(run);
  const monthTicks = days.map((p, i) => ({ i, d: p.d })).filter(({ d }) => d.getDate() === 1);
  const todayI = days.findIndex((p) => p.key === dayKey(todayNoon()));
  const startI = days.findIndex((p) => p.key === startKey);
  const crossI = crossing ? days.findIndex((p) => p.key === dayKey(crossing.date)) : -1;

  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width * W;
    const i = Math.round((fx - L) / (R - L) * (N - 1));
    setHover(i >= 0 && i < N ? i : null);
  };
  const hv = hover != null ? { d: days[hover].d, req: active.points[hover].req, mw: proj[hover].mw } : null;
  const fmtReq = (v) => v > TOTAL_MWDC ? `${v.toFixed(1)} ✕` : v.toFixed(2);

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: Math.floor((ymax - ymin) / 5) + 1 }, (_, k) => ymin + k * 5).map((v) => (
          <g key={v}>
            <line x1={L} y1={Yv(v)} x2={R} y2={Yv(v)} stroke="#16162a" strokeWidth={1} />
            <text x={L - 6} y={Yv(v) + 3} fontSize={8} fill="#555" textAnchor="end">{v}</text>
          </g>
        ))}
        {monthTicks.map(({ i, d }) => (
          <g key={i}>
            <line x1={Xi(i)} y1={T} x2={Xi(i)} y2={B} stroke="#16162a" strokeWidth={1} />
            <text x={Xi(i) + 3} y={B + 12} fontSize={8} fill="#555">{MONTHS[d.getMonth()]} {String(d.getFullYear()).slice(2)}</text>
          </g>
        ))}
        {/* infeasible band for active scenario */}
        {infeas.map(([a, b], j) => (
          <rect key={j} x={Xi(a)} y={T} width={Xi(b) - Xi(a)} height={B - T} fill="#ef444412" />
        ))}
        {/* park cap */}
        <line x1={L} y1={Yv(TOTAL_MWDC)} x2={R} y2={Yv(TOTAL_MWDC)} stroke="#ef4444" strokeWidth={1} strokeDasharray="6 4" />
        <text x={R} y={Yv(TOTAL_MWDC) - 4} fontSize={8.5} fill="#ef4444" textAnchor="end" fontWeight={700}>park cap 65.02 MWdc</text>
        {/* required curves */}
        {curves.map((c) => c.sc.key !== activeKey && (
          <path key={c.sc.key} d={pathFor(c.points)} fill="none" stroke={c.sc.color} strokeWidth={0.8} strokeOpacity={0.35} />
        ))}
        <path d={pathFor(active.points)} fill="none" stroke={active.sc.color} strokeWidth={2} />
        {/* projected mounted DC */}
        <path d={projPath} fill="none" stroke="#e5e7eb" strokeWidth={1.8} strokeDasharray="1 0" />
        {todayI >= 0 && (<g>
          <line x1={Xi(todayI)} y1={T} x2={Xi(todayI)} y2={B} stroke="#666" strokeWidth={1} strokeDasharray="3 4" />
          <text x={Xi(todayI) + 3} y={T + 9} fontSize={8} fill="#888">today</text>
        </g>)}
        {startI >= 0 && startI !== todayI && (
          <text x={Xi(startI) + 3} y={T + 19} fontSize={8} fill="#555">start</text>
        )}
        {crossI >= 0 && (<g>
          <line x1={Xi(crossI)} y1={Yv(crossing.dcReq)} x2={Xi(crossI)} y2={B} stroke="#4ade80" strokeWidth={1} strokeDasharray="3 3" />
          <circle cx={Xi(crossI)} cy={Yv(crossing.dcReq)} r={5} fill="none" stroke="#4ade80" strokeWidth={2} />
          <circle cx={Xi(crossI)} cy={Yv(crossing.dcReq)} r={1.8} fill="#4ade80" />
          <text x={Xi(crossI) + 8} y={Yv(crossing.dcReq) - 8} fontSize={9.5} fill="#4ade80" fontWeight={800}>{fmtD(crossing.date)} · {crossing.dcReq.toFixed(1)} MWdc</text>
        </g>)}
        {hover != null && <line x1={Xi(hover)} y1={T} x2={Xi(hover)} y2={B} stroke="#fff" strokeWidth={0.6} strokeOpacity={0.5} />}
        <text x={L} y={H - 6} fontSize={8} fill="#3d3d55">solid {active.sc.label.toLowerCase()} · faint: other scenarios · white: projected mounted DC · red band: target not demonstrable (&gt; 65.02)</text>
      </svg>
      {hv && (
        <div style={{ position: 'absolute', top: 6, right: 8, background: '#1a1a2e', border: '1px solid #3a3a55', borderRadius: 5, padding: '6px 9px', fontSize: 9, color: '#bbb', pointerEvents: 'none', minWidth: 168 }}>
          <b style={{ color: '#fff' }}>{fmtDY(hv.d)}</b>
          <div style={{ color: '#666', fontSize: 8, margin: '2px 0 1px' }}>required MWdc (✕ = &gt; 65.02 cap)</div>
          {curves.map((c) => {
            const v = c.points[hover].req;
            const isActive = c.sc.key === activeKey;
            return (
              <div key={c.sc.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: c.sc.color, fontWeight: isActive ? 800 : 500 }}>{c.sc.label.toLowerCase()}{isActive ? ' ●' : ''}</span>
                <b style={{ color: v > TOTAL_MWDC ? '#ef4444' : c.sc.color }}>{fmtReq(v)}</b>
              </div>
            );
          })}
          <div style={{ height: 1, background: '#3a3a55', margin: '3px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>projected</span><b style={{ color: '#e5e7eb' }}>{hv.mw.toFixed(2)}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>margin ({active.sc.label.toLowerCase()})</span>
            <b style={{ color: hv.mw >= hv.req ? '#4ade80' : '#fb923c' }}>{(hv.mw - hv.req).toFixed(2)}</b>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Park hierarchy tree: MVPS → inverter → SCB → strings ────────────────────
const INV_STATUS = {
  started: { label: 'STARTABLE', color: '#4ade80', bg: '#12241a', info: 'Has at least one mounted string behind an approved SCB — reaches start-up voltage (a single 30-module string gives 1,083 V at 60 °C ≥ 905 V).' },
  noscb: { label: 'NO SCB', color: '#fb923c', bg: '#241a12', info: 'Has mounted strings but none behind an approved SCB — cannot be energised yet.' },
  dark: { label: 'DARK', color: '#ef4444', bg: '#241212', info: 'No mounted strings at all. ER3 requires every inverter started, so it needs at least 1 string.' },
};

const ParkTree = memo(function ParkTree({ park }) {
  const [openMv, setOpenMv] = useState(() => new Set([5]));
  const [openInv, setOpenInv] = useState(() => new Set(park.invList.filter((i) => i.mv === 5 && i.status === 'dark').map((i) => i.key)));
  const [openScb, setOpenScb] = useState(() => new Set());
  const flip = (setter) => (id) => setter((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fMv = flip(setOpenMv), fInv = flip(setOpenInv), fScb = flip(setOpenScb);
  const chev = (open) => <span style={{ display: 'inline-block', width: 10, color: '#555', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', fontSize: 9 }}>▶</span>;
  const bar = (m, t, color) => (
    <div style={{ width: 70, height: 4, background: '#0d0d18', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ height: '100%', width: `${t ? m / t * 100 : 0}%`, background: color, borderRadius: 2 }} />
    </div>
  );
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button style={btn} onClick={() => { setOpenMv(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])); setOpenInv(new Set(park.invList.map((i) => i.key))); }}>⊞ Expand all</button>
        <button style={btn} onClick={() => { setOpenMv(new Set()); setOpenInv(new Set()); setOpenScb(new Set()); }}>⊟ Collapse all</button>
        <span style={{ fontSize: 8, color: '#555', alignSelf: 'center' }}>
          {Object.entries(INV_STATUS).map(([k, v], i) => (
            <span key={k}>{i > 0 && ' · '}<b style={{ color: v.color }}>{v.label.toLowerCase()}</b> {park.invList.filter((x) => x.status === k).length}</span>
          ))}
        </span>
      </div>
      <div style={{ fontSize: 8, color: '#555', lineHeight: 1.5, marginBottom: 8 }}>
        <b style={{ color: INV_STATUS.started.color }}>startable</b> = at least one mounted string behind an approved SCB (reaches the 905 V start-up voltage) ·{' '}
        <b style={{ color: INV_STATUS.noscb.color }}>no scb</b> = has mounted strings but none behind an approved SCB ·{' '}
        <b style={{ color: INV_STATUS.dark.color }}>dark</b> = no strings mounted at all, the inverter cannot energise (ER3 needs every one started, so each dark unit needs ≥1 string)
      </div>
      {Object.values(park.mvps).map((m) => {
        const open = openMv.has(m.mv);
        const st = { started: 0, noscb: 0, dark: 0 };
        m.invs.forEach((i) => st[i.status]++);
        const isCrit = m.mv === 5;
        return (
          <div key={m.mv} style={{ marginBottom: 5, border: `1px solid ${isCrit ? '#f5a62366' : '#1e1e35'}`, borderRadius: 6, background: '#0f0f1c', overflow: 'hidden' }}>
            <div onClick={() => fMv(m.mv)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', background: open ? '#141426' : 'transparent' }}>
              {chev(open)}
              <span style={{ fontSize: 11, fontWeight: 800, color: BC[m.mv], width: 58 }}>MVPS {m.mv}</span>
              {isCrit && <span style={{ fontSize: 7, fontWeight: 800, color: '#f5a623', border: '1px solid #f5a62355', borderRadius: 3, padding: '1px 5px', letterSpacing: 0.5 }}>CRITICAL PATH</span>}
              <span style={{ fontSize: 9, color: '#888' }}>{m.invs.length} inverters</span>
              <span style={{ fontSize: 8 }}>
                {st.started > 0 && <b style={{ color: '#4ade80' }}>{st.started} startable</b>}
                {st.noscb > 0 && <b style={{ color: '#fb923c' }}> · {st.noscb} no-SCB</b>}
                {st.dark > 0 && <b style={{ color: '#ef4444' }}> · {st.dark} dark</b>}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 9, color: '#888' }}>{m.mounted}/{m.total} strings</span>
              {bar(m.mounted, m.total, BC[m.mv])}
              <span style={{ fontSize: 9, color: '#666', width: 74, textAlign: 'right' }}>{(m.mounted * STRING_KWP / 1000).toFixed(2)} MWdc</span>
            </div>
            {open && m.invs.map((inv) => {
              const iOpen = openInv.has(inv.key);
              const S = INV_STATUS[inv.status];
              return (
                <div key={inv.key} style={{ borderTop: '1px solid #14142a' }}>
                  <div onClick={() => fInv(inv.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 4px 26px', cursor: 'pointer' }}>
                    {chev(iOpen)}
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#ccc', width: 68 }}>MVPS{inv.mv}-{inv.letter}</span>
                    <span title={S.info} style={{ fontSize: 7, fontWeight: 800, color: S.color, background: S.bg, border: `1px solid ${S.color}44`, borderRadius: 3, padding: '1px 6px', letterSpacing: 0.5 }}>{S.label}</span>
                    <span style={{ fontSize: 8, color: '#666' }}>{inv.scbs.length} SCBs</span>
                    <span style={{ marginLeft: 'auto', fontSize: 8.5, color: '#888' }}>{inv.mounted}/{inv.total}</span>
                    {bar(inv.mounted, inv.total, S.color)}
                    <span style={{ fontSize: 8.5, color: '#666', width: 74, textAlign: 'right' }}>{(inv.mounted * STRING_KWP / 1000).toFixed(2)} MWdc</span>
                  </div>
                  {iOpen && inv.scbs.map((s) => {
                    const sOpen = openScb.has(s.id);
                    const w = SCB_STATUS_LABELS[s.wiring] || SCB_STATUS_LABELS[0];
                    return (
                      <div key={s.id}>
                        <div onClick={() => fScb(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px 3px 46px', cursor: 'pointer', borderTop: '1px solid #10101f' }}>
                          {chev(sOpen)}
                          <span style={{ fontSize: 9, fontFamily: 'monospace', fontWeight: 700, color: '#aaa', width: 46 }}>{s.id}</span>
                          <span style={{ fontSize: 7.5, color: w.color, border: `1px solid ${w.color}44`, borderRadius: 3, padding: '0px 5px' }}>⚑ {w.label}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 8, color: '#777' }}>{s.mounted}/{s.total} strings</span>
                          {bar(s.mounted, s.total, s.mounted === s.total ? '#4ade80' : s.mounted > 0 ? '#f5c518' : '#33334d')}
                          <span style={{ fontSize: 8, color: '#555', width: 74, textAlign: 'right' }}>{(s.mounted * STRING_KWP / 1000).toFixed(3)} MWdc</span>
                        </div>
                        {sOpen && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '4px 10px 7px 64px' }}>
                            {s.tables.map((t) => (
                              <span key={t.id} title={`${t.id} — ${t.mounted ? 'PV mounted' : 'not mounted'}`}
                                style={{ fontSize: 8, fontFamily: 'monospace', borderRadius: 3, padding: '1px 5px', background: t.mounted ? '#12241a' : '#191926', color: t.mounted ? '#4ade80' : '#555', border: `1px solid ${t.mounted ? '#22c55e44' : '#23233a'}` }}>
                                {t.id}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});

// ── Root component ──────────────────────────────────────────────────────────
export default function ReadinessTab() {
  const [tip, setTip] = useState(null);
  const [data, setData] = useState({ phases: {}, scbStatus: {}, loading: true, error: null, loadedAt: null });

  const load = useCallback(async () => {
    setData((d) => ({ ...d, loading: true, error: null }));
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API_URL}?action=read`),
        fetch(`${API_URL}?action=readConfig`),
      ]);
      const j1 = await r1.json();
      const j2 = await r2.json();
      if (!j1.ok) throw new Error(j1.error || 'read failed');
      const phases = {};
      j1.data.forEach((row) => { phases[row.id] = parseInt(row.phase) || 0; });
      const scbStatus = (j2.ok && j2.config?.scbStatus) || {};
      setData({ phases, scbStatus, loading: false, error: null, loadedAt: new Date() });
    } catch (e) {
      setData((d) => ({ ...d, loading: false, error: String(e.message || e) }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ── controls state ────────────────────────────────────────────────────────
  const DEFAULT_EXEC = useMemo(() => ({ targetMW: 25, rate: 24, workdays: 6, startISO: toISO(todayNoon()), useProgress: true }), []);
  const [exec, setExec] = useState(DEFAULT_EXEC);
  const setE = (patch) => setExec((p) => ({ ...p, ...patch }));
  const [env, setEnv] = useState({ ...DEFAULT_ENV });
  const setV = (patch) => setEnv((p) => ({ ...p, ...patch }));
  const rate = exec.rate;
  const activeSc = SCENARIOS.find((s) => s.key === env.scenario) || SCENARIOS[1];
  const scModified = activeSc && (env.poaMult !== activeSc.poaMult || env.tambOff !== activeSc.tambOff || env.soiling !== activeSc.soiling);

  // ── derived model ─────────────────────────────────────────────────────────
  const park = useMemo(() => buildPark(TABLES, data.phases, data.scbStatus), [data.phases, data.scbStatus]);
  const startDate = useMemo(() => fromISO(exec.startISO), [exec.startISO]);
  const startTables = exec.useProgress ? park.mountedTables : 0;

  const curveStart = useMemo(() => { const t = todayNoon(); return addDays(t < startDate ? t : startDate, -5); }, [startDate]);
  const curveEnd = useMemo(() => addDays(curveStart, 225), [curveStart]);
  const days = useMemo(() => {
    const out = [];
    for (let d = addDays(curveStart, 0); d <= curveEnd; d = addDays(d, 1)) out.push({ d, key: dayKey(d) });
    return out;
  }, [curveStart, curveEnd]);

  // one required-DC curve per scenario (active scenario uses the edited params)
  const curves = useMemo(() => SCENARIOS.map((sc) => {
    const e = sc.key === env.scenario
      ? env
      : { ...env, poaMult: sc.poaMult, tambOff: sc.tambOff, soiling: sc.soiling };
    return { sc, points: days.map(({ d, key }) => ({ d, key, req: dcRequired(d, e, exec.targetMW) })) };
  }), [days, env, exec.targetMW]);
  const activeCurve = curves.find((c) => c.sc.key === env.scenario) || curves[1];
  const reqCache = useMemo(() => {
    const m = new Map();
    activeCurve.points.forEach((p) => m.set(p.key, p.req));
    return m;
  }, [activeCurve]);

  const projMap = useMemo(
    () => projectTables(startDate, addDays(curveEnd, 320), startTables, rate, exec.workdays),
    [startDate, curveEnd, startTables, rate, exec.workdays]);
  const proj = useMemo(() => days.map(({ d, key }) => ({
    d, key, mw: (d < startDate ? startTables : (projMap.get(key) ?? startTables)) * STRING_KWP / 1000,
  })), [days, projMap, startDate, startTables]);
  const projLookup = useCallback((key) => {
    const t = projMap.get(key);
    return t === undefined ? undefined : t * STRING_KWP / 1000;
  }, [projMap]);

  const crossing = useMemo(
    () => findCrossing(startDate, addDays(startDate, 500), startTables, rate, exec.workdays, env, exec.targetMW, reqCache),
    [startDate, startTables, rate, exec.workdays, env, exec.targetMW, reqCache]);

  const today = todayNoon();
  const reqToday = reqCache.get(dayKey(today)) ?? dcRequired(today, env, exec.targetMW);
  const margin = park.mountedMW - reqToday;
  const invGap = 56 - park.startedInvs;
  const powerOnly = !data.loading && !data.error && invGap > 0;

  // rate → earliest date
  const rateRows = useMemo(() => {
    const rates = [...new Set([10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, Math.round(rate)])].sort((a, b) => a - b);
    return rates.map((r) => ({
      r,
      cur: Math.abs(r - rate) < 0.5,
      cross: findCrossing(startDate, addDays(startDate, 500), startTables, r, exec.workdays, env, exec.targetMW, reqCache),
    }));
  }, [rate, startDate, startTables, exec.workdays, env, exec.targetMW, reqCache]);

  // minutes-above-target table
  const minutesRows = useMemo(() => {
    const dcCols = [...new Set([+park.mountedMW.toFixed(1), 55, 60, 62.5, +TOTAL_MWDC.toFixed(2)])].sort((a, b) => a - b);
    const dates = [];
    for (let k = 0; k < 12; k++) {
      const base = new Date(2026, 8, 1, 12);
      const d = new Date(base.getFullYear(), base.getMonth() + (k >> 1), (k % 2) ? 15 : 1, 12);
      dates.push(d);
    }
    return { dcCols, rows: dates.map((d) => ({ d, mins: dcCols.map((dc) => minutesAbove(d, env, dc, exec.targetMW)) })) };
  }, [park.mountedMW, env, exec.targetMW]);

  // scenario summary: mean daily-peak POA per month + Bendt frequency
  const scenRows = useMemo(() => SCENARIOS.map((sc) => {
    const e = sc.key === env.scenario ? env : { ...env, poaMult: sc.poaMult, tambOff: sc.tambOff, soiling: sc.soiling };
    const meanPoa = (year, mo) => {
      let sum = 0, c = 0;
      for (let dd = 2; dd <= 30; dd += 4) { const p = kPeak(new Date(year, mo, dd, 12), e); if (p) { sum += p.poa; c++; } }
      return c ? sum / c : 0;
    };
    return {
      sc, e, active: sc.key === env.scenario,
      poaSep: meanPoa(2026, 8), poaOct: meanPoa(2026, 9), poaNov: meanPoa(2026, 10),
      fSep: bendtFreq(9, e.poaMult), fOct: bendtFreq(10, e.poaMult),
    };
  }), [env]);

  // date × scenario matrix (Mondays)
  const matrixRows = useMemo(
    () => days.map(({ d }, i) => ({ d, i })).filter(({ d }) => d.getDay() === 1 && d >= addDays(today, -1))
      .map(({ d, i }) => ({ d, vals: curves.map((c) => c.points[i].req) })),
    [days, curves, today]);

  const kpis = [
    {
      label: 'ACHIEVABLE DATE', color: crossing ? '#4ade80' : '#ef4444',
      val: crossing ? fmtD(crossing.date) : 'not in horizon',
      sub: crossing ? `${Math.ceil((crossing.date - startDate) / 86400e3 / 7)} weeks at ${rate.toFixed(0)}/day · needs ${crossing.dcReq.toFixed(1)} MWdc` : `no crossing within 500 days at ${rate.toFixed(0)}/day`,
      border: powerOnly ? '#f5a62366' : undefined,
      warn: powerOnly ? `⚠ power-only — ${invGap} inverters not yet startable (${park.darkInvs.length} dark · ${park.noScbInvs} no SCB)` : null,
      info: 'First date on which the projected mounted DC meets the minimum DC required to demonstrate the AC target that same day, under the active weather scenario. Reaching the daily peak is enough — it does not need to be sustained. This date covers the POWER condition only: ER3 additionally requires all 56 inverters started (≥1 mounted string behind an approved SCB each) — the amber note appears while any inverter is not yet startable.',
    },
    {
      label: 'DC REQUIRED TODAY', color: reqToday > TOTAL_MWDC ? '#ef4444' : '#f5a623',
      val: reqToday > TOTAL_MWDC ? '> cap' : `${reqToday.toFixed(1)} MWdc`,
      sub: `target ${exec.targetMW} MWac · ${activeSc.label.toLowerCase()}${scModified ? ' (edited)' : ''}`,
      info: `Minimum DC that must be mounted and exporting to reach ${exec.targetMW} MWac at the delivery point today: target / k_peak, where k(t) = losses × POA/1000 × (1 − γ·(Tcell − 25)) already contains the irradiance ratio.`,
    },
    {
      label: 'DC MOUNTED (LIVE)', color: '#818cf8',
      val: `${park.mountedMW.toFixed(2)} MWdc`,
      sub: `${park.mountedTables} / ${TOTAL_STRINGS} tables · ${(park.mountedTables / TOTAL_STRINGS * 100).toFixed(1)}%`,
      info: 'Tables with PV mounted (phase ≥ 5) from the live tracker data, × 18.45 kWp per string.',
    },
    {
      label: 'MARGIN TODAY', color: margin >= 0 ? '#4ade80' : '#fb923c',
      val: `${margin >= 0 ? '+' : ''}${margin.toFixed(1)} MWdc`,
      sub: margin >= 0 ? 'mounted exceeds today’s requirement' : 'still short of today’s requirement',
      info: 'Mounted DC minus the DC required today under the active scenario. Negative means the park could not demonstrate the target today even with perfect weather of that scenario class.',
    },
    {
      label: 'INVERTERS STARTABLE', color: park.startedInvs === 56 ? '#4ade80' : '#fb923c',
      val: `${park.startedInvs} / 56`,
      sub: `${park.noScbInvs} with modules but no approved SCB · ${park.darkInvs.length} dark`,
      info: 'SG1100UD units with at least one mounted string behind an approved SCB. Start-up is a voltage condition, not power: one 30-module string gives 1,083 V at 60 °C, above the 905 V start threshold. "Dark" = units with no strings mounted at all, which cannot energise yet. ER3 requires ALL inverters started to verify reactive capability.',
    },
  ];

  const selBtn = (on, color = '#818cf8') => ({
    ...btn, padding: '4px 10px', fontSize: 10,
    background: on ? '#1e2a45' : '#141422', border: `1px solid ${on ? color : '#23233a'}`, color: on ? '#dbe2ff' : '#888', fontWeight: 700,
  });

  return (
    <TipCtx.Provider value={setTip}>
      <div style={{ flex: 1, overflowY: 'auto', background: '#0a0a12', padding: '14px 16px', color: '#ddd', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#f5a623' }}>🎯 Minimum DC</span>
          <span style={{ fontSize: 10, color: '#555' }}>
            Minimum DC to demonstrate {exec.targetMW} MWac at the delivery point under ER3 · audited clear-sky model · live mounting progress
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: data.error ? '#ef4444' : '#555' }}>
            {data.loading ? '⟳ loading live data…' : data.error ? `⚠ ${data.error} — showing empty progress` : `data ${data.loadedAt?.toLocaleTimeString()}`}
          </span>
          <button style={btn} onClick={load} disabled={data.loading} title="Reload from Google Sheets">↺ Reload</button>
        </div>

        {/* KPI row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 9, marginBottom: 12 }}>
          {kpis.map((k) => (
            <div key={k.label} style={{ ...card, textAlign: 'center', ...(k.border ? { borderColor: k.border } : {}) }}>
              <div style={{ fontSize: 8, color: '#555', letterSpacing: 1, marginBottom: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {k.label}<Info text={k.info} />
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, color: k.color, lineHeight: 1.1 }}>{k.val}</div>
              <div style={{ fontSize: 8, color: '#555', marginTop: 4 }}>{k.sub}</div>
              {k.warn && <div style={{ fontSize: 8, color: '#f5a623', fontWeight: 700, marginTop: 4 }}>{k.warn}</div>}
            </div>
          ))}
        </div>

        {/* controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>EXECUTION</span>
              <span style={{ fontSize: 8, color: '#444' }}>workforce, calendar and target — recomputes instantly</span>
              <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => setExec(DEFAULT_EXEC)}>↺ Reset</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px 16px' }}>
              <div>
                <div style={lbl}>TARGET (MWac)<Info text="AC power to demonstrate at the delivery point. 50 MWac is the full export cap; 25 MWac is the reduced first-stage option." /></div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button style={selBtn(exec.targetMW === 50)} onClick={() => setE({ targetMW: 50 })}>50</button>
                  <button style={selBtn(exec.targetMW === 25)} onClick={() => setE({ targetMW: 25 })}>25</button>
                  <input type="number" min={1} max={50} step={1} value={exec.targetMW} style={{ ...numIn, width: 46 }}
                    onChange={(e) => setE({ targetMW: Math.max(1, Math.min(50, +e.target.value || 0)) })} />
                </div>
              </div>
              <div>
                <div style={lbl}>TABLES / DAY<Info text="Total mounting rate per workday. Observed on the tracker: ~24 tables per workday over the last 4 weeks (~140/week on 6-day weeks)." /></div>
                <input type="number" min={1} step={1} value={rate} style={numIn}
                  onChange={(e) => setE({ rate: Math.max(1, +e.target.value || 1) })} />
                <span style={{ fontSize: 8, color: '#444', marginLeft: 6 }}>≈ {(rate * exec.workdays).toFixed(0)}/week</span>
              </div>
              <div>
                <div style={lbl}>WORKDAYS / WEEK<Info text="6 by default — no work on Sundays. 5 also skips Saturdays; 7 works every day." /></div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[5, 6, 7].map((w) => (
                    <button key={w} style={selBtn(exec.workdays === w)} onClick={() => setE({ workdays: w })}>{w}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={lbl}>PROJECTION START<Info text="Date the projection starts counting workdays from. Today by default." /></div>
                <input type="date" value={exec.startISO}
                  style={{ ...numIn, width: 110, textAlign: 'left', colorScheme: 'dark' }}
                  onChange={(e) => e.target.value && setE({ startISO: e.target.value })} />
              </div>
              <div>
                <div style={lbl}>START FROM CURRENT PROGRESS<Info text="ON: the projection starts from the tables already mounted per the live tracker. OFF: greenfield — starts from zero mounted tables." /></div>
                <Toggle on={exec.useProgress} set={(v) => setE({ useProgress: v })} />
                <span style={{ fontSize: 8, color: '#444', marginLeft: 8 }}>{exec.useProgress ? `${park.mountedTables} tables today` : 'from zero'}</span>
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>WEATHER & MODEL</span>
              {scModified && <span style={{ fontSize: 8, color: '#f5a623' }}>● scenario edited</span>}
              <button style={{ ...btn, marginLeft: 'auto' }}
                onClick={() => setEnv({ ...DEFAULT_ENV, scenario: env.scenario, poaMult: activeSc.poaMult, tambOff: activeSc.tambOff, soiling: activeSc.soiling })}>
                ↺ Reset scenario
              </button>
              <button style={btn} onClick={() => setEnv({ ...DEFAULT_ENV })}>↺ All defaults</button>
            </div>
            <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
              {SCENARIOS.map((sc) => (
                <button key={sc.key}
                  style={{ ...selBtn(env.scenario === sc.key, sc.color), flex: 1, color: env.scenario === sc.key ? sc.color : '#888' }}
                  onClick={() => setV({ scenario: sc.key, poaMult: sc.poaMult, tambOff: sc.tambOff, soiling: sc.soiling })}>
                  {sc.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px 16px' }}>
              <div>
                <div style={lbl}>POA MULTIPLIER<Info text="Scales the clear-sky plane-of-array irradiance. The Bendt screening frequencies update with it: this multiplier defines the daily clearness threshold (0.72 × mult) the day must beat." /></div>
                <input type="number" min={0.8} max={1.1} step={0.01} value={env.poaMult} style={numIn}
                  onChange={(e) => setV({ poaMult: Math.max(0.5, Math.min(1.2, +e.target.value || 1)) })} />
                <span style={{ fontSize: 8, color: '#444', marginLeft: 6 }}>freq Sep {(bendtFreq(9, env.poaMult) * 100).toFixed(0)}% · Oct {(bendtFreq(10, env.poaMult) * 100).toFixed(0)}%</span>
              </div>
              <div>
                <div style={lbl}>ΔT AMBIENT (°C)<Info text="Offset on the monthly-mean diurnal ambient temperature sinusoid (peaks at 14:00 solar)." /></div>
                <input type="number" min={-5} max={6} step={0.5} value={env.tambOff} style={numIn}
                  onChange={(e) => setV({ tambOff: Math.max(-10, Math.min(10, +e.target.value || 0)) })} />
              </div>
              <div>
                <div style={lbl}>SOILING (%)<Info text="Soiling loss. The base loss chain carries 1.0% — this replaces it." /></div>
                <input type="number" min={0} max={5} step={0.1} value={+(env.soiling * 100).toFixed(1)} style={numIn}
                  onChange={(e) => setV({ soiling: Math.max(0, Math.min(0.08, (+e.target.value || 0) / 100)) })} />
              </div>
              <div>
                <div style={lbl}>EXTRA ATTENUATION {(env.atten * 100).toFixed(0)}%<Info text="Additional atmospheric attenuation on the Haurwitz clear-sky GHI, which is an upper bound. 0–10%." /></div>
                <input type="range" min={0} max={0.10} step={0.005} value={env.atten} style={{ width: '100%', accentColor: '#f5a623' }}
                  onChange={(e) => setV({ atten: +e.target.value })} />
              </div>
              <div>
                <div style={lbl}>THERMAL RISE {env.rise.toFixed(1)} °C<Info text="Cell temperature rise at 1000 W/m²: Tcell = Tamb + rise·POA/1000. 28.5 °C is the adopted intermediate between NOCT (31.25) and the PVsyst balance (24.0)." /></div>
                <input type="range" min={24} max={32} step={0.5} value={env.rise} style={{ width: '100%', accentColor: '#f5a623' }}
                  onChange={(e) => setV({ rise: +e.target.value })} />
              </div>
              <div>
                <div style={lbl}>BIFACIAL GAIN {(env.bifacial * 100).toFixed(1)}%<Info text="Bifacial rear-side gain. The base loss chain carries +2.0% — this replaces it. Range 1–3%." /></div>
                <input type="range" min={0.01} max={0.03} step={0.001} value={env.bifacial} style={{ width: '100%', accentColor: '#f5a623' }}
                  onChange={(e) => setV({ bifacial: +e.target.value })} />
              </div>
            </div>
          </div>
        </div>

        {/* main chart */}
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>REQUIRED DC vs PROJECTED MOUNTING</span>
            <Info text="Coloured curves: minimum DC that must be mounted to demonstrate the AC target on each date (target / k_peak of that day) — one per scenario, the active one solid. White line: projected mounted DC from the workforce settings. The green marker is the first day the projection meets the requirement." />
            <span style={{ fontSize: 8, color: '#444' }}>hover for daily readout</span>
          </div>
          <MainChart curves={curves} activeKey={env.scenario} proj={proj} crossing={crossing} targetMW={exec.targetMW} startKey={dayKey(startDate)} />
        </div>

        {/* sun & irradiance */}
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>SUN & IRRADIANCE</span>
            <Info text="Clear-sky sun path over the array (lat 17.47 N). The bright arc is the selected day; dashed arcs are the solstice envelope. The lower strip converts the sun into plant output for the DC projected to be installed that day, against the AC target — the green section is the demonstration window. Play sweeps the sun through the day and rolls the calendar forward; drag the sliders to scrub date and time." />
            <span style={{ fontSize: 8, color: '#444' }}>Haurwitz clear-sky · {activeSc.label.toLowerCase()}{scModified ? ' (edited)' : ''} scenario applied</span>
          </div>
          <SunPanel env={env} targetMW={exec.targetMW} projLookup={projLookup} mountedMW={park.mountedMW} />
        </div>

        {/* matrix + rate table */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>MINIMUM DC BY DATE × SCENARIO</span>
              <Info text="Minimum mounted DC (MWdc) to demonstrate the AC target on each Monday, for the four weather scenarios. Red cells: the requirement exceeds the 65.02 MWdc park capacity — the target cannot be demonstrated that day under that scenario." />
            </div>
            <div style={{ maxHeight: 330, overflowY: 'auto', border: '1px solid #1e1e35', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
                <thead><tr>
                  <th style={{ ...thS, textAlign: 'left' }}>WEEK OF</th>
                  {SCENARIOS.map((sc) => (
                    <th key={sc.key} style={{ ...thS, textAlign: 'right', color: sc.key === env.scenario ? sc.color : '#555' }}>
                      {sc.label.toUpperCase()}{sc.key === env.scenario ? ' ●' : ''}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {matrixRows.map(({ d, vals }) => {
                    const isCrossWk = crossing && Math.abs(d - crossing.date) < 3.5 * 86400e3;
                    return (
                      <tr key={dayKey(d)} style={{ background: isCrossWk ? '#12241a' : 'transparent' }}>
                        <td style={{ ...tdS, color: isCrossWk ? '#4ade80' : '#999', fontWeight: isCrossWk ? 800 : 400 }}>{fmtDY(d)}</td>
                        {vals.map((v, j) => (
                          <td key={j} style={{ ...tdS, textAlign: 'right', fontWeight: SCENARIOS[j].key === env.scenario ? 700 : 400, color: v > TOTAL_MWDC ? '#ef4444' : SCENARIOS[j].key === env.scenario ? SCENARIOS[j].color : '#888' }}>
                            {v > TOTAL_MWDC ? '✕ not feasible' : v.toFixed(1)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>MOUNTING RATE → EARLIEST DATE</span>
              <Info text="Earliest achievable demonstration date as a function of the mounting rate, keeping every other setting (start, calendar, scenario, target). The highlighted row is the current workforce setting." />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead><tr>
                <th style={{ ...thS, textAlign: 'right' }}>TABLES/DAY</th>
                <th style={{ ...thS, textAlign: 'right' }}>/WEEK</th>
                <th style={{ ...thS, textAlign: 'left', paddingLeft: 14 }}>ACHIEVABLE</th>
                <th style={{ ...thS, textAlign: 'right' }}>WEEKS</th>
                <th style={{ ...thS, textAlign: 'right' }}>DC NEEDED</th>
              </tr></thead>
              <tbody>
                {rateRows.map(({ r, cur, cross }) => (
                  <tr key={r} style={{ background: cur ? '#1e2a45' : 'transparent' }}>
                    <td style={{ ...tdS, textAlign: 'right', fontWeight: cur ? 800 : 400, color: cur ? '#dbe2ff' : '#999' }}>{r}{cur ? ' ●' : ''}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#666' }}>{r * exec.workdays}</td>
                    <td style={{ ...tdS, paddingLeft: 14, fontWeight: 700, color: cross ? '#4ade80' : '#ef4444' }}>{cross ? fmtDY(cross.date) : 'not in horizon'}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{cross ? Math.ceil((cross.date - startDate) / 86400e3 / 7) : '—'}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{cross ? cross.dcReq.toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 8, color: '#555', marginTop: 6, lineHeight: 1.5 }}>
              Tracker-observed pace: ~122 tables/week over 9 weeks, ~140/week over the last 4 (≈24/workday). Derived from last-edit timestamps — treat as indicative.
            </div>
          </div>
        </div>

        {/* minutes above target + scenario table */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>MINUTES / DAY AT OR ABOVE TARGET</span>
              <Info text="Minutes per clear-sky day the plant output would sit at or above the AC target, by date and installed DC (active scenario applied). The demonstration only needs to touch the peak, but a wider window makes scheduling the NGCP witness test far safer." />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead><tr>
                <th style={{ ...thS, textAlign: 'left' }}>DATE</th>
                {minutesRows.dcCols.map((dc) => (
                  <th key={dc} style={{ ...thS, textAlign: 'right', color: Math.abs(dc - park.mountedMW) < 0.06 ? '#818cf8' : '#555' }}>
                    {dc.toFixed(1)}{Math.abs(dc - park.mountedMW) < 0.06 ? ' (now)' : ''}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {minutesRows.rows.map(({ d, mins }) => (
                  <tr key={dayKey(d)}>
                    <td style={{ ...tdS, color: '#999' }}>{fmtDY(d)}</td>
                    {mins.map((m, j) => (
                      <td key={j} style={{ ...tdS, textAlign: 'right', fontWeight: m > 0 ? 600 : 400, color: m === 0 ? '#ef4444' : m < 30 ? '#fb923c' : m < 90 ? '#f5c518' : '#4ade80' }}>
                        {m === 0 ? '—' : m}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 8, color: '#555', marginTop: 6 }}>Columns: installed MWdc. Clear-sky upper bound with the active scenario multipliers.</div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>WEATHER SCENARIOS</span>
              <Info text="The four scenario presets: POA multiplier, ambient offset and soiling, the resulting mean daily-peak POA by month, and the Bendt screening frequency — the share of days whose daily clearness index beats the scenario's threshold (0.72 × POA multiplier), with shape parameters 1.98 (Sep) and 1.26 (Oct) on the 0.05–0.78 interval. Screening probabilities, not proven weather probabilities." />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead><tr>
                <th style={{ ...thS, textAlign: 'left' }}>SCENARIO</th>
                <th style={{ ...thS, textAlign: 'right' }}>POA ×</th>
                <th style={{ ...thS, textAlign: 'right' }}>ΔT</th>
                <th style={{ ...thS, textAlign: 'right' }}>SOIL</th>
                <th style={{ ...thS, textAlign: 'right' }}>POA SEP</th>
                <th style={{ ...thS, textAlign: 'right' }}>POA OCT</th>
                <th style={{ ...thS, textAlign: 'right' }}>POA NOV</th>
                <th style={{ ...thS, textAlign: 'right' }}>FREQ SEP</th>
                <th style={{ ...thS, textAlign: 'right' }}>FREQ OCT</th>
              </tr></thead>
              <tbody>
                {scenRows.map(({ sc, e, active, poaSep, poaOct, poaNov, fSep, fOct }) => (
                  <tr key={sc.key} style={{ background: active ? '#141426' : 'transparent' }}>
                    <td style={{ ...tdS, fontWeight: 700, color: sc.color }}>{sc.label}{active ? ' ●' : ''}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#999' }}>{e.poaMult.toFixed(2)}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#999' }}>{e.tambOff > 0 ? '+' : ''}{e.tambOff}°</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#999' }}>{(e.soiling * 100).toFixed(1)}%</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{poaSep.toFixed(0)}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{poaOct.toFixed(0)}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{poaNov.toFixed(0)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: '#ccc' }}>{(fSep * 100).toFixed(0)}%</td>
                    <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: '#ccc' }}>{(fOct * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 8, color: '#555', marginTop: 6, lineHeight: 1.5 }}>
              POA columns: mean daily-peak plane-of-array irradiance (W/m²). Frequencies are Bendt clearness-index screening shares — how often a day of at least that quality shows up, not a forecast.
            </div>
            <div style={{ marginTop: 10, borderTop: '1px solid #1e1e35', paddingTop: 8 }}>
              <div style={{ fontSize: 8, color: '#555', letterSpacing: 1, marginBottom: 5, display: 'flex', alignItems: 'center' }}>
                PVSYST MONTHLY RADIATION<Info text="PVSyst monthly values for the site. Aug–Nov (highlighted) are the audited report months; annual: GlobHor 1811.3, GlobInc 1840.2 kWh/m², PR 0.850, 101,717 MWh." />
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 8.5 }}>
                <thead><tr>
                  {['MONTH', 'GLOBHOR', 'GLOBINC', 'GLOBEFF', 'TAMB', 'KT', 'PR'].map((h, i) => (
                    <th key={h} style={{ ...thS, position: 'static', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {PVSYST_MONTHLY.map((r) => {
                    const rep = PVSYST_REPORT_MONTHS.includes(r.mo);
                    return (
                      <tr key={r.mo} style={{ background: rep ? '#141426' : 'transparent' }}>
                        <td style={{ ...tdS, fontWeight: rep ? 800 : 400, color: rep ? '#f5a623' : '#777' }}>{r.mo}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: rep ? '#bbb' : '#666' }}>{r.globHor.toFixed(1)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: rep ? '#bbb' : '#666' }}>{r.globInc.toFixed(1)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: rep ? '#bbb' : '#666' }}>{r.globEff.toFixed(1)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: '#666' }}>{r.tamb.toFixed(2)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: '#666' }}>{r.kt.toFixed(2)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: '#666' }}>{r.pr.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* park hierarchy + MVPS5 dependency */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>PARK ELECTRICAL HIERARCHY</span>
              <Info text="Live status by level: 9 MVPS blocks → 56 SG1100UD inverters → 234 SCBs → 3,524 strings. Click any row to expand. An inverter is 'startable' when at least one mounted string sits behind an approved SCB; 'no SCB' has mounted strings but none approved; 'dark' has no mounted strings. ER3 requires all 56 started." />
              <span style={{ fontSize: 8, color: '#444' }}>MVPS → inverter → SCB → strings · live data</span>
            </div>
            <ParkTree park={park} />
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, color: '#666', letterSpacing: 1 }}>MVPS5 DEPENDENCY</span>
              <Info text="The dark inverters are all in MVPS5. Their strings are the park's last reserve: once the required DC exceeds what the rest of the park can hold, every extra string must be mounted inside them. Independently, ER3 needs ≥1 string in each just to start it (voltage condition: one string = 1,083 V at 60 °C ≥ 905 V start-up)." />
            </div>
            {park.darkInvs.length === 0 ? (
              <div style={{ fontSize: 10, color: '#4ade80' }}>No dark inverters — every SG1100UD already has mounted strings.</div>
            ) : (<>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                {park.darkInvs.map((i) => (
                  <span key={i.key} style={{ fontSize: 9, fontFamily: 'monospace', background: '#241212', color: '#ef4444', border: '1px solid #ef444444', borderRadius: 3, padding: '2px 7px' }}>
                    MVPS{i.mv}-{i.letter} · {i.total} str
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 9, color: '#888', lineHeight: 1.6, marginBottom: 8 }}>
                {park.darkInvs.length} <b style={{ color: '#ef4444' }}>dark</b> inverters (no strings mounted yet, cannot energise) hold <b style={{ color: '#ddd' }}>{park.darkStrings} strings = {(park.darkStrings * STRING_KWP / 1000).toFixed(2)} MWdc</b>.
                Rest of the park caps at <b style={{ color: '#ddd' }}>{((TOTAL_STRINGS - park.darkStrings) * STRING_KWP / 1000).toFixed(2)} MWdc</b>.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
                <thead><tr>
                  <th style={{ ...thS, textAlign: 'left' }}>DATE</th>
                  <th style={{ ...thS, textAlign: 'right' }}>DC REQUIRED</th>
                  <th style={{ ...thS, textAlign: 'right' }}>FORCED IN</th>
                  <th style={{ ...thS, textAlign: 'right' }}>+ER3 MIN</th>
                </tr></thead>
                <tbody>
                  {Array.from({ length: 8 }, (_, k) => new Date(2026, 8 + ((k + 1) >> 1), (k % 2) ? 1 : 15, 12)).map((d, k) => {
                    const req = reqCache.get(dayKey(d)) ?? dcRequired(d, env, exec.targetMW);
                    const forced = req > TOTAL_MWDC ? null : forcedIntoDark(req, park.darkStrings);
                    const er3min = Math.max(forced ?? 0, park.darkInvs.length);
                    return (
                      <tr key={k}>
                        <td style={{ ...tdS, color: '#999' }}>{fmtDY(d)}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: req > TOTAL_MWDC ? '#ef4444' : '#888' }}>{req > TOTAL_MWDC ? '✕ not feasible' : req.toFixed(1)}</td>
                        <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: forced === null ? '#ef4444' : forced > 0 ? '#f5a623' : '#4ade80' }}>{forced === null ? '—' : forced > 0 ? `${forced} str` : '0'}</td>
                        <td style={{ ...tdS, textAlign: 'right', color: '#888' }}>{forced === null ? '—' : `${er3min} str`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ fontSize: 8, color: '#555', marginTop: 6, lineHeight: 1.5 }}>
                “Forced in”: strings that must be mounted inside the dark inverters for the required DC to fit in the park.
                “+ER3 min”: at least one string per dark inverter is needed anyway to start it for the reactive-capability check.
              </div>
            </>)}
          </div>
        </div>

        <div style={{ fontSize: 8, color: '#3d3d55', lineHeight: 1.6, paddingBottom: 8 }}>
          Model: audited clear-sky (Haurwitz) minimum-DC study · k(t) = 0.9165-chain (soiling & bifacial adjustable) × POA/1000 × (1 − 0.0029·(Tcell−25)) · peak reach criterion, 09–17 h solar ·
          Bendt clearness screening (γ 1.98 Sep / 1.26 Oct) · live progress from the tracker read-only endpoints. Read-only — nothing is written back.
        </div>

        {tip && (
          <div style={{ position: 'fixed', left: Math.min(tip.x + 14, window.innerWidth - 330), top: Math.min(tip.y + 16, window.innerHeight - 150), width: 300, background: '#1a1a2e', border: '1px solid #3a3a55', borderRadius: 6, padding: '9px 11px', fontSize: 10, color: '#bbb', lineHeight: 1.55, zIndex: 1000, pointerEvents: 'none', boxShadow: '0 6px 24px rgba(0,0,0,0.5)' }}>
            {tip.text}
          </div>
        )}
      </div>
    </TipCtx.Provider>
  );
}
