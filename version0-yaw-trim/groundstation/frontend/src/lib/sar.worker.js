import { reconstruct } from './sarReconstruct';

// Thin wrapper: the reconstruction itself lives in lib/sarReconstruct.js so the
// detection worker can call it directly. Message shape and result are unchanged.
self.onmessage = function (e) {
  const { bscanData, bscanParams } = e.data;
  const result = reconstruct(bscanData, bscanParams, (p) => self.postMessage({ type: 'progress', progress: p }));
  self.postMessage({ type: 'result', result });
};
