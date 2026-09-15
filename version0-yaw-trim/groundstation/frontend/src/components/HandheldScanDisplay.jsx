import { useRef, useEffect, useMemo } from 'react';
import { buildCscanGrid, computeSharedScale } from '@/lib/cscanGrid';
import { cellForPosition, filledCells, nextEmptyCell } from '@/lib/handheldScan';

// The magma-ish ramp the C-scan uses, trimmed to what we need here. A filled
// cell is coloured by its gated value; everything else is chrome.
function colorFor(t) {
  // t in [0,1] -> dark purple .. bright yellow
  const stops = [
    [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99],
    [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

const PAD = { top: 20, bottom: 34, left: 44, right: 20 };

function draw(canvas, scanData, params, pose, opts, grid, shared) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const hCount = Math.max(1, params.hCount);
  const vCount = Math.max(1, params.vCount);
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  // Physical aspect ratio preserved: a 10x5 grid of square cells looks like one.
  const spanX = hCount * params.hStep;
  const spanY = vCount * params.vStep;
  const scale = Math.min(plotW / spanX, plotH / spanY);
  const gridW = spanX * scale;
  const gridH = spanY * scale;
  const originX = PAD.left + (plotW - gridW) / 2;
  const originYbottom = PAD.top + (plotH + gridH) / 2; // iy=0 sits at the bottom
  const cellW = params.hStep * scale;
  const cellH = params.vStep * scale;

  const rect = (ix, iy) => ({
    x: originX + ix * cellW,
    y: originYbottom - (iy + 1) * cellH,
    w: cellW,
    h: cellH,
  });

  // Filled cells, coloured by value. `grid` and `shared` are memoised by the
  // component: the pose updates ~50 times a second and neither depends on it.
  const lo = shared?.min ?? 0;
  const hi = shared?.max ?? 1;
  const span = hi - lo || 1;
  for (let iy = 0; iy < vCount; iy++) {
    for (let ix = 0; ix < hCount; ix++) {
      const r = rect(ix, iy);
      const cell = grid.cells[iy * hCount + ix];
      if (cell && Number.isFinite(cell.value)) {
        ctx.fillStyle = colorFor((cell.value - lo) / span);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else if (cell && cell.invalid) {
        ctx.fillStyle = 'rgba(255,80,80,0.15)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.strokeStyle = '#242424';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }

  // Next-empty suggestion, dashed cyan.
  const filled = filledCells(scanData);
  const next = nextEmptyCell(filled, params);
  if (next) {
    const r = rect(next.ix, next.iy);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Grid frame.
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.strokeRect(originX, originYbottom - gridH, gridW, gridH);

  // Axis labels (cm).
  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${(spanX).toFixed(0)} cm`, originX + gridW / 2, originYbottom + 22);
  ctx.save();
  ctx.translate(originX - 30, originYbottom - gridH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${(spanY).toFixed(0)} cm`, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillText('origin', originX - 2, originYbottom + 12);

  // Live head position marker.
  const x = pose?.pos?.x;
  const y = pose?.pos?.y;
  if (x != null && y != null) {
    const px = originX + (x / 10) * scale;               // x is mm, grid is cm
    const py = originYbottom - (y / 10) * scale;
    const inside = px >= originX - 2 && px <= originX + gridW + 2
      && py >= originYbottom - gridH - 2 && py <= originYbottom + 2;
    const over = cellForPosition(x, y, params);
    // Highlight the cell under the head.
    if (over) {
      const r = rect(over.ix, over.iy);
      ctx.strokeStyle = opts.ready ? '#4aff8a' : '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }
    // The crosshair, clamped to the canvas so an off-grid head still shows a
    // direction rather than vanishing.
    const cx = Math.max(originX - 12, Math.min(originX + gridW + 12, px));
    const cy = Math.max(originYbottom - gridH - 12, Math.min(originYbottom + 12, py));
    ctx.strokeStyle = inside ? (opts.ready ? '#4aff8a' : '#22d3ee') : '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
    ctx.stroke();
    ctx.fillStyle = inside ? (opts.ready ? '#4aff8a' : '#22d3ee') : '#f59e0b';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default function HandheldScanDisplay({ scanData, params, pose, ready }) {
  const canvasRef = useRef(null);
  const grid = useMemo(() => buildCscanGrid(scanData, params), [scanData, params]);
  const shared = useMemo(() => computeSharedScale(scanData), [scanData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    draw(canvas, scanData, params, pose, { ready }, grid, shared);
  });

  return (
    <div className="w-full h-full flex flex-col bg-black">
      <canvas ref={canvasRef} className="flex-1 w-full h-full" />
    </div>
  );
}
