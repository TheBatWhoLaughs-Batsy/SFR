// Detection benchmark: drives the SHIPPED lib/sarDetect.js over a labelled corpus of
// saved C-scan exports and scores it against the operator's tape measure.
//
//   npm run bench                      -- the default set, every reference mode
//   npm run bench -- --dir "D:/scans"  -- corpus elsewhere
//   npm run bench -- --only 3pipe --ref "empty.json"
//   npm run bench -- --set sfr-2026-09-20 --json out.json
//   npm run bench -- --opt confirmedProminenceDb=6 --opt refMatchMarginDb=7
//   npm run bench -- --sweep confirmedProminenceDb=4,6,8,10
//
// WHY THIS EXISTS. Every threshold in DETECT_DEFAULTS was fitted on one evening's scans
// at rx1_gain 25, which is now known to have been compressed (2026-09-19: rx1 12 is
// +8-10 dB of S_repeat). A detector whose gates are stated in dB over a clutter median
// cannot survive a 10 dB change in the clutter without being re-measured, and this repo
// has no test runner, so every check so far has been a throwaway script that measured a
// copy of the code and then vanished. This one is committed, drives the real functions
// and prints numbers that can be compared between runs.
//
// The scans themselves are NOT committed (9 MB each, and `data/` is gitignored): the
// corpus names files and ground truth, `--dir` says where they live.
//
// WHAT IS SCORED. Per scan and per reference mode:
//   recall        labelled pipes matched by a detection rated confirmed or probable
//   vetoed        labelled pipes whose only detection was cancelled by the empty
//                 reference -- the control eating a real target
//   false alarms  rated detections matching no labelled pipe. An empty scan scored
//                 against the other empty is the cleanest false-alarm measurement there
//                 is: every detection in it is false by construction.
//   bias          median (detected x - labelled x); the 2026-09-14 set read +1 cm and
//                 nobody knows whether that is the detector or where column 0 was set.
// A detection inside `endExcludeCm` of either end is reported as [edge]; --handle-ends
// applies effectiveRating, which the UI does, and demotes those to `unresolved`.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  planDetection, reconstructRowVariants, emptyReferenceLines, emptyReferenceKey,
  finishDetection, projectRowsForDetect, effectiveRating, DETECT_DEFAULTS,
} from '../src/lib/sarDetect.js';

// ---- args -------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const multi = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const HERE = import.meta.dirname;
const corpus = JSON.parse(readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
const setId = opt('set');
const set = setId ? corpus.sets.find((s) => s.id === setId) : corpus.sets[0];
if (!set) { console.error(`no such set: ${setId}`); process.exit(2); }

const expand = (p) => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
const dir = expand(opt('dir') || process.env.BENCH_DIR || set.dir);
const only = opt('only');
const tolCm = Number(opt('tol', set.toleranceCm ?? 4));
const handleEnds = flag('handle-ends');
const quiet = flag('quiet');

const overrides = {};
for (const kv of multi('opt')) {
  const [k, v] = kv.split('=');
  if (!(k in DETECT_DEFAULTS)) { console.error(`unknown detector option: ${k}`); process.exit(2); }
  overrides[k] = typeof DETECT_DEFAULTS[k] === 'string' ? v : Number(v);
}
const sweepArg = opt('sweep');

const params = {
  stepSize: null,               // filled per scan from its own grid params
  vStep: null,
  startFreq: set.geometry.startFreqMHz ?? 2000,
  // --er / --wall override the corpus geometry, for sweeping the wall's own constants
  epsilonR: Number(opt('er', set.geometry.epsilonR)),
  wallThickness: Number(opt('wall', set.geometry.wallThicknessCm)),
  refraction: true,
  autoStandoff: true,
  manualStandoffMm: 0,
};

// ---- load -------------------------------------------------------------------------
// Rail coordinate of column 0, in cm, from the rover's reported position. Fitted over
// every cell (x = a + hStep * grid_ix) rather than read off one cell, so a single stray
// position cannot move it; the fit residual is reported as a sanity check.
function railOriginCm(data, hStep) {
  const pts = data.filter((p) => Number.isFinite(p.rover_x_mm) && Number.isFinite(p.grid_ix));
  if (pts.length < 2) return NaN;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.grid_ix, 0) / n;
  const sy = pts.reduce((a, p) => a + p.rover_x_mm, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.grid_ix - sx) * (p.rover_x_mm - sy); den += (p.grid_ix - sx) ** 2; }
  const slope = den ? num / den : hStep * 10;
  const intercept = sy - slope * sx;
  return intercept / 10;
}

// --only selects what is SCORED; the empties are always loaded, since they are the
// reference modes.
const selected = (s) => !only || s.role === 'empty' || s.file.toLowerCase().includes(only.toLowerCase());
const scans = set.scans
  .filter(selected)
  .map((s) => {
    const file = path.join(dir, s.file);
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }
    const rows = projectRowsForDetect(doc.data);
    if (!rows.length) { console.error(`${s.file}: no usable rows`); process.exit(2); }
    const hStep = doc.params?.hStep ?? 1;
    // Where this raster's column 0 sat on the rail, from the rover's own odometer. The
    // operator jogs to the start by hand, so it moves between scans; everything cross-scan
    // (the labels, and the empty reference) has to go through it.
    const railX0Cm = railOriginCm(doc.data, hStep);
    const tapeZero = set.tapeZeroRailCm?.[s.frame];
    const shift = Number.isFinite(railX0Cm) && Number.isFinite(tapeZero) ? tapeZero - railX0Cm : 0;
    return {
      ...s, doc, rows, hStep, railX0Cm, labelShiftCm: shift,
      // labels are on the wall; these are the columns they should land in
      pipesLocal: (s.pipes || []).map((p) => p + shift),
      knownLocal: (set.knownFeatures || []).map((k) => ({ ...k, local: k.x + shift })),
      scored: !only || s.file.toLowerCase().includes(only.toLowerCase()),
      vStep: doc.params?.vStep ?? 1,
      cells: doc.data.length,
      sfcw: doc.sfcwParams || {},
    };
  });
const empties = scans.filter((s) => s.role === 'empty');
const targets = scans.filter((s) => s.role !== 'empty');
if (!scans.length) { console.error('no scans selected'); process.exit(2); }

// ---- reconstruct once per scan, score many times -----------------------------------
// rowResults and the reference lines do not depend on the thresholds, so a threshold
// sweep is finishDetection() only -- seconds instead of minutes.
const t0 = Date.now();
const planOf = (scan, options) => planDetection(scan.rows, { ...params, stepSize: scan.hStep, vStep: scan.vStep }, options);

// Options that change the RECONSTRUCTION rather than only the scoring; a sweep over one of
// these has to redo the reconstructions, a sweep over any other threshold does not.
const RECON_OPTS = ['baseClutter', 'svdK', 'svdAdaptive', 'svdSpreadFrac', 'apertureNormalize', 'apertureAngleDeg', 'searchMinDepthCm', 'searchMaxDepthCm', 'guardedWindowCm', 'guardedGuardCm', 'guardedAlpha', 'trimCm'];
const reconKey = (options) => JSON.stringify(RECON_OPTS.map((k) => options[k] ?? DETECT_DEFAULTS[k]));

function reconstruct(scan, options) {
  const key = reconKey(options);
  if (scan._rowResults && scan._reconKey === key) return scan;
  if (scan._reconKey && scan._reconKey !== key) refLineCache.clear();
  scan._reconKey = key;
  const plan = planOf(scan, options);
  scan._plan = plan;
  scan._rowResults = scan.rows.map((r) => ({ iy: r.iy, grids: reconstructRowVariants(plan, r.cells) }));
  scan._baseGrids = scan.rows.map((r, i) => ({ iy: r.iy, G: scan._rowResults[i].grids.base }));
  if (!quiet) process.stderr.write(`  reconstructed ${scan.file} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  return scan;
}

// An empty scan's reference lines are reconstructed onto the TARGET's grid, so they are
// valid for any target sharing that grid and plan -- which every scan of one set does.
const refLineCache = new Map();
function referenceLines(plan, empty, options) {
  const key = `${empty.file}|${emptyReferenceKey(plan)}`;
  if (!refLineCache.has(key)) {
    reconstruct(empty, options);
    refLineCache.set(key, emptyReferenceLines(plan, empty._baseGrids));
  }
  return refLineCache.get(key);
}

const RATED = new Set(['confirmed', 'probable']);
const PRESENT_DB = 5;   // a detection this prominent is energy at that place, whatever it was rated

function score(scan, refFile, options) {
  const plan = scan._plan;
  plan.o = { ...DETECT_DEFAULTS, ...options };   // scoring thresholds, re-read per run
  const empty = refFile ? empties.find((e) => e.file === refFile) : null;
  const lines = empty ? referenceLines(plan, empty, options) : [];
  const det = finishDetection(plan, scan._rowResults, lines, !!empty);
  const dets = det.targets.map((t) => ({ ...t, rating: effectiveRating(t, handleEnds) }));

  // greedy assignment, cheapest |dx| first, rated detections only
  const rated = dets.filter((d) => RATED.has(d.rating));
  const pairs = [];
  scan.pipesLocal.forEach((px, pi) => rated.forEach((d, di) => {
    const dx = d.x - px;
    if (Math.abs(dx) <= tolCm) pairs.push({ pi, di, dx, cost: Math.abs(dx) });
  }));
  pairs.sort((a, b) => a.cost - b.cost);
  const usedP = new Set(), usedD = new Set(), matched = [];
  for (const p of pairs) {
    if (usedP.has(p.pi) || usedD.has(p.di)) continue;
    usedP.add(p.pi); usedD.add(p.di);
    matched.push({ pipe: scan.pipes[p.pi], local: scan.pipesLocal[p.pi], det: rated[p.di], dx: p.dx });
  }
  // A miss is worth splitting in two: the detector may have found the target and refused to
  // rate it (a threshold problem, recoverable) or there may be nothing there at all (a
  // sensing problem). `nearest` is the most prominent unrated detection within tolerance.
  const missed = scan.pipes.map((p, pi) => ({ p, pi })).filter(({ pi }) => !usedP.has(pi)).map(({ p, pi }) => {
    const near = dets.filter((d) => !RATED.has(d.rating) && Math.abs(d.x - scan.pipesLocal[pi]) <= tolCm)
      .sort((a, b) => b.prominenceDb - a.prominenceDb);
    return { pipe: p, local: scan.pipesLocal[pi], nearest: near[0] || null, present: !!(near[0] && near[0].prominenceDb >= PRESENT_DB) };
  });
  // A rated detection on a known wall feature is neither a hit nor a false alarm. The
  // 36 cm defect is real and every scan images it; counting it as a false alarm would
  // reward a detector for going blind.
  const rest = rated.filter((d, di) => !usedD.has(di));
  const known = rest.filter((d) => scan.knownLocal.some((k) => Math.abs(d.x - k.local) <= tolCm));
  const falseAlarms = rest.filter((d) => !known.includes(d));
  return { det, dets, matched, missed, known, falseAlarms };
}

// ---- report -----------------------------------------------------------------------
const fmt = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '--');
const tag = (d) => `${d.rating}${d.edge ? ' [edge]' : ''}`;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);

function report(options, label) {
  const refModes = flag('no-ref') ? [null] : [
    ...(opt('ref') ? [opt('ref')] : empties.map((e) => e.file)),
    ...(flag('ref-only') ? [] : [null]),
  ];
  const rows = [];
  console.log(`\n=== ${set.id}${label ? `  ${label}` : ''} ===`);
  console.log(`dir ${dir}\ntolerance ${tolCm} cm   ends ${handleEnds ? 'handled (effectiveRating)' : 'raw ratings'}`);

  for (const refFile of refModes) {
    console.log(`\n--- reference: ${refFile || 'NONE'} ---`);
    let hit = 0, tot = 0, fa = 0, faBehind = 0, vetoed = 0, present = 0, kn = 0, knPossible = 0;
    const dxs = [];
    for (const scan of scans) {
      if (!scan.scored) continue;
      if (scan.role === 'empty' && refFile === scan.file) continue;     // cannot be its own control
      reconstruct(scan, options);
      const r = score(scan, refFile, options);
      tot += scan.pipes.length;
      hit += r.matched.length;
      fa += r.falseAlarms.length;
      faBehind += r.falseAlarms.filter((d) => d.behindWall).length;
      vetoed += r.missed.filter((m) => m.nearest && m.nearest.rating === 'reference').length;
      present += r.missed.filter((m) => m.present).length;
      kn += r.known.length; knPossible += scan.knownLocal.length;
      r.matched.forEach((m) => dxs.push(m.dx));
      rows.push({ scan: scan.file, ref: refFile, ...r });

      const hits = r.matched.sort((a, b) => a.pipe - b.pipe).map((m) =>
        `${fmt(m.pipe)}cm@col${fmt(m.local)} -> ${fmt(m.det.x)} (${m.dx >= 0 ? '+' : ''}${fmt(m.dx)}, z${fmt(m.det.depth)}, ${fmt(m.det.prominenceDb)}dB, ${m.det.testsPassed}/6, ${tag(m.det)})`);
      const miss = r.missed.map((m) => `${fmt(m.pipe)}cm@col${fmt(m.local)} ${m.present ? 'UNRATED' : 'MISS'}${m.nearest ? ` (${fmt(m.nearest.x)}, ${fmt(m.nearest.prominenceDb)}dB, ${m.nearest.testsPassed}/6, ${tag(m.nearest)}${m.nearest.sidelobeOf != null ? ` sidelobe-of-${fmt(m.nearest.sidelobeOf)}` : ''})` : ' (nothing within tol)'}`);
      const fps = r.falseAlarms.map((d) => `x${fmt(d.x)} z${fmt(d.depth)} (${d.behindWall ? 'behind wall' : `IN WALL ${fmt(d.depthBelowWallCm)}`}) ${fmt(d.prominenceDb)}dB ${d.testsPassed}/6 ${tag(d)}`);
      const kns = r.known.map((d) => `x${fmt(d.x)} z${fmt(d.depth)} ${fmt(d.prominenceDb)}dB ${d.testsPassed}/6 ${tag(d)}`);
      console.log(`${scan.file.padEnd(30)} ${String(r.matched.length)}/${scan.pipes.length} hit, ${r.known.length}/${scan.knownLocal.length} known, ${r.falseAlarms.length} false`);
      if (hits.length) console.log(`    hit   ${hits.join('\n    hit   ')}`);
      if (miss.length) console.log(`    miss  ${miss.join('\n    miss  ')}`);
      if (fps.length) console.log(`    FALSE ${fps.join('\n    FALSE ')}`);
    }
    const scanned = scans.filter((s) => s.scored && !(s.role === 'empty' && refFile === s.file)).length;
    console.log(`  TOTAL  rated ${hit}/${tot}  (+${present} found but unrated = ${hit + present}/${tot} present)  known feature ${kn}/${knPossible}  false ${fa} (${fmt(fa / scanned, 2)}/scan, ${faBehind} of them behind the wall)  vetoed-by-ref ${vetoed}  bias ${fmt(median(dxs), 2)} cm  |dx| med ${fmt(median(dxs.map(Math.abs)), 2)} cm`);
    rows.totals = rows.totals || [];
    rows.totals.push({ ref: refFile, recall: hit, present: hit + present, targets: tot, falseAlarms: fa, perScan: fa / scanned, vetoed, biasCm: median(dxs) });
  }
  return rows;
}

if (!quiet) {
  console.log(`scans: ${scans.length} (${empties.length} empty)  grid ${scans[0].hStep} cm x ${scans[0].vStep} cm, ${scans[0].cells} cells`);
  const g = scans[0].sfcw;
  console.log(`rf: tx1/rx1 ${g.tx1Gain}/${g.rx1Gain}  tx2/rx2 ${g.tx2Gain}/${g.rx2Gain}  ${g.startFreq}-${g.stopFreq} MHz/${g.stepSize}  settle ${g.settleCount}  buffers ${g.numBuffers}`);
  console.log(`wall ${params.wallThickness} cm, er ${params.epsilonR}, band ${DETECT_DEFAULTS.searchMinDepthCm}-${DETECT_DEFAULTS.searchMaxDepthCm} cm deep`);
  console.log('registration (rover odometer, cm on the rail):');
  for (const s of scans) console.log(`  ${s.file.padEnd(30)} frame ${s.frame || '?'}  col0 rail ${fmt(s.railX0Cm)}  label->column shift ${fmt(s.labelShiftCm, 2)}`);
}

const out = [];
if (sweepArg) {
  const [key, list] = sweepArg.split('=');
  if (!(key in DETECT_DEFAULTS)) { console.error(`unknown detector option: ${key}`); process.exit(2); }
  for (const v of list.split(',').map(Number)) {
    const options = { ...overrides, [key]: v };
    out.push({ options, rows: report(options, `${key}=${v}`) });
  }
} else {
  out.push({ options: overrides, rows: report(overrides, Object.keys(overrides).length ? JSON.stringify(overrides) : '') });
}

if (opt('json')) {
  writeFileSync(opt('json'), JSON.stringify(out.map((o) => ({
    options: o.options,
    totals: o.rows.totals,
    scans: o.rows.map((r) => ({
      scan: r.scan, ref: r.ref,
      matched: r.matched.map((m) => ({ pipe: m.pipe, local: m.local, x: m.det.x, dx: m.dx, depth: m.det.depth, db: m.det.db, prominenceDb: m.det.prominenceDb, tests: m.det.testsPassed, rating: m.det.rating, edge: m.det.edge, leanDeg: m.det.leanDeg, rows: m.det.rows })),
      missed: r.missed.map((m) => ({ pipe: m.pipe, local: m.local, present: m.present, nearest: m.nearest && { x: m.nearest.x, depth: m.nearest.depth, prominenceDb: m.nearest.prominenceDb, tests: m.nearest.testsPassed, rating: m.nearest.rating } })),
      known: r.known.map((d) => ({ x: d.x, depth: d.depth, prominenceDb: d.prominenceDb, tests: d.testsPassed, rating: d.rating })),
      falseAlarms: r.falseAlarms.map((d) => ({ x: d.x, depth: d.depth, behindWall: d.behindWall, db: d.db, prominenceDb: d.prominenceDb, tests: d.testsPassed, rating: d.rating, edge: d.edge, leanDeg: d.leanDeg, rows: d.rows })),
      all: r.dets.map((d) => ({ x: d.x, depth: d.depth, db: d.db, prominenceDb: d.prominenceDb, tests: d.testsPassed, testList: d.tests, rating: d.rating, edge: d.edge, inReference: d.inReference, rows: d.rows, rowsTotal: d.rowsTotal, leanDeg: d.leanDeg })),
    })),
  })), null, 2));
  console.log(`\nwrote ${opt('json')}`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
