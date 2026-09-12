import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { prepare, renderEffect, colormapFn, hsvToRgb } from '@/lib/imagingEffects';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const ACCENT = '#D1855C';
const BLUE = '#6B9BD2';
const MUTED = '#555555';
const DIM = '#444444';

/**
 * Imaging Bench viewport. All signal processing lives in lib/imagingEffects;
 * this component memoizes it and draws the result. Effects come back tagged
 * with a `kind` and their own axis metadata, so the axes follow the effect
 * rather than being hard-coded to the waterfall's range/sweep pair.
 */
export default function ImagingDisplay({ snapshot, effect, params }) {
  const canvasRef = useRef(null);
  const offRef = useRef(null);
  const animRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  // The IFFTs. Everything downstream reuses this, so switching effects or
  // dragging an effect slider never redoes them.
  const prep = useMemo(
    () => (snapshot ? prepare(snapshot, params.profile) : null),
    [snapshot, params.profile],
  );

  // "Latest" is resolved here rather than written back into panel state, so the
  // selector keeps whatever sweep it was pinned to when the box is unticked.
  const effParams = useMemo(() => (
    snapshot && params.view.followLatest
      ? { ...params, view: { ...params.view, sweepIndex: snapshot.sweeps.length - 1 } }
      : params
  ), [snapshot, params]);

  // Effects are cheap next to prepare(), but dispersion is not — memoizing on
  // the params object keeps a slider drag at one recompute per change rather
  // than one per animation frame.
  const result = useMemo(
    () => (snapshot && prep ? renderEffect(snapshot, effect, effParams, prep) : null),
    [snapshot, prep, effect, effParams],
  );

  const cmap = useMemo(
    () => colormapFn(params.colormap.name, params.colormap),
    [params.colormap],
  );
  const cmapFor = useCallback(
    (name) => (name ? colormapFn(name, params.colormap) : cmap),
    [cmap, params.colormap],
  );

  // Reusable offscreen buffer — one putImageData plus a scaled drawImage beats
  // tens of thousands of fillRects per frame.
  const getOffscreen = (w, h) => {
    if (!offRef.current) offRef.current = document.createElement('canvas');
    const c = offRef.current;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    if (!snapshot) {
      centreText(ctx, w, h, 'No snapshot — import a waterfall export');
      return;
    }
    if (!result) {
      centreText(ctx, w, h, 'Nothing to render');
      return;
    }

    // Title block: effect name plus its key parameters, so a screenshot of this
    // canvas explains itself with no surrounding UI.
    const notes = result.notes || [];
    ctx.fillStyle = ACCENT;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(result.title || '', 12, 16);
    if (result.subtitle) {
      const tw = ctx.measureText(result.title || '').width;
      ctx.fillStyle = BLUE;
      ctx.font = '10px monospace';
      ctx.fillText(result.subtitle, 12 + tw + 12, 16);
    }
    ctx.fillStyle = MUTED;
    ctx.font = '9px monospace';
    notes.forEach((n, i) => ctx.fillText(clipText(ctx, n, w - 24), 12, 30 + i * 11));

    if (result.kind === 'message') {
      centreText(ctx, w, h, result.message);
      return;
    }

    const top = 26 + notes.length * 11 + 8;

    if (result.kind === 'lines') {
      const lbox = { x: 56, y: top, w: w - 56 - 20, h: h - top - 36 };
      if (lbox.w < 24 || lbox.h < 24) { centreText(ctx, w, h, 'Pane too small'); return; }
      drawLines(ctx, lbox, result, crosshair);
      return;
    }

    if (result.kind === 'panes') {
      const gap = 10;
      const paneW = (w - 56 - 20 - gap * (result.panes.length - 1)) / result.panes.length;
      const paneH = h - top - 14 - 60;
      if (paneW < 24 || paneH < 24) {
        centreText(ctx, w, h, 'Pane too small — widen the window');
        return;
      }
      result.panes.forEach((pane, i) => {
        const box = { x: 56 + i * (paneW + gap), y: top + 14, w: paneW, h: paneH };
        ctx.fillStyle = pane.colormap ? BLUE : '#888888';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(pane.label.toUpperCase(), box.x, box.y - 5);
        const v = pane.v || result.v;
        drawImageRows(ctx, box, pane.rows, v, cmapFor(pane.colormap), getOffscreen);
        drawFrame(ctx, box);
        drawXAxis(ctx, box, result.x);
        if (i === 0) drawYAxis(ctx, box, result.y, result.rowFlags);
        drawHBar(ctx, { x: box.x, y: box.y + box.h + 22, w: box.w, h: 7 }, v,
          cmapFor(pane.colormap), !!pane.v);
      });
      return;
    }

    const box = { x: 56, y: top, w: w - 56 - 78, h: h - top - 36 };
    if (box.w < 20 || box.h < 20) return;

    if (result.kind === 'rgb') {
      drawImageRgb(ctx, box, result.rgb, getOffscreen);
    } else {
      drawImageRows(ctx, box, result.rows, result.v, cmap, getOffscreen);
    }
    drawFrame(ctx, box);
    drawXAxis(ctx, box, result.x);
    drawYAxis(ctx, box, result.y, result.rowFlags);

    if (result.kind === 'rgb' && result.legend === 'hue') {
      drawHueWheel(ctx, w - 78 + 6, box.y, 64, result.legendRotation || 0, params.phasehue);
    } else {
      drawVBar(ctx, { x: w - 78 + 6, y: box.y, w: 12, h: box.h }, result.v, cmap);
    }

    // dB reference inset for the compression effect.
    if (result.inset) {
      const iw = Math.min(220, box.w * 0.34);
      const ih = Math.min(140, box.h * 0.38);
      const ibox = { x: box.x + box.w - iw - 8, y: box.y + 8, w: iw, h: ih };
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(ibox.x - 4, ibox.y - 14, ibox.w + 8, ibox.h + 20);
      ctx.fillStyle = BLUE;
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(result.inset.label.toUpperCase(), ibox.x, ibox.y - 4);
      drawImageRows(ctx, ibox, result.inset.rows, result.inset.v, cmap, getOffscreen);
      drawFrame(ctx, ibox);
    }

    drawCrosshair(ctx, box, result, crosshair);
  }, [snapshot, result, cmap, cmapFor, crosshair, params.phasehue]);

  useEffect(() => {
    const render = () => {
      draw();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full cursor-crosshair"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
      onMouseLeave={() => setCrosshair(null)}
    />
  );
}

/* ── Canvas helpers ─────────────────────────────────────────────────────── */

function centreText(ctx, w, h, text) {
  ctx.fillStyle = '#333333';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
}

function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 4 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function drawFrame(ctx, box) {
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
}

/** Scalar rows -> colour-mapped image. rows[0] is the oldest and sits at the bottom. */
function drawImageRows(ctx, box, rows, v, cmap, getOffscreen) {
  const ny = rows.length;
  const nx = rows[0].length;
  const off = getOffscreen(nx, ny);
  const octx = off.getContext('2d');
  const img = octx.createImageData(nx, ny);
  const span = (v.max - v.min) || 1;

  for (let r = 0; r < ny; r++) {
    const row = rows[r];
    const y = ny - 1 - r;               // row 0 at the bottom
    for (let c = 0; c < nx; c++) {
      const o = (y * nx + c) * 4;
      const val = row[c];
      if (!Number.isFinite(val)) {
        // Undefined cells (short coherence windows, masked bins) read as a dark
        // grey that no colormap produces, so they are never mistaken for data.
        img.data[o] = 26; img.data[o + 1] = 26; img.data[o + 2] = 30; img.data[o + 3] = 255;
        continue;
      }
      const [rr, gg, bb] = cmap((val - v.min) / span);
      img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, box.x, box.y, box.w, box.h);
  ctx.imageSmoothingEnabled = true;
}

/** Pre-coloured RGB rows (the phase-as-hue effect). */
function drawImageRgb(ctx, box, rgbRows, getOffscreen) {
  const ny = rgbRows.length;
  const nx = rgbRows[0].length / 3;
  const off = getOffscreen(nx, ny);
  const octx = off.getContext('2d');
  const img = octx.createImageData(nx, ny);
  for (let r = 0; r < ny; r++) {
    const px = rgbRows[r];
    const y = ny - 1 - r;
    for (let c = 0; c < nx; c++) {
      const o = (y * nx + c) * 4;
      img.data[o] = px[c * 3];
      img.data[o + 1] = px[c * 3 + 1];
      img.data[o + 2] = px[c * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, box.x, box.y, box.w, box.h);
  ctx.imageSmoothingEnabled = true;
}

function axisFormat(axis, value) {
  const d = axis.decimals != null ? axis.decimals : (axis.unit === 'm' ? 2 : 0);
  return `${value.toFixed(d)}${axis.unit ? ' ' + axis.unit : ''}`;
}

function drawXAxis(ctx, box, axis) {
  // Tick count follows the pane width — six of them inside a 230 px colormap
  // comparison pane just overprint each other.
  const ticks = Math.max(2, Math.min(6, Math.floor(box.w / 95)));
  ctx.font = '9px monospace';
  for (let i = 0; i <= ticks; i++) {
    const frac = i / ticks;
    const x = box.x + frac * box.w;
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    // The end labels are aligned inwards so they cannot run under the colour
    // bar on the right or off the canvas on the left.
    ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
    ctx.fillText(axisFormat(axis, axis.min + frac * (axis.max - axis.min)), x, box.y + box.h + 14);
  }
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText(axis.label, box.x + box.w / 2, box.y + box.h + 28);
}

function drawYAxis(ctx, box, axis, rowFlags) {
  const ticks = 5;
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const frac = i / ticks;
    const y = box.y + box.h - frac * box.h;    // axis.min at the bottom
    ctx.fillStyle = MUTED;
    ctx.fillText(axisFormat(axis, axis.min + frac * (axis.max - axis.min)), box.x - 8, y + 3);
  }
  ctx.save();
  ctx.translate(14, box.y + box.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText(axis.label, 0, 0);
  ctx.restore();

  // Corrupted-sweep flags from the raw-S21 residual view.
  if (rowFlags && rowFlags.length) {
    const rowH = box.h / rowFlags.length;
    ctx.fillStyle = '#ef4444';
    rowFlags.forEach((bad, r) => {
      if (!bad) return;
      ctx.fillRect(box.x - 5, box.y + box.h - (r + 1) * rowH, 3, Math.max(1.5, rowH));
    });
  }
}

/** Vertical colour bar with numeric limits, matching the live waterfall's. */
function drawVBar(ctx, bar, v, cmap) {
  for (let i = 0; i < bar.h; i++) {
    const t = 1 - i / bar.h;
    const [r, g, b] = cmap(t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(bar.x, bar.y + i, bar.w, 1);
  }
  ctx.fillStyle = v.fixed ? '#f59e0b' : MUTED;
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtLimit(v.max, v.unit), bar.x, bar.y - 4);
  ctx.fillText(fmtLimit(v.min, v.unit), bar.x, bar.y + bar.h + 10);
  ctx.save();
  ctx.translate(bar.x + bar.w + 22, bar.y + bar.h / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = DIM;
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(v.label + (v.fixed ? '  · PINNED' : ''), 0, 0);
  ctx.restore();
}

/** Horizontal colour bar, used under each pane in the multi-pane layouts. */
function drawHBar(ctx, bar, v, cmap, ownScale) {
  for (let i = 0; i < bar.w; i++) {
    const [r, g, b] = cmap(i / bar.w);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(bar.x + i, bar.y, 1, bar.h);
  }
  ctx.font = '8px monospace';
  ctx.fillStyle = ownScale ? '#f59e0b' : MUTED;
  ctx.textAlign = 'left';
  ctx.fillText(fmtLimit(v.min, v.unit), bar.x, bar.y + bar.h + 9);
  ctx.textAlign = 'right';
  ctx.fillText(fmtLimit(v.max, v.unit), bar.x + bar.w, bar.y + bar.h + 9);
  if (ownScale) {
    ctx.textAlign = 'center';
    ctx.fillText('OWN SCALE', bar.x + bar.w / 2, bar.y + bar.h + 9);
  }
}

function fmtLimit(value, unit) {
  const abs = Math.abs(value);
  const s = (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) ? value.toExponential(1) : value.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

/** Circular hue legend for phase-as-hue — a linear bar would misread a wrap. */
function drawHueWheel(ctx, x, y, size, rotation, ph) {
  const cx = x + size / 2;
  const cy = y + size / 2 + 10;
  const rOuter = size / 2 - 2;
  const rInner = rOuter * 0.55;
  for (let deg = 0; deg < 360; deg += 2) {
    // Screen angle rises anticlockwise so it matches atan2's sense.
    const a0 = -(deg + rotation) * Math.PI / 180;
    const a1 = -(deg + 2 + rotation) * Math.PI / 180;
    const [r, g, b] = hsvToRgb(deg, ph ? ph.saturation : 1, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, a1, a0);
    ctx.arc(cx, cy, rInner, a0, a1, true);
    ctx.closePath();
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill();
  }
  ctx.fillStyle = MUTED;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PHASE', cx, y + 4);
  const labels = [[0, '0°'], [90, '90'], [180, '180'], [270, '-90']];
  for (const [deg, text] of labels) {
    const a = -(deg + rotation) * Math.PI / 180;
    ctx.fillStyle = '#777777';
    ctx.fillText(text, cx + Math.cos(a) * (rOuter + 9), cy - Math.sin(a) * (rOuter + 9) + 3);
  }
}

/* ── Line plot (raw S21, single sweep) ──────────────────────────────────── */

function drawLines(ctx, box, result, crosshair) {
  let yMin = Infinity, yMax = -Infinity;
  for (const s of result.series) {
    for (let i = 0; i < s.y.length; i++) {
      if (!Number.isFinite(s.y[i])) continue;
      if (s.y[i] < yMin) yMin = s.y[i];
      if (s.y[i] > yMax) yMax = s.y[i];
    }
  }
  if (result.guides) for (const g of result.guides) {
    if (g.value < yMin) yMin = g.value;
    if (g.value > yMax) yMax = g.value;
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  const margin = (yMax - yMin) * 0.08 || 1;
  yMin -= margin; yMax += margin;

  const xs = result.xs;
  const n = xs.length;
  const toX = (i) => box.x + (i / (n - 1)) * box.w;
  const toY = (v) => box.y + ((yMax - v) / (yMax - yMin)) * box.h;

  // Grid + Y labels
  ctx.font = '9px monospace';
  for (let i = 0; i <= 5; i++) {
    const y = box.y + (i / 5) * box.h;
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText((yMax - (i / 5) * (yMax - yMin)).toFixed(2), box.x - 8, y + 3);
  }
  drawXAxis(ctx, box, result.x);
  drawFrame(ctx, box);

  ctx.save();
  ctx.translate(14, box.y + box.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText(`${result.yAxis.label}${result.yAxis.unit ? ` (${result.yAxis.unit})` : ''}`, 0, 0);
  ctx.restore();

  // Guides (the 0.3 rad coherence limit)
  if (result.guides) {
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (const g of result.guides) {
      ctx.strokeStyle = g.color;
      ctx.beginPath();
      ctx.moveTo(box.x, toY(g.value));
      ctx.lineTo(box.x + box.w, toY(g.value));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Traces
  result.series.forEach((s, si) => {
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const y = Math.max(box.y, Math.min(box.y + box.h, toY(s.y[i])));
      if (i === 0) ctx.moveTo(toX(i), y);
      else ctx.lineTo(toX(i), y);
    }
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(s.label, box.x + box.w - 6, box.y + 12 + si * 12);
  });

  if (result.alert) {
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('● SWEEP EXCEEDS 0.3 rad — LIKELY CORRUPTED', box.x + 8, box.y + 14);
  }

  if (crosshair && crosshair.x >= box.x && crosshair.x <= box.x + box.w) {
    const i = Math.max(0, Math.min(n - 1, Math.round(((crosshair.x - box.x) / box.w) * (n - 1))));
    const cx = toX(i);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#ffffff44';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, box.y);
    ctx.lineTo(cx, box.y + box.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = cx > box.x + box.w * 0.7 ? 'right' : 'left';
    const vals = result.series.map(s => s.y[i].toFixed(3)).join(' / ');
    ctx.fillText(
      `${axisFormat(result.x, xs[i])}   ${vals}`,
      cx + (cx > box.x + box.w * 0.7 ? -8 : 8),
      box.y + box.h - 8,
    );
  }
}

/* ── Crosshair readout for image kinds ──────────────────────────────────── */

function drawCrosshair(ctx, box, result, crosshair) {
  if (!crosshair) return;
  const { x, y } = crosshair;
  if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) return;

  const rows = result.rows || result.rgb;
  if (!rows || rows.length === 0) return;
  const ny = rows.length;
  const nx = result.rows ? result.rows[0].length : result.rgb[0].length / 3;

  const col = Math.max(0, Math.min(nx - 1, Math.floor(((x - box.x) / box.w) * nx)));
  const rowFromTop = Math.max(0, Math.min(ny - 1, Math.floor(((y - box.y) / box.h) * ny)));
  const row = ny - 1 - rowFromTop;

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#ffffff44';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(x, box.y);
  ctx.lineTo(x, box.y + box.h);
  ctx.moveTo(box.x, y);
  ctx.lineTo(box.x + box.w, y);
  ctx.stroke();
  ctx.setLineDash([]);

  const xVal = result.x.min + (col / Math.max(1, nx - 1)) * (result.x.max - result.x.min);
  const yVal = result.y.min + (row / Math.max(1, ny - 1)) * (result.y.max - result.y.min);
  let label = `${axisFormat(result.x, xVal)}   ${axisFormat(result.y, yVal)}`;
  if (result.rows) {
    const v = result.rows[row][col];
    label += `   ${Number.isFinite(v) ? fmtLimit(v, result.v.unit) : 'undefined'}`;
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '10px monospace';
  ctx.textAlign = x > box.x + box.w * 0.6 ? 'right' : 'left';
  ctx.fillText(label, x + (x > box.x + box.w * 0.6 ? -8 : 8), Math.max(box.y + 12, y - 6));
}
