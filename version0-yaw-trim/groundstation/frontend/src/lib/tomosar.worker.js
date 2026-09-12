const SPEED_OF_LIGHT = 299792458;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function ifftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

function hanningWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  return w;
}

function kaiserWindow(n, beta) {
  const w = new Float64Array(n);
  const denom = besselI0(beta);
  for (let i = 0; i < n; i++) {
    const t = 2 * i / (n - 1) - 1;
    w[i] = besselI0(beta * Math.sqrt(1 - t * t)) / denom;
  }
  return w;
}

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k <= 25; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return sum;
}

function getWindow(type, n, beta) {
  if (type === 'hanning') return hanningWindow(n);
  if (type === 'kaiser') return kaiserWindow(n, beta || 3);
  return null;
}

function computeComplexRangeProfile(hCalReal, hCalImag, numSteps, freqStepHz, rangeOffset, win) {
  const nfftMin = numSteps * 4;
  const nfft = 1 << Math.ceil(Math.log2(nfftMin));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < numSteps; i++) {
    const w = win ? win[i] : 1;
    re[i] = hCalReal[i] * w;
    im[i] = hCalImag[i] * w;
  }
  ifftInPlace(re, im);

  const maxRange = SPEED_OF_LIGHT / (2 * freqStepHz);
  const half = nfft / 2;
  const distRe = [];
  const distIm = [];
  const distances = [];
  for (let i = 0; i < half; i++) {
    const d = (i / nfft) * maxRange - rangeOffset;
    if (d >= 0) {
      distRe.push(re[i]);
      distIm.push(im[i]);
      distances.push(d);
    }
  }
  return { re: distRe, im: distIm, distances };
}

self.onmessage = function (e) {
  const { tomoData, tomoParams } = e.data;
  const t0 = performance.now();

  if (!tomoData || tomoData.length < 2) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const numPositions = tomoData.length;
  const first = tomoData[0];
  if (!first.h_cal_real || !first.h_cal_imag) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const numSteps = first.h_cal_real.length;
  const freqStepHz = first.step_size || 60000000;
  const rangeOffset = first.range_offset || 0.5;

  const {
    xCount = 7, xStep = 5, yCount = 5, yStep = 2,
    maxDepth = 70, tomoResolution = 30,
    tomoWindowType = 'hanning', tomoKaiserBeta = 3,
    startFreq, stopFreq, epsilonR = 4.5,
    tomoRangeComp = 0,
  } = tomoParams;

  const n = Math.sqrt(Math.max(1, epsilonR));
  const fStart = (startFreq || 2000) * 1e6;
  const k_start = 2 * Math.PI * fStart / SPEED_OF_LIGHT;

  const win = getWindow(tomoWindowType, numSteps, tomoKaiserBeta);

  const crps = [];
  for (let p = 0; p < numPositions; p++) {
    crps.push(computeComplexRangeProfile(
      tomoData[p].h_cal_real, tomoData[p].h_cal_imag,
      numSteps, freqStepHz, rangeOffset, win
    ));
  }

  const crpDists = crps[0].distances;
  const crpNumBins = crpDists.length;
  const crpDistStart = crpDists[0];
  const crpDistStep = crpNumBins > 1 ? (crpDists[crpNumBins - 1] - crpDistStart) / (crpNumBins - 1) : 1;

  const xStepCm = xStep;
  const yStepCm = yStep;
  const apertureXCm = (xCount - 1) * xStepCm;
  const apertureYCm = (yCount - 1) * yStepCm;

  const pixelsX = Math.max(2, Math.round(apertureXCm / tomoResolution * 10));
  const pixelsY = Math.max(2, Math.round(apertureYCm / tomoResolution * 10));
  const depthMaxM = maxDepth / 100;
  const pixelsZ = Math.max(2, Math.round(depthMaxM / (tomoResolution / 1000)));

  const volume = new Float32Array(pixelsX * pixelsY * pixelsZ);

  const posXcm = new Float64Array(numPositions);
  const posYcm = new Float64Array(numPositions);
  const standoffs = new Float64Array(numPositions);

  for (let p = 0; p < numPositions; p++) {
    const pos = tomoData[p];
    if (pos.grid_ix !== undefined && pos.grid_iy !== undefined) {
      posXcm[p] = pos.grid_ix * xStepCm;
      posYcm[p] = pos.grid_iy * yStepCm;
    } else {
      const h = Math.max(1, xCount);
      const iy = Math.floor(p / h);
      const along = p % h;
      const ix = iy % 2 === 0 ? along : h - 1 - along;
      posXcm[p] = ix * xStepCm;
      posYcm[p] = iy * yStepCm;
    }
    const mm = pos.lidar_standoff_mm;
    standoffs[p] = (mm !== null && mm !== undefined && isFinite(mm)) ? mm / 1000 : 0;
  }

  const progressEvery = Math.max(1, Math.ceil(numPositions / 20));

  for (let p = 0; p < numPositions; p++) {
    const cre = crps[p].re;
    const cim = crps[p].im;
    const sp = standoffs[p];
    const axCm = posXcm[p];
    const ayCm = posYcm[p];

    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = Math.max(0.005, (zi / Math.max(1, pixelsZ - 1)) * depthMaxM);

      for (let yi = 0; yi < pixelsY; yi++) {
        const yCm = (yi / Math.max(1, pixelsY - 1)) * apertureYCm;
        const dy = (yCm - ayCm) / 100;

        for (let xi = 0; xi < pixelsX; xi++) {
          const xCm = (xi / Math.max(1, pixelsX - 1)) * apertureXCm;
          const dx = (xCm - axCm) / 100;

          const R_b = sp + n * Math.sqrt(dx * dx + dy * dy + depth * depth);

          const binFloat = (R_b - crpDistStart) / crpDistStep;
          const binIdx = Math.floor(binFloat);
          if (binIdx < 0 || binIdx >= crpNumBins - 1) continue;

          const frac = binFloat - binIdx;
          const valRe = cre[binIdx] * (1 - frac) + cre[binIdx + 1] * frac;
          const valIm = cim[binIdx] * (1 - frac) + cim[binIdx + 1] * frac;

          // Phase compensation: 4 * k_start * R_b (round-trip)
          const phase = 4 * k_start * R_b;
          const cosP = Math.cos(phase);
          const sinP = Math.sin(phase);

          const compRe = valRe * cosP - valIm * sinP;
          const compIm = valRe * sinP + valIm * cosP;

          const rangeComp = tomoRangeComp > 0 ? Math.pow(R_b, tomoRangeComp / 2) : 1;

          const idx = zi * pixelsY * pixelsX + yi * pixelsX + xi;
          volume[idx] += Math.sqrt(compRe * compRe + compIm * compIm) * rangeComp;
        }
      }
    }

    if (p === numPositions - 1 || p % progressEvery === 0) {
      self.postMessage({ type: 'progress', progress: (p + 1) / numPositions });
    }
  }

  const computeTimeMs = Math.round(performance.now() - t0);

  self.postMessage({
    type: 'result',
    result: {
      volume: Array.from(volume),
      pixelsX,
      pixelsY,
      pixelsZ,
      xMinCm: 0,
      xMaxCm: apertureXCm,
      yMinCm: 0,
      yMaxCm: apertureYCm,
      depthMaxCm: depthMaxM * 100,
      numPositions,
      computeTimeMs,
    },
  });
};
