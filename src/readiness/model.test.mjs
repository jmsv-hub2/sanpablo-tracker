// Sanity checks from the audited report. Run: node src/readiness/model.test.mjs
import {
  DEFAULT_ENV, SCENARIOS, kPeak, dcRequired, bendtFreq,
  projectTables, findCrossing, addDays, dayKey, TOTAL_MWDC, forcedIntoDark,
} from './model.js';

let fails = 0;
const check = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got.toFixed(4)}, want ${want} ±${tol}`);
};

const env = { ...DEFAULT_ENV };
const sep30 = new Date(2026, 8, 30, 12);
const oct31 = new Date(2026, 9, 31, 12);

const pSep = kPeak(sep30, env);
check('30 Sep POA W/m²', pSep.poa, 1001, 3);
check('30 Sep Tcell °C', pSep.tcell, 59.9, 1.0);
check('30 Sep k', pSep.k, 0.824, 0.0015);
check('30 Sep DC for 50 MWac', 50 / pSep.k, 60.7, 0.15);
check('30 Sep DC for 25 MWac', 25 / pSep.k, 30.3, 0.1);

const pOct = kPeak(oct31, env);
check('31 Oct POA W/m²', pOct.poa, 929, 3);
check('31 Oct Tcell °C', pOct.tcell, 56.9, 1.0);
check('31 Oct k', pOct.k, 0.773, 0.002);
check('31 Oct DC for 50 MWac', 50 / pOct.k, 64.7, 0.2);

// Bendt screening frequencies (report: sep 11/15/21/27 %, oct 9/12/18/23 %).
for (const [sc, sepW, octW] of [
  ['exceptional', 0.11, 0.09], ['plausible', 0.15, 0.12],
  ['conservative', 0.21, 0.18], ['adverse', 0.27, 0.23],
]) {
  const s = SCENARIOS.find((x) => x.key === sc);
  check(`Bendt Sep ${sc}`, bendtFreq(9, s.poaMult), sepW, 0.011);
  check(`Bendt Oct ${sc}`, bendtFreq(10, s.poaMult), octW, 0.011);
}

// Projection: 24 tables/day, 6-day weeks, from 2554 → 3524 needs 41 workdays.
const start = new Date(2026, 7, 29, 12); // Sat 29 Aug 2026
const proj = projectTables(start, addDays(start, 60), 2554, 24, 6);
const full = [...proj.entries()].find(([, v]) => v >= 3524);
console.log('projection reaches 3524 on', full?.[0], '(expect 15 Oct: ceil(970/24)=41 workdays, 7 Sundays skipped)');
if (!full || full[0] !== '2026-10-15') { fails++; console.log('FAIL projection date'); }

// Crossing: at 24/day from today under Plausible, DC required ~60.7–61 in
// late Sep–early Oct; 2554 + rate·d ≥ req → expect a crossing in Sep/Oct.
const cache = new Map();
const cross = findCrossing(start, addDays(start, 300), 2554, 24, 6, env, 50, cache);
console.log('crossing at 24/day:', cross ? `${dayKey(cross.date)} req ${cross.dcReq.toFixed(2)} proj ${cross.dcProj.toFixed(2)}` : 'none');
if (!cross) { fails++; console.log('FAIL no crossing'); }

// Adverse in December must be impossible (> 65.018 MWdc).
const adverse = { ...env, poaMult: 0.92, tambOff: 3, soiling: 0.02 };
const dec21 = dcRequired(new Date(2026, 11, 21, 12), adverse, 50);
console.log(`Adverse 21 Dec DC required: ${dec21.toFixed(1)} MWdc (cap ${TOTAL_MWDC.toFixed(2)}) → ${dec21 > TOTAL_MWDC ? 'not feasible ✓' : 'FEASIBLE?'}`);
if (dec21 <= TOTAL_MWDC) fails++;

// MVPS5 forcing: with 244 dark strings, park-outside = 60.52 MWdc; requiring
// 61.5 MWdc forces ~54 strings in.
check('forcedIntoDark(61.5, 244)', forcedIntoDark(61.5, 244), Math.ceil(61.5 * 1000 / 18.45) - 3280, 0);
check('forcedIntoDark(60.0, 244)', forcedIntoDark(60.0, 244), 0, 0);

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
