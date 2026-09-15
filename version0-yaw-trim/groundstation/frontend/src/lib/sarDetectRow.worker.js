import { reconstructRowVariants } from './sarDetect';

// One row of a detection: all requested variants, reconstructed together so they share
// ray tables, resampled onto the plan's common grid. Spawned in a pool by
// sarDetect.worker.js.
self.onmessage = function (e) {
  const { plan, cells, keys } = e.data;
  try {
    self.postMessage({ grids: reconstructRowVariants(plan, cells, keys) });
  } catch (err) {
    self.postMessage({ error: String(err && err.message ? err.message : err) });
  }
};
