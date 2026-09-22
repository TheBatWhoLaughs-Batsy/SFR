import { useEffect, useRef } from 'react';
import { cscanLayout, layoutCellRect } from '@/lib/cscanGrid';
import { cellAtCornerOffsetMm } from '@/lib/handheldCapture';

// Handheld Capture coverage map: which cells of the patch have sweeps, and how many.
//
//   no sweeps          dark, outlined
//   1 .. minSweeps-1   amber ("thin"), brighter with more sweeps
//   >= minSweeps       green, brighter with more sweeps (log scale, saturating at 8x minSweeps)
//
// The cell under the module is outlined in white and its position is a cyan dot (a hollow
// dot while paused). Both come from `livePosRef`, the capture's own measurement-timed position
// (useHandheldCapture), read every frame -- the same position the counts are placed by. Counts are sweeps PLACED in each cell while playing (display only: nothing
// is averaged or discarded, every sweep is recorded raw). They are read from `countsRef` on each
// redraw rather than taken as a prop, so React never diffs them; `version` says when they changed.

const BG = '#000000';
const EMPTY_FILL = '#0d0d0d';
const EMPTY_STROKE = '#3a3a3a';

function fillFor(count, min) {
  if (count >= min) {
    const f = Math.min(1, Math.log(count / min + 1) / Math.log(9));
    const l = 28 + 30 * f;
    return `hsl(142 70% ${l}%)`;
  }
  const f = min > 1 ? (count - 1) / (min - 1) : 1;
  return `hsl(38 92% ${22 + 20 * f}%)`;
}

function draw(canvas, p, pos, rect, dpr) {
  const ctx = canvas.getContext('2d');
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const { grid, countsRef, minSweeps, playing, active, title } = p;
  const currentCell = pos ? cellAtCornerOffsetMm(pos.x, pos.y, grid) : null;
  if (!grid || w < 80 || h < 80) return;

  const L = cscanLayout(w, h, grid, null);
  const { hCount, vCount } = grid;
  const cov = countsRef?.current;
  // Counts only mean something for the grid they were captured on.
  const counts = cov && cov.counts && cov.grid.hCount === hCount && cov.grid.vCount === vCount ? cov.counts : null;

  let max = 0;
  for (let iy = 0; iy < vCount; iy++) {
    for (let ix = 0; ix < hCount; ix++) {
      const i = iy * hCount + ix;
      const n = counts ? counts[i] : 0;
      if (n > max) max = n;
      const r = layoutCellRect(ix, iy, L);
      if (n > 0) {
        ctx.fillStyle = fillFor(n, minSweeps);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = EMPTY_FILL;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (r.w > 3 && r.h > 3) {
          ctx.strokeStyle = EMPTY_STROKE;
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        }
      }
      if (n > 0 && r.w >= 22 && r.h >= 14) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(n), r.x + r.w / 2, r.y + r.h / 2 + 3);
      }
    }
  }
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.strokeRect(L.originX, L.originY - L.gridH, L.gridW, L.gridH);

  // The origin: the patch's top-left corner.
  ctx.strokeStyle = '#D1855C';
  ctx.lineWidth = 2;
  const ox = L.originX;
  const oy = L.originY - L.gridH;
  ctx.beginPath();
  ctx.moveTo(ox, oy + 14); ctx.lineTo(ox, oy); ctx.lineTo(ox + 14, oy);
  ctx.stroke();

  if (currentCell) {
    const r = layoutCellRect(currentCell.ix, currentCell.iy, L);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }

  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const px = L.originX + (pos.x / (grid.hStep * 10)) * L.cellW;
    const py = oy + (-pos.y / (grid.vStep * 10)) * L.cellH;
    // Clamped to the pane so an off-patch module still shows which way the patch is.
    const cx = Math.max(4, Math.min(w - 4, px));
    const cy = Math.max(4, Math.min(h - 4, py));
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
    if (active && playing) {
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
    } else {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Axis ticks: cm from the top-left corner, cell edges.
  ctx.font = '9px monospace';
  ctx.fillStyle = '#555555';
  ctx.textAlign = 'center';
  const xEvery = Math.max(1, Math.ceil(hCount / Math.max(1, Math.floor(L.gridW / 34))));
  for (let ix = 0; ix <= hCount; ix += xEvery) {
    ctx.fillText((ix * grid.hStep).toFixed(grid.hStep % 1 === 0 ? 0 : 1), L.originX + ix * L.cellW, L.originY + 14);
  }
  const yEvery = Math.max(1, Math.ceil(vCount / Math.max(1, Math.floor(L.gridH / 16))));
  ctx.textAlign = 'right';
  for (let k = 0; k <= vCount; k += yEvery) {
    ctx.fillText((k * grid.vStep).toFixed(grid.vStep % 1 === 0 ? 0 : 1), L.originX - 6, oy + k * L.cellH + 3);
  }

  ctx.fillStyle = '#22d3ee';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title || 'PATCH', L.pad.left, 14);
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${hCount} × ${vCount} cells · max ${max} sweeps/cell`, w - L.pad.right, 14);

  // Legend.
  const items = [
    [EMPTY_FILL, 'not scanned'],
    [fillFor(1, minSweeps), `< ${minSweeps} sweeps`],
    [fillFor(minSweeps, minSweeps), `≥ ${minSweeps} sweeps`],
  ];
  ctx.textAlign = 'left';
  let lx = L.pad.left;
  for (const [c, label] of items) {
    ctx.fillStyle = c;
    ctx.fillRect(lx, h - 14, 10, 10);
    ctx.strokeStyle = EMPTY_STROKE;
    ctx.strokeRect(lx + 0.5, h - 13.5, 9, 9);
    ctx.fillStyle = '#777777';
    ctx.fillText(label, lx + 14, h - 5);
    lx += 14 + ctx.measureText(label).width + 16;
  }
}

export default function HandheldCaptureDisplay(props) {
  const canvasRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const versionRef = useRef(0);
  useEffect(() => { versionRef.current++; });

  useEffect(() => {
    let id = 0;
    let lastSig = '';
    const frame = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.isConnected) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const pos = propsRef.current.livePosRef?.current || null;
        const sig = `${versionRef.current}|${rect.width}|${rect.height}|${dpr}|${pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)}` : ''}`;
        if (sig !== lastSig) {
          lastSig = sig;
          draw(canvas, propsRef.current, pos, rect, dpr);
        }
      }
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />;
}
