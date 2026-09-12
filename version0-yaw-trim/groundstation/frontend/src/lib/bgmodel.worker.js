// Builds the background model from captured positions and scores it.
//
// This used to train a 1-64-64-302 ReLU MLP for 2000 Adam epochs. On the
// 30-position bench set that reached only 4.9 dB of leave-one-position-out
// suppression, while plain interpolation over the same positions reached 20.2 dB
// — the captures are dense (~5 mm) relative to how fast the background varies,
// so there is nothing for a network to generalize that interpolation does not
// already get. See bgModelInterp.js for the full comparison.
//
// The message protocol is unchanged so the hook and panel keep working.

import { buildInterpModel, evaluateLoo, UNWIND_ALPHA } from './bgModelInterp';

self.onmessage = (e) => {
  const { type, data } = e.data;
  if (type !== 'train') return;

  try {
    const { samples, sfcwParams, config } = data;
    const opts = { unwindAlpha: config?.unwindAlpha ?? UNWIND_ALPHA };

    self.postMessage({ type: 'progress', stage: 'building', epoch: 0, totalEpochs: 2 });
    const model = buildInterpModel(samples, sfcwParams, opts);

    self.postMessage({ type: 'progress', stage: 'evaluating', epoch: 1, totalEpochs: 2 });
    const quality = evaluateLoo(samples, sfcwParams, opts);

    self.postMessage({
      type: 'complete',
      result: {
        ...model,
        quality,
        numSamples: model.numPositions,
        // Geometry stamp: the standoff axis this model is indexed by is
        // `lidar_reading - lidarAntennaOffsetMm`, so the model is only
        // meaningful under that offset and those sweep params. Recorded here
        // rather than at save time so it cannot be lost by a save path that
        // forgets to add it. See App.jsx handleSfcwLoadBgModel for the check.
        geometry: config?.geometry || null,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
