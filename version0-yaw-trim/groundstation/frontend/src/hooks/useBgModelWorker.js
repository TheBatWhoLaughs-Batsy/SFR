import { useEffect, useRef, useState, useCallback } from 'react';
import BgModelWorker from '../lib/bgmodel.worker.js?worker';

export function useBgModelWorker() {
  const [trainingState, setTrainingState] = useState('idle'); // idle | training | complete | error
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const workerRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const startTraining = useCallback((samples, sfcwParams, config = {}) => {
    if (workerRef.current) {
      workerRef.current.terminate();
    }
    const worker = new BgModelWorker();
    workerRef.current = worker;

    setTrainingState('training');
    setProgress(null);
    setResult(null);
    setError(null);

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg);
      } else if (msg.type === 'complete') {
        setTrainingState('complete');
        setResult(msg.result);
        resultRef.current = msg.result;
        worker.terminate();
        workerRef.current = null;
      } else if (msg.type === 'error') {
        setTrainingState('error');
        setError(msg.message);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.postMessage({ type: 'train', data: { samples, sfcwParams, config } });
  }, []);

  const stopTraining = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'stop' });
    }
  }, []);

  const reset = useCallback(() => {
    setTrainingState('idle');
    setProgress(null);
    setResult(null);
    setError(null);
    resultRef.current = null;
  }, []);

  return { trainingState, progress, result, resultRef, error, startTraining, stopTraining, reset };
}
