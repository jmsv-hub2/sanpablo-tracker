// ── Readiness engine (pure, no React) ───────────────────────────────────────
// Implements the closed & externally-audited DC-capacity model for the
// San Pablo 50 MWac ER3 demonstration. Validated against the report's sanity
// checks in model.test.mjs — do not change constants without re-running it.

const D2R = Math.PI / 180;

export const LAT = 17.47;
export const TILT = 9.1;
// PVSyst azimuth 11.6° (0 = south). East-negative in our solar-azimuth
// convention: this sign reproduces the report's 30-Sep k = 0.824 exactly.
export const ARRAY_AZ = -11.6;
export const ALBEDO = 0.17;
export const STRING_KWP = 30 * 0.615; // 18.45 kWp
export const TOTAL_STRINGS = 3524;
export const TOTAL_MWDC = TOTAL_STRINGS * STRING_KWP / 1000; // 65.018
export const GAMMA = 0.0029; // Pmax temperature coefficient, 1/°C

// Loss chain: IAM/shade 0.995 · soiling 0.990 · bifacial 1.020 · LID 0.990 ·
// mismatch 0.981 · DC wiring 0.982 · inverter 0.985 · aux+MV+HV 0.971.
export const BASE = 0.995 * 0.990 * 1.020 * 0.990 * 0.981 * 0.982 * 0.985 * 0.971; // 0.91649
// Core with soiling and bifacial stripped out so both stay adjustable.
const BASE_CORE = BASE / 0.990 / 1.020;

// PVSyst 24-h monthly ambient means (°C).
export const TAMB_MONTH = { 1: 24.00, 2: 25.10, 3: 26.47, 4: 28.64, 5: 30.07, 6: 29.59, 7: 28.48, 8: 27.94, 9: 27.99, 10: 27.10, 11: 26.06, 12: 24.39 };

// PVSyst monthly radiation (kWh/m²) + Tamb + clearness + PR.
export const PVSYST_MONTHLY = [
  { mo: 'Jan', globHor: 129.8, globInc: 143.0, globEff: 139.4, tamb: 24.00, kt: 0.46, pr: 0.858 },
  { mo: 'Feb', globHor: 141.5, globInc: 151.0, globEff: 147.3, tamb: 25.10, kt: 0.49, pr: 0.855 },
  { mo: 'Mar', globHor: 178.2, globInc: 184.0, globEff: 179.7, tamb: 26.47, kt: 0.52, pr: 0.851 },
  { mo: 'Apr', globHor: 185.9, globInc: 184.0, globEff: 179.6, tamb: 28.64, kt: 0.52, pr: 0.841 },
  { mo: 'May', globHor: 183.7, globInc: 177.0, globEff: 172.6, tamb: 30.07, kt: 0.50, pr: 0.836 },
  { mo: 'Jun', globHor: 170.5, globInc: 163.0, globEff: 158.7, tamb: 29.59, kt: 0.48, pr: 0.842 },
  { mo: 'Jul', globHor: 167.1, globInc: 161.0, globEff: 157.0, tamb: 28.48, kt: 0.47, pr: 0.844 },
  { mo: 'Aug', globHor: 163.6, globInc: 162.0, globEff: 158.0, tamb: 27.94, kt: 0.50, pr: 0.822 },
  { mo: 'Sep', globHor: 151.5, globInc: 154.0, globEff: 150.1, tamb: 27.99, kt: 0.50, pr: 0.856 },
  { mo: 'Oct', globHor: 131.3, globInc: 138.0, globEff: 134.2, tamb: 27.10, kt: 0.47, pr: 0.827 },
  { mo: 'Nov', globHor: 105.3, globInc: 114.0, globEff: 110.6, tamb: 26.06, kt: 0.44, pr: 0.821 },
  { mo: 'Dec', globHor: 102.9, globInc: 109.2, globEff: 106.0, tamb: 24.39, kt: 0.43, pr: 0.847 },
];
// Only Aug–Nov of PVSYST_MONTHLY come straight from the audited report table;
// the rest are display-only PVSyst values (annual: GlobHor 1811.3, GlobInc 1840.2, PR 0.850).
export const PVSYST_REPORT_MONTHS = ['Aug', 'Sep', 'Oct', 'Nov'];

// Weather scenarios: POA multiplier, ambient offset, soiling fraction.
export const SCENARIOS = [
  { key: 'exceptional', label: 'Exceptional', poaMult: 1.02, tambOff: -2, soiling: 0.005, color: '#4ade80' },
  { key: 'plausible', label: 'Plausible', poaMult: 1.00, tambOff: 0, soiling: 0.010, color: '#818cf8' },
  { key: 'conservative', label: 'Conservative', poaMult: 0.96, tambOff: 2, soiling: 0.015, color: '#f5a623' },
  { key: 'adverse', label: 'Adverse', poaMult: 0.92, tambOff: 3, soiling: 0.020, color: '#ef4444' },
];

export const DEFAULT_ENV = {
  scenario: 'plausible',
  poaMult: 1.00,
  tambOff: 0,
  soiling: 0.010,
  atten: 0,        // extra atmospheric attenuation on Haurwitz (upper bound), 0–0.10
  rise: 28.5,      // cell temperature rise at 1000 W/m², °C (24–32)
  bifacial: 0.020, // bifacial gain (0.01–0.03)
};

// ── Solar geometry ──────────────────────────────────────────────────────────

export function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400e3);
}

export function declination(n) {
  return 23.45 * Math.sin(D2R * 360 * (284 + n) / 365);
}

// Solar position at solar time t (hours). Azimuth in PVSyst convention
// (0 = south, west positive), elevation in degrees.
export function solarPos(n, t) {
  const dec = declination(n);
  const H = 15 * (t - 12);
  const cosz = Math.sin(LAT * D2R) * Math.sin(dec * D2R) + Math.cos(LAT * D2R) * Math.cos(dec * D2R) * Math.cos(H * D2R);
  const clamped = Math.min(1, Math.max(-1, cosz));
  const z = Math.acos(clamped);
  let az = 0;
  if (z > 1e-9) {
    const sinAz = Math.cos(dec * D2R) * Math.sin(H * D2R) / Math.sin(z);
    az = Math.asin(Math.min(1, Math.max(-1, sinAz))) / D2R;
    const cosAz = (clamped * Math.sin(LAT * D2R) - Math.sin(dec * D2R)) / (Math.sin(z) * Math.cos(LAT * D2R));
    if (cosAz < 0) az = az >= 0 ? 180 - az : -180 - az;
  }
  return { cosz: clamped, z, az, elev: 90 - z / D2R, dec };
}

// ── Irradiance & conversion factor ──────────────────────────────────────────

// Instant evaluation at solar time t for date. Returns null when the sun is down.
export function instant(date, t, env) {
  const n = dayOfYear(date);
  const { cosz, z, az } = solarPos(n, t);
  if (cosz <= 0.001) return null;
  // Haurwitz clear-sky — the leading cos(z) IS part of the relation.
  let ghi = 1098 * cosz * Math.exp(-0.059 / cosz);
  ghi *= 1 - env.atten;
  const dhi = 0.12 * ghi;
  const dni = (ghi - dhi) / cosz;
  const cosAOI = cosz * Math.cos(TILT * D2R) + Math.sin(z) * Math.sin(TILT * D2R) * Math.cos((az - ARRAY_AZ) * D2R);
  let poa = dni * Math.max(0, cosAOI) + dhi * (1 + Math.cos(TILT * D2R)) / 2 + ghi * ALBEDO * (1 - Math.cos(TILT * D2R)) / 2;
  poa *= env.poaMult;
  const mo = date.getMonth() + 1;
  const tamb = TAMB_MONTH[mo] + env.tambOff + 4.5 * Math.sin(D2R * 15 * (t - 8));
  const tcell = tamb + env.rise * poa / 1000;
  // k already contains the irradiance ratio: required DC = target / k.
  const k = BASE_CORE * (1 + env.bifacial) * (1 - env.soiling) * (poa / 1000) * (1 - GAMMA * (tcell - 25));
  return { poa, ghi, tamb, tcell, k };
}

// Peak conversion factor over the day (reaching the peak is enough — it does
// not need to be sustained). 09:00–17:00 solar, 1-minute steps.
export function kPeak(date, env) {
  let best = null;
  for (let m = 9 * 60; m <= 17 * 60; m++) {
    const p = instant(date, m / 60, env);
    if (p && (!best || p.k > best.k)) best = { ...p, t: m / 60 };
  }
  return best; // {t, poa, tcell, tamb, k}
}

export function dcRequired(date, env, targetMW) {
  const p = kPeak(date, env);
  return p ? targetMW / p.k : Infinity;
}

// Minutes per day the plant output would sit at or above targetMW given
// dcInstalled MWdc (06:00–18:00 solar, 1-minute steps).
export function minutesAbove(date, env, dcInstalled, targetMW) {
  let mins = 0;
  for (let m = 6 * 60; m <= 18 * 60; m++) {
    const p = instant(date, m / 60, env);
    if (p && dcInstalled * p.k >= targetMW) mins++;
  }
  return mins;
}

// ── Bendt daily clearness-index screening frequencies ───────────────────────
// P(daily Kt ≥ 0.72 × poaMult) under a Bendt distribution on [0.05, 0.78]
// with shape 1.98 (Sep) / 1.26 (Oct). Screening probabilities, not proven
// weather probabilities.
const BENDT = { 9: 1.98, 10: 1.26 };
const KT_MIN = 0.05, KT_MAX = 0.78;

export function bendtFreq(month, poaMult) {
  const g = BENDT[month];
  if (!g) return null;
  const kt = Math.min(0.72 * poaMult, KT_MAX);
  const F = (Math.exp(g * KT_MIN) - Math.exp(g * kt)) / (Math.exp(g * KT_MIN) - Math.exp(g * KT_MAX));
  return Math.max(0, 1 - F);
}

// ── Mounting projection ─────────────────────────────────────────────────────

export function isWorkday(date, workdays) {
  const d = date.getDay();
  if (workdays >= 7) return true;
  if (workdays === 6) return d !== 0;            // Sundays off
  if (workdays === 5) return d !== 0 && d !== 6; // weekends off
  return d >= 1 && d <= workdays;
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  d.setDate(d.getDate() + n);
  return d;
}

export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Tables mounted by end of each day from startDate (inclusive) to endDate.
// Returns Map(dayKey → tables). Work happens during the day: a workday's
// output counts on that same date.
export function projectTables(startDate, endDate, startTables, ratePerDay, workdays) {
  const out = new Map();
  let tables = startTables;
  for (let d = addDays(startDate, 0); d <= endDate; d = addDays(d, 1)) {
    if (d >= startDate && isWorkday(d, workdays)) tables = Math.min(TOTAL_STRINGS, tables + ratePerDay);
    out.set(dayKey(d), tables);
  }
  return out;
}

// First date (searching startDate → endDate) where projected DC ≥ required DC
// for that same date. Returns {date, dcReq, dcProj} or null when never reached.
export function findCrossing(startDate, endDate, startTables, ratePerDay, workdays, env, targetMW, reqCache) {
  const proj = projectTables(startDate, endDate, startTables, ratePerDay, workdays);
  for (let d = addDays(startDate, 0); d <= endDate; d = addDays(d, 1)) {
    const key = dayKey(d);
    let req = reqCache?.get(key);
    if (req === undefined) {
      req = dcRequired(d, env, targetMW);
      reqCache?.set(key, req);
    }
    if (req > TOTAL_MWDC) continue; // physically not demonstrable that day
    const dc = (proj.get(key) || 0) * STRING_KWP / 1000;
    if (dc >= req) return { date: d, dcReq: req, dcProj: dc };
  }
  return null;
}

// ── Live park model (from the two read-only endpoints) ──────────────────────
// scbStatus: 0 not started · 1 pending inspection · 3 approved · 2 fully wired.
export const SCB_STATUS_LABELS = {
  0: { label: 'Not started', color: '#555' },
  1: { label: 'Pending inspection', color: '#f5c518' },
  3: { label: 'Approved', color: '#4ade80' },
  2: { label: 'Fully wired', color: '#22d3ee' },
};

export function buildPark(TABLES, phases, scbStatus) {
  const scbs = {};
  TABLES.forEach((t) => {
    if (!t.scb) return;
    const m = t.scb.match(/^(\d+)([A-Z])/);
    if (!m) return;
    const s = scbs[t.scb] || (scbs[t.scb] = {
      id: t.scb, mv: +m[1], letter: m[2], inv: m[1] + m[2],
      total: 0, mounted: 0, tables: [],
    });
    s.total++;
    const ph = phases?.[t.id] || 0;
    const isMounted = ph >= 5;
    if (isMounted) s.mounted++;
    s.tables.push({ id: t.id, mounted: isMounted });
  });
  const scbList = Object.values(scbs).sort((a, b) => a.id.localeCompare(b.id));
  scbList.forEach((s) => { s.wiring = scbStatus?.[s.id] || 0; });

  const invs = {};
  scbList.forEach((s) => {
    const inv = invs[s.inv] || (invs[s.inv] = {
      key: s.inv, mv: s.mv, letter: s.letter, scbs: [], total: 0, mounted: 0, mountedApproved: 0,
    });
    inv.scbs.push(s);
    inv.total += s.total;
    inv.mounted += s.mounted;
    if (s.wiring === 3 || s.wiring === 2) inv.mountedApproved += s.mounted;
  });
  const invList = Object.values(invs).sort((a, b) => a.mv - b.mv || a.letter.localeCompare(b.letter));
  invList.forEach((inv) => {
    // A single 30-module string starts an SG1100UD (1,083 V at 60 °C ≥ 905 V
    // start-up) — but only through an approved/wired SCB.
    inv.status = inv.mountedApproved > 0 ? 'started' : inv.mounted > 0 ? 'noscb' : 'dark';
  });

  const mvps = {};
  for (let z = 1; z <= 9; z++) mvps[z] = { mv: z, invs: [], total: 0, mounted: 0 };
  invList.forEach((inv) => {
    const m = mvps[inv.mv];
    m.invs.push(inv); m.total += inv.total; m.mounted += inv.mounted;
  });

  const mountedTables = TABLES.reduce((a, t) => a + ((phases?.[t.id] || 0) >= 5 ? 1 : 0), 0);
  const darkInvs = invList.filter((i) => i.status === 'dark');
  return {
    scbList, invList, mvps, mountedTables,
    mountedMW: mountedTables * STRING_KWP / 1000,
    startedInvs: invList.filter((i) => i.status === 'started').length,
    noScbInvs: invList.filter((i) => i.status === 'noscb').length,
    darkInvs,
    darkStrings: darkInvs.reduce((a, i) => a + i.total, 0),
  };
}

// Strings a given required DC forces into the currently-dark inverters
// (independent of the ≥1-string-per-inverter ER3 start-up need).
export function forcedIntoDark(dcReq, darkStrings) {
  const needed = Math.ceil(dcReq * 1000 / STRING_KWP - 1e-9);
  const outside = TOTAL_STRINGS - darkStrings;
  return Math.max(0, needed - outside);
}
