import { inferInterpModel } from './bgModelInterp';

const SPEED_OF_LIGHT = 299792458;

export function inferBgModel(model, distanceMm, numSteps) {
  if (model.type === 'interp') return inferInterpModel(model, distanceMm, numSteps);
  return inferMlpModel(model, distanceMm, numSteps);
}

// Legacy path: the 1-64-64-302 MLP. Kept so models saved before the switch to
// interpolation still load. New models are always type 'interp'.
function inferMlpModel(model, distanceMm, numSteps) {
  const { weights, normalization, freqs } = model;
  const { dMin, dRange, tMean, tStd } = normalization;
  const { w1, b1, w2, b2, w3, b3 } = weights;
  const hiddenSize = b1.length;
  const outputSize = b3.length;

  const normD = (distanceMm - dMin) / dRange;

  const a1 = new Float64Array(hiddenSize);
  for (let j = 0; j < hiddenSize; j++) {
    const z = w1[j] * normD + b1[j];
    a1[j] = z > 0 ? z : 0;
  }

  const a2 = new Float64Array(hiddenSize);
  for (let j = 0; j < hiddenSize; j++) {
    let sum = b2[j];
    for (let k = 0; k < hiddenSize; k++) sum += w2[j * hiddenSize + k] * a1[k];
    a2[j] = sum > 0 ? sum : 0;
  }

  const out = new Float64Array(outputSize);
  for (let j = 0; j < outputSize; j++) {
    let sum = b3[j];
    for (let k = 0; k < hiddenSize; k++) sum += w3[j * hiddenSize + k] * a2[k];
    out[j] = sum;
  }

  for (let i = 0; i < outputSize; i++) out[i] = out[i] * tStd + tMean;

  const resReal = out.subarray(0, numSteps);
  const resImag = out.subarray(numSteps, numSteps * 2);

  // Phase-rewind: multiply by exp(-j * 4pi * f * d / c) to reconstruct background
  const d = distanceMm / 1000;
  const bgReal = new Array(numSteps);
  const bgImag = new Array(numSteps);
  for (let i = 0; i < numSteps; i++) {
    const phase = 4 * Math.PI * freqs[i] * d / SPEED_OF_LIGHT;
    const cosP = Math.cos(phase);
    const sinP = Math.sin(phase);
    bgReal[i] = resReal[i] * cosP + resImag[i] * sinP;
    bgImag[i] = -resReal[i] * sinP + resImag[i] * cosP;
  }

  return { bgReal, bgImag };
}
