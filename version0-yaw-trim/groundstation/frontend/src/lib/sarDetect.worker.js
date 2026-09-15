import {
  usableRows, planDetection, reconstructRowVariants, emptyReferenceKey, emptyReferenceLines,
  finishDetection, runDetection, VARIANT_KEYS,
} from './sarDetect';
import RowWorker from './sarDetectRow.worker.js?worker';
import { runSeepageDetection } from './seepageDetect';

// Coordinates a detection (2026-09-14). The reconstructions are 97% of the time and every
// row is independent, so rows go to a pool of row workers (sarDetectRow.worker.js), each
// reconstructing all six variants of its row with shared ray tables; the line search,
// tests and ratings (~50 ms) run here once the grids are back. A 6-row scan went from
// ~6.4 s to well under a second on a 24-thread laptop.
//
// The pool lives as long as this worker. useSarDetect terminates this worker to cancel a
// stale detection, and nested workers die with it.
//
// The empty reference's lines are returned with a cache key; when the hook sends them back
// with a matching key for the same empty scan, its rows are not reconstructed again.

// Measured on a 30-row scan (Node worker_threads, 24-thread i7-14650HX): 4 workers 7.6 s,
// 8 5.3 s, 12 4.6 s, 16 4.1 s. 12 takes most of the gain without claiming every core.
const MAX_WORKERS = 12;
let pool = [];

function poolSize(tasks) {
  const hc = (self.navigator && self.navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(tasks, hc - 1, MAX_WORKERS));
}

function runTasks(plan, tasks, onDone) {
  const out = { row: [], empty: [] };
  if (!tasks.length) return Promise.resolve(out);
  const n = poolSize(tasks.length);
  if (n > 1 && typeof Worker !== 'undefined') {
    try { while (pool.length < n) pool.push(new RowWorker()); } catch { pool = []; }
  }
  if (n <= 1 || pool.length < n) {
    for (const t of tasks) { out[t.kind][t.i] = reconstructRowVariants(plan, t.cells, t.keys); onDone(t.weight); }
    return Promise.resolve(out);
  }
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, failed = false;
    const launch = (w) => {
      if (failed) return;
      if (next >= tasks.length) { if (running === 0) resolve(out); return; }
      const t = tasks[next++];
      running++;
      w.onmessage = (ev) => {
        running--;
        if (ev.data.error) { failed = true; reject(new Error(ev.data.error)); return; }
        out[t.kind][t.i] = ev.data.grids;
        onDone(t.weight);
        launch(w);
      };
      w.onerror = (ev) => { failed = true; reject(new Error(ev.message || 'row worker failed')); };
      w.postMessage({ plan, cells: t.cells, keys: t.keys });
    };
    for (let k = 0; k < n; k++) launch(pool[k]);
  });
}

self.onmessage = async function (e) {
  const { rows: rawRows, params, options, emptyRows: rawEmpty, cachedReference, mode } = e.data;
  const t0 = performance.now();
  // Seepage mode (lib/seepageDetect.js): no reconstructions, a few hundred ms in one thread.
  if (mode === 'seepage') {
    try {
      self.postMessage({ type: 'progress', progress: 0 });
      const result = runSeepageDetection(rawRows, params, options || {}, rawEmpty || null);
      if (result) result.timing = { ms: Math.round(performance.now() - t0), workers: 1, mode: 'seepage' };
      self.postMessage({ type: 'result', result });
    } catch (err) {
      self.postMessage({ type: 'result', result: null, error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  try {
    const rows = usableRows(rawRows);
    if (!rows.length) { self.postMessage({ type: 'result', result: null }); return; }
    const plan = planDetection(rows, params, options || {});
    const empties = rawEmpty ? usableRows(rawEmpty) : [];
    const refKey = emptyReferenceKey(plan);
    const refCached = !!(empties.length && cachedReference && cachedReference.key === refKey);

    // heaviest first: target rows carry six variants, empty rows one
    const tasks = rows.map((r, i) => ({ kind: 'row', i, cells: r.cells, keys: VARIANT_KEYS, weight: VARIANT_KEYS.length }));
    if (!refCached) empties.forEach((r, i) => tasks.push({ kind: 'empty', i, cells: r.cells, keys: ['base'], weight: 1 }));
    const totalWeight = tasks.reduce((s, t) => s + t.weight, 0) || 1;
    let doneWeight = 0;
    self.postMessage({ type: 'progress', progress: 0 });

    let emptyLines;
    let rowResults;
    let workers = 1;
    try {
      const got = await runTasks(plan, tasks, (w) => {
        doneWeight += w;
        self.postMessage({ type: 'progress', progress: doneWeight / totalWeight });
      });
      workers = Math.min(pool.length || 1, poolSize(tasks.length));
      rowResults = rows.map((r, i) => ({ iy: r.iy, grids: got.row[i] }));
      emptyLines = refCached ? cachedReference.lines
        : (empties.length ? emptyReferenceLines(plan, empties.map((r, i) => ({ iy: r.iy, G: got.empty[i] ? got.empty[i].base : null }))) : []);
    } catch (poolErr) {
      // A row worker failed (or could not start): do the whole thing here rather than fail.
      const result = runDetection(rows, params, options || {}, rawEmpty || null,
        (p) => self.postMessage({ type: 'progress', progress: p }));
      if (result) result.timing = { ms: Math.round(performance.now() - t0), workers: 1, referenceCached: false, fallback: String(poolErr.message || poolErr) };
      self.postMessage({ type: 'result', result, reference: result && empties.length ? { key: refKey, lines: result.emptyLines } : null });
      return;
    }

    const result = finishDetection(plan, rowResults, emptyLines, !!(rawEmpty && rawEmpty.length));
    if (result) result.timing = { ms: Math.round(performance.now() - t0), workers, referenceCached: refCached };
    self.postMessage({ type: 'result', result, reference: empties.length ? { key: refKey, lines: emptyLines } : null });
  } catch (err) {
    self.postMessage({ type: 'result', result: null, error: String(err && err.message ? err.message : err) });
  }
};
