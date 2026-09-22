import { useEffect, useRef, useState } from 'react';
import DetectWorker from '../lib/sarDetect.worker.js?worker';
// The projection lives in lib/sarDetect.js so the Node harness (bench/run.mjs) uses the
// same one; re-exported here for callers that had it from this module.
import { projectRowsForDetect } from '../lib/sarDetect';

export { projectRowsForDetect };

/**
 * Runs lib/sarDetect.js in a worker whenever the scan, the reference or the geometry
 * params change. `params` must be a memoised object (it keys the debounce).
 */
export function useSarDetect(bscanData, emptyData, params, options, mode = 'pipe') {
  const [detection, setDetection] = useState(null);
  const [detectProgress, setDetectProgress] = useState(null);
  const [detectError, setDetectError] = useState(null);
  const workerRef = useRef(null);
  const debounceRef = useRef(null);
  const jobIdRef = useRef(0);
  // The empty reference's lines from the last run: { emptyData, key, lines }. Sent back to
  // the worker, which uses them only if the key (geometry + options + target grid) still
  // matches, so a new scan or a live raster flush does not reconstruct the reference again.
  const refCacheRef = useRef(null);
  // A result from the other detection mode must not be shown while the new one computes.
  const modeRef = useRef(mode);

  useEffect(() => () => {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (modeRef.current !== mode) { modeRef.current = mode; setDetection(null); }
    const rows = projectRowsForDetect(bscanData);
    if (!rows.length) { setDetection(null); setDetectProgress(null); setDetectError(null); return; }
    // Longer than the display's 300 ms: a detection costs several reconstructions per
    // row, and a live raster flushes cells at 4 Hz.
    debounceRef.current = setTimeout(() => {
      if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; }
      const jobId = ++jobIdRef.current;
      setDetectProgress(0);
      setDetectError(null);
      const worker = new DetectWorker();
      workerRef.current = worker;
      worker.onmessage = (e) => {
        if (jobIdRef.current !== jobId) return;
        if (e.data.type === 'progress') setDetectProgress(e.data.progress);
        else if (e.data.type === 'result') {
          if (e.data.reference && emptyData) refCacheRef.current = { emptyData, key: e.data.reference.key, lines: e.data.reference.lines };
          // Debug level (hidden unless DevTools shows Verbose): how long it took, on how many
          // workers, and whether the empty reference came from the cache.
          if (e.data.result && e.data.result.timing) console.debug('[sar-detect]', JSON.stringify(e.data.result.timing));
          setDetection(e.data.result);
          setDetectError(e.data.error || null);
          setDetectProgress(null);
        }
      };
      worker.postMessage({
        rows,
        emptyRows: emptyData ? projectRowsForDetect(emptyData) : null,
        params,
        options: options || {},
        mode,
        cachedReference: mode !== 'seepage' && refCacheRef.current && emptyData && refCacheRef.current.emptyData === emptyData
          ? { key: refCacheRef.current.key, lines: refCacheRef.current.lines } : null,
      });
    }, 800);
  }, [bscanData, emptyData, params, options, mode]);

  return { detection, detectProgress, detectError };
}
