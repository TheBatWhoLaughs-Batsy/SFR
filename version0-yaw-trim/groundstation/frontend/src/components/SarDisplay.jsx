import { useRef, useEffect, useCallback, useState } from 'react';
import { COLORMAPS } from '@/lib/imagingEffects';
import { effectiveRating } from '@/lib/sarDetect';

const BG = '#000000';

// Shared with the Imaging Bench rather than redefined here -- one implementation, as with
// windowFn and CFAR. Default inferno: it and viridis are perceptually uniform, where jet
// is not (its lightness is non-monotonic, so it invents banded structure that is not in
// the data -- on an image whose whole question is "is that feature real", exactly the
// wrong failure mode). jet stays available because it is what earlier images were read in.
//
// The dropdown drives the amplitude and combined panes ONLY -- see cohMap below.

// Coherence keeps its own fixed ramp, deliberately, and is NOT switchable. The two panes
// in split view are different quantities on different scales -- a relative dB amplitude
// and an absolute 0-1 ratio -- and the entire point of showing them at once is reading one
// against the other, which a shared palette makes harder rather than easier. Dark blue ->
// teal -> white, monotonic in lightness and nothing like inferno or viridis at a glance.
function cohMap(t) {
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.max(0, Math.min(1, 1.6 * t - 0.6))),
    Math.round(255 * Math.max(0, Math.min(1, 1.25 * t))),
    Math.round(255 * Math.max(0, Math.min(1, 0.35 + 0.65 * t))),
  ];
}

// One offscreen canvas per pane, sized in DATA pixels and scaled up on draw.
// 100x100 cells x two panes x 60 fps is 1.2M fillRect calls a second, which is
// exactly the cost ImagingDisplay was rewritten to avoid; putImageData plus one
// scaled drawImage is a single blit instead.
//
// Orientation matches the C-scan panel's row B-scan: lateral position runs left to
// right across the screen and depth INCREASES bottom to top (the wall face is the
// bottom edge). So image column = position index xi, image row = pixelsZ-1-zi.
function blit(ctx, off, vals, pixelsX, pixelsZ, vMin, vMax, cmap, dest) {
  const oc = off.canvas;
  if (oc.width !== pixelsX || oc.height !== pixelsZ) {
    oc.width = pixelsX;
    oc.height = pixelsZ;
  }
  const id = off.createImageData(pixelsX, pixelsZ);
  const d = id.data;
  const span = vMax - vMin || 1;
  for (let zi = 0; zi < pixelsZ; zi++) {
    const row = pixelsZ - 1 - zi;
    for (let xi = 0; xi < pixelsX; xi++) {
      const v = vals[zi * pixelsX + xi];
      const [r, g, b] = cmap((v - vMin) / span);
      const o = (row * pixelsX + xi) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  off.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(oc, dest.x, dest.y, dest.w, dest.h);
}

// Floor on the coherence weight, so a zero-coherence pixel lands at -40 dB instead of
// -infinity and cannot swallow the dynamic range on its own.
const COH_FLOOR = 0.01;

function drawPane(canvas, off, sarResult, crosshair, opts) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Assigning width/height reallocates the backing store AND clears it, so doing it
  // unconditionally inside a 60 fps rAF loop reallocated two canvases 120 times a
  // second. Only touch it when the box has actually changed; the redraw below still
  // happens every frame, which is what makes the pane track a panel resize.
  const wantW = Math.round(rect.width * dpr);
  const wantH = Math.round(rect.height * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const isCoh = opts.mode === 'coherence';
  const isCombined = opts.mode === 'combined';
  const cmap = isCoh ? cohMap : (COLORMAPS[opts.colormap] || COLORMAPS.inferno);

  const msg = (text) => {
    ctx.fillStyle = '#333333';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
  };

  // Deliberately silent: Viewport renders one centred "No SAR image" overlay over the
  // whole pane stack, and drawing it here too put the same sentence on screen three
  // times in split view.
  if (!sarResult || !sarResult.image) return;
  if (isCoh && !sarResult.coherence) {
    msg('Coherence needs Coherent mode — incoherent SAR has no phase');
    return;
  }

  const { image, coherence, pixelsX, pixelsZ, depthMax, apertureLength } = sarResult;
  const src = isCoh ? coherence : image;
  // Combined view degrades to plain amplitude rather than going blank when there is no
  // coherence to weight by (incoherent SAR), and says so in the title.
  const weighting = isCombined && !!coherence;

  const pad = { top: 24, bottom: 34, left: 50, right: 40 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  if (plotW <= 4 || plotH <= 4) return;

  const isLinear = opts.scaleMode === 'linear';

  // Coherence is an ABSOLUTE ratio, so it is pinned to 0..1 and never dynamically
  // scaled. Stretching it would destroy the whole point: 0.9 means "the aperture
  // focused this" and 0.2 means "it did not" regardless of what else is in frame,
  // and that reading has to survive between scans.
  let vMin, vMax, displayVals;
  if (isCoh) {
    vMin = 0;
    vMax = 1;
    displayVals = src;
  } else {
    displayVals = new Float64Array(src.length);
    vMin = Infinity; vMax = -Infinity;
    for (let i = 0; i < src.length; i++) {
      // Weighting is a straight multiply of the LINEAR amplitude by the coherence, i.e.
      // +20log10(coh) in dB: coherence 1 leaves a pixel alone, 0.5 costs it 6 dB, and
      // clutter that was merely bright sinks. Note the amplitude already contains the
      // RAW coherence once by construction (|sum| = coh_raw * sum|.|), so this is a
      // second, deliberate weighting -- and by the DEBIASED figure, which is a different
      // quantity, so it is not simply squaring what is already there. On the test scan
      // it widened target-vs-clutter from 3.8 dB to 7.1 dB.
      const dbv = weighting
        ? src[i] + 20 * Math.log10(Math.max(coherence[i], COH_FLOOR))
        : src[i];
      const v = isLinear ? Math.pow(10, dbv / 20) : dbv;
      displayVals[i] = v;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (!isFinite(vMin)) vMin = isLinear ? 0 : -90;
    if (!isFinite(vMax)) vMax = isLinear ? 1 : -20;
    if (vMax - vMin < (isLinear ? 0.001 : 1)) { vMin -= isLinear ? 0.0005 : 0.5; vMax += isLinear ? 0.0005 : 0.5; }
    // Dynamic range is a RATIO below the peak, so it means the same thing in both
    // scales -- it just has to be applied multiplicatively in linear. It used to be
    // skipped entirely when linear was selected, leaving a slider that read "dB",
    // stayed enabled, and did nothing.
    if (opts.dynRange) {
      if (isLinear) {
        const floor = vMax * Math.pow(10, -opts.dynRange / 20);
        if (vMin < floor) vMin = floor;
      } else if (vMax - vMin > opts.dynRange) {
        vMin = vMax - opts.dynRange;
      }
    }
  }

  blit(ctx, off, displayVals, pixelsX, pixelsZ, vMin, vMax, cmap,
       { x: pad.left, y: pad.top, w: plotW, h: plotH });

  // Grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.4;
  const xTicks = 5;
  const yTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
  }
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (i / yTicks) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  // X-axis labels: lateral position, left to right, in the C-scan grid's frame (a row
  // that starts part way into the grid starts its axis there too).
  const apStart = sarResult.apertureStart ?? 0;
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${((apStart + (i / xTicks) * apertureLength) * 100).toFixed(1)}`, x, h - pad.bottom + 13);
  }
  // Y-axis labels: true depth below the wall face (not apparent range), 0 at the
  // bottom edge, increasing upwards.
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (1 - i / yTicks) * plotH;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${((i / yTicks) * depthMax * 100).toFixed(1)}`, pad.left - 6, y + 3);
  }

  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Position (cm)', pad.left + plotW / 2, h - pad.bottom + 26);
  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.fillText('Depth into wall (cm)', 0, 0);
  ctx.restore();

  // Title
  ctx.fillStyle = isCoh ? '#4ecdc4' : '#4ade80';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  const title = isCoh
    ? 'SAR COHERENCE (0–1, fixed)'
    : (isCombined
        ? (weighting
            ? `SAR AMPLITUDE × COHERENCE (${isLinear ? 'linear' : 'dB'})`
            : 'SAR AMPLITUDE — incoherent mode, nothing to weight by')
        : `SAR AMPLITUDE (${isLinear ? 'linear' : 'dB'})`);
  ctx.fillText(title, pad.left, 14);

  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  const geom = sarResult.layered
    ? `layered ${(sarResult.wallThicknessCm ?? 0).toFixed(0)}cm`
    : 'straight ray';
  const meta = isCoh
    ? `${geom} | ${sarResult.numPositions} pos`
    : `εr ${(sarResult.epsilonR ?? 1).toFixed(2)} | ${geom} | ${sarResult.windowType || 'rect'} | ${sarResult.numPositions} pos`;
  ctx.fillText(meta, w - pad.right, 14);

  // Colour bar
  const barW = 12;
  const barX = w - pad.right + 8;
  for (let i = 0; i < plotH; i++) {
    const [r, g, b] = cmap(1 - i / plotH);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(barX, pad.top + i, barW, 1);
  }
  ctx.fillStyle = '#555555';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  const fmt = (v) => (isCoh ? v.toFixed(2) : (isLinear ? v.toFixed(3) : v.toFixed(0)));
  ctx.fillText(fmt(vMax), barX, pad.top - 4);
  ctx.fillText(fmt(vMin), barX, pad.top + plotH + 10);

  drawDetection(ctx, opts, { pad, plotW, plotH, apStart, apertureLength, depthMax, h });

  // Crosshair — reports BOTH quantities wherever it is, so the panes can be read
  // against each other without moving the mouse between them.
  if (crosshair) {
    const relX = (crosshair.x - pad.left) / plotW;
    const relY = (crosshair.y - pad.top) / plotH;
    if (relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1) {
      // Position runs along the screen's x, depth up the screen's y (0 at the bottom).
      const xi = Math.min(pixelsX - 1, Math.floor(relX * pixelsX));
      const zi = Math.min(pixelsZ - 1, Math.floor((1 - relY) * pixelsZ));

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(crosshair.x, pad.top); ctx.lineTo(crosshair.x, h - pad.bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.left, crosshair.y); ctx.lineTo(w - pad.right, crosshair.y); ctx.stroke();
      ctx.setLineDash([]);

      const dbVal = image[zi * pixelsX + xi];
      const ampLabel = isLinear ? Math.pow(10, dbVal / 20).toFixed(4) : `${dbVal.toFixed(1)}dB`;
      const cohLabel = coherence ? `, coh ${coherence[zi * pixelsX + xi].toFixed(2)}` : '';
      const wLabel = weighting
        ? `, weighted ${(dbVal + 20 * Math.log10(Math.max(coherence[zi * pixelsX + xi], COH_FLOOR))).toFixed(1)}dB`
        : '';
      const label = `pos ${((apStart + relX * apertureLength) * 100).toFixed(1)}cm, depth ${((1 - relY) * depthMax * 100).toFixed(1)}cm, ${ampLabel}${cohLabel}${wLabel}`;
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      const labelX = crosshair.x + 10 > w - 250 ? crosshair.x - 250 : crosshair.x + 10;
      ctx.fillText(label, labelX, crosshair.y - 8);
    }
  }
}

// Target markers from lib/sarDetect.js, drawn on every pane so the amplitude and
// coherence images can be read against the same circles. A marker is placed at the
// ACTIVE ROW's own peak when that row saw the target, else at the cross-row consensus
// (drawn fainter). The circle's diameter is the target's measured -6 dB width in both
// axes, so it is to scale on the image; a floor keeps thin targets visible.
const MARKER_STYLE = {
  confirmed: { stroke: '#4ade80', dash: [], width: 2, label: true },
  probable: { stroke: '#fbbf24', dash: [5, 4], width: 1.5, label: true },
  unresolved: { stroke: '#9ca3af', dash: [2, 3], width: 1, label: true },
  reference: { stroke: '#6b7280', dash: [1, 3], width: 1, label: false },
};
// The stretch at each end of the SCAN (not of this row) that detection does not trust or
// does not search, hatched. Purely visual.
function hatchEndZones(ctx, det, xPix, pad, plotH) {
  const zones = [[det.xMin, det.xMin + det.endExcludeCm], [det.xMax - det.endExcludeCm, det.xMax]];
  for (const [a, b] of zones) {
    const x0 = xPix(a), x1 = xPix(b);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(Math.min(x0, x1), pad.top, Math.abs(x1 - x0), plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = Math.min(x0, x1) - plotH; s < Math.max(x0, x1); s += 8) {
      ctx.moveTo(s, pad.top + plotH); ctx.lineTo(s + plotH, pad.top);
    }
    ctx.stroke();
  }
}

// Seepage-mode patches (lib/seepageDetect.js): regions, not circles. On the active row the
// outline is that row's own extent at full strength; a patch that does not reach this row
// is drawn at its overall extent, faint. The searched depth band is marked with dotted
// lines and the unsearched ends are hatched.
const PATCH_DRAW = {
  moisture: { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.10)', dash: [], width: 2, label: 'possible moisture' },
  unverified: { stroke: '#fbbf24', fill: 'rgba(251,191,36,0.08)', dash: [5, 4], width: 1.5, label: 'unverified patch' },
  reference: { stroke: '#6b7280', fill: null, dash: [1, 3], width: 1, label: null },
};
function drawSeepage(ctx, opts, g) {
  const det = opts.detection;
  const { pad, plotW, plotH, apStart, apertureLength, depthMax } = g;
  const xPix = (cm) => pad.left + ((cm / 100 - (apStart || 0)) / apertureLength) * plotW;
  const yPix = (cm) => pad.top + (1 - (cm / 100) / depthMax) * plotH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();
  if (det.endExcludeCm > 0) hatchEndZones(ctx, det, xPix, pad, plotH);
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = 'rgba(56,189,248,0.35)';
  ctx.lineWidth = 1;
  for (const z of det.depthBand) {
    const y = yPix(z);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
  }
  ctx.setLineDash([]);
  let lastLabelX = -Infinity, lastBelow = false;
  for (const p of det.patches) {
    const style = PATCH_DRAW[p.rating];
    if (!style) continue;
    const row = opts.activeRow != null ? p.perRow.find((r) => r.iy === opts.activeRow) : null;
    const ext = row || { x0: p.x0, x1: p.x1, z0: p.zMin, z1: p.zMax };
    // 1 cm of margin: the smoothing width, and it keeps a one-column row visible
    const xa = xPix(ext.x0 - 1), xb = xPix(ext.x1 + 1);
    const ya = yPix(ext.z1 + 1), yb = yPix(Math.max(0, ext.z0 - 1));
    ctx.globalAlpha = row || p.rating === 'reference' ? 1 : 0.45;
    if (style.fill) { ctx.fillStyle = style.fill; ctx.fillRect(xa, ya, xb - xa, yb - ya); }
    ctx.setLineDash(style.dash);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.width;
    ctx.strokeRect(xa, ya, xb - xa, yb - ya);
    ctx.setLineDash([]);
    if (style.label) {
      const label = `${style.label} · ${p.x0.toFixed(1)}-${p.x1.toFixed(1)} cm · ~${p.depth.toFixed(1)} cm`;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = xa > pad.left + plotW * 0.6 ? 'right' : 'left';
      const lx = ctx.textAlign === 'right' ? xb : xa;
      const below = (p.xc - lastLabelX) < 10 && !lastBelow;
      lastLabelX = p.xc; lastBelow = below;
      const ly = below ? Math.min(pad.top + plotH - 4, yb + 12) : Math.max(pad.top + 10, ya - 4);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(ctx.textAlign === 'right' ? lx - tw - 3 : lx - 3, ly - 9, tw + 6, 12);
      ctx.fillStyle = style.stroke;
      ctx.fillText(label, lx, ly);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawDetection(ctx, opts, g) {
  const det = opts.detection;
  if (det && det.mode === 'seepage') { drawSeepage(ctx, opts, g); return; }
  if (!det || !det.targets) return;
  const { pad, plotW, plotH, apStart, apertureLength, depthMax, h } = g;
  const xPix = (cm) => pad.left + ((cm / 100 - (apStart || 0)) / apertureLength) * plotW;
  const yPix = (cm) => pad.top + (1 - (cm / 100) / depthMax) * plotH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();

  // End zones: the truncated-aperture stretch at each end of the SCAN (not of this
  // row), hatched. Purely visual; the operator is expected to overscan.
  if (opts.handleEnds && det.endExcludeCm > 0) hatchEndZones(ctx, det, xPix, pad, plotH);

  // Labels of neighbouring markers are staggered: the second of any pair closer than
  // 10 cm goes below its circle instead of above, so 33 cm and 36.5 cm can both be read.
  let lastLabelX = -Infinity, lastBelow = false;
  for (const t of det.targets) {
    const rating = effectiveRating(t, opts.handleEnds);
    const style = MARKER_STYLE[rating];
    if (!style) continue;
    const row = opts.activeRow != null ? t.perRow.find((r) => r.iy === opts.activeRow) : null;
    const seen = !!(row && row.seen && Number.isFinite(row.x));
    // not seen in this row: where the fitted LINE crosses it, so a slanted pipe's faint
    // marker still sits on the pipe rather than at its mid-height position
    const x = seen ? row.x : (row && Number.isFinite(row.xPred) ? row.xPred : t.x);
    const depth = seen ? row.depth : t.depth;
    const widthCm = Math.max(2, t.widthCm || 3);
    const rx = Math.max(6, (widthCm / 100 / apertureLength) * plotW / 2);
    const ry = Math.max(6, (widthCm / 100 / depthMax) * plotH / 2);
    const cx = xPix(x), cy = yPix(depth);
    ctx.globalAlpha = seen || rating === 'reference' ? 1 : 0.45;
    ctx.setLineDash(style.dash);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.width;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // small tick marks make a thin circle read as a marker rather than a blob edge
    ctx.beginPath();
    ctx.moveTo(cx - rx - 4, cy); ctx.lineTo(cx - rx, cy);
    ctx.moveTo(cx + rx, cy); ctx.lineTo(cx + rx + 4, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    if (style.label) {
      const label = rating === 'unresolved'
        ? `${t.x.toFixed(1)} cm · unresolved (end)`
        : `${rating} · ${t.x.toFixed(1)} cm · ${depth.toFixed(1)} cm deep`;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = cx > pad.left + plotW * 0.75 ? 'right' : 'left';
      const lx = ctx.textAlign === 'right' ? cx - rx - 6 : cx + rx + 6;
      const below = (t.x - lastLabelX) < 10 && !lastBelow;
      lastLabelX = t.x; lastBelow = below;
      const ly = below ? Math.min(pad.top + plotH - 4, cy + ry + 12) : Math.max(pad.top + 10, cy - ry - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(ctx.textAlign === 'right' ? lx - tw - 3 : lx - 3, ly - 9, tw + 6, 12);
      ctx.fillStyle = style.stroke;
      ctx.fillText(label, lx, ly);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function Pane({ sarResult, mode, scaleMode, dynRange, colormap, detection, activeRow, handleEnds }) {
  const canvasRef = useRef(null);
  const offRef = useRef(null);
  const animRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  if (!offRef.current && typeof document !== 'undefined') {
    offRef.current = document.createElement('canvas').getContext('2d');
  }

  const draw = useCallback(() => {
    drawPane(canvasRef.current, offRef.current, sarResult, crosshair,
             { mode, scaleMode: scaleMode || 'db', dynRange, colormap, detection, activeRow, handleEnds });
  }, [sarResult, crosshair, mode, scaleMode, dynRange, colormap, detection, activeRow, handleEnds]);

  // Kept as a rAF loop rather than a draw-on-change effect for the same reason
  // BscanDisplay is: the canvas sizes itself from getBoundingClientRect(), so
  // redrawing every frame is what makes it track a panel resize. Replacing it
  // needs a ResizeObserver first.
  useEffect(() => {
    const render = () => {
      draw();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  return (
    <div className="relative flex-1 min-h-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        onMouseLeave={() => setCrosshair(null)}
      />
    </div>
  );
}

// Both panes are shown at once rather than behind a toggle: amplitude answers "how
// bright is this" and coherence answers "did the aperture actually focus it", and the
// useful reading is the pair, not either alone. On a real 60-position scan the
// amplitude image put a known pipe within 3-4 dB of two other lobes at the same depth;
// coherence pushed the mid-scan one down to 0.56 against the pipe's 0.82 and zeroed two
// more. It did NOT uniquely pick the pipe -- a feature at the opposite aperture edge
// scored comparably (0.89) -- so read the pair, and treat an edge feature with
// suspicion until the scan is extended past it.
export default function SarDisplay({ sarResult, sarProgress, scaleMode, dynRange, viewMode, colormap, detection, activeRow, handleEnds }) {
  const combined = viewMode === 'combined';
  return (
    <div className="flex flex-col w-full h-full">
      {sarProgress !== null && (
        <div className="absolute top-0 left-0 right-0 z-10 h-0.5">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-200"
            style={{ width: `${sarProgress * 100}%` }}
          />
        </div>
      )}
      {combined ? (
        <Pane sarResult={sarResult} mode="combined" scaleMode={scaleMode} dynRange={dynRange} colormap={colormap} detection={detection} activeRow={activeRow} handleEnds={handleEnds} />
      ) : (
        <>
          <Pane sarResult={sarResult} mode="amplitude" scaleMode={scaleMode} dynRange={dynRange} colormap={colormap} detection={detection} activeRow={activeRow} handleEnds={handleEnds} />
          <div className="h-px bg-white/8 shrink-0" />
          <Pane sarResult={sarResult} mode="coherence" scaleMode={scaleMode} dynRange={dynRange} colormap={colormap} detection={detection} activeRow={activeRow} handleEnds={handleEnds} />
        </>
      )}
    </div>
  );
}
