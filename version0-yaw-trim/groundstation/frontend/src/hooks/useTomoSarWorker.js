import { useState, useRef, useEffect, useCallback } from 'react';
import TomoWorker from '../lib/tomosar.worker.js?worker';

const TOMO_INPUT_FIELDS = [
  'h_cal_real', 'h_cal_imag', 'magnitudes', 'distances',
  'lidar_standoff_mm', 'step_size', 'range_offset',
  'grid_ix', 'grid_iy',
];

function projectForTomo(data) {
  if (!data) return null;
  return data.map(pos => {
    const out = {};
    for (const k of TOMO_INPUT_FIELDS) if (pos[k] !== undefined) out[k] = pos[k];
    return out;
  });
}

export function useTomoSarWorker(data, params, enabled) {
  const [tomoResult, setTomoResult] = useState(null);
  const [tomoProgress, setTomoProgress] = useState(0);
  const workerRef = useRef(null);
  const jobIdRef = useRef(0);
  const timerRef = useRef(null);

  const run = useCallback(() => {
    if (!enabled || !data || data.length < 2 || !params) {
      setTomoResult(null);
      setTomoProgress(0);
      return;
    }
    if (workerRef.current) workerRef.current.terminate();
    const w = new TomoWorker();
    workerRef.current = w;
    const id = ++jobIdRef.current;
    setTomoProgress(0);

    w.onmessage = (e) => {
      if (jobIdRef.current !== id) return;
      if (e.data.type === 'progress') {
        setTomoProgress(e.data.progress);
      } else if (e.data.type === 'result') {
        setTomoResult(e.data.result);
        setTomoProgress(1);
      }
    };

    w.postMessage({ tomoData: projectForTomo(data), tomoParams: params });
  }, [data, params, enabled]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(run, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [run]);

  useEffect(() => {
    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  return { tomoResult, tomoProgress };
}
