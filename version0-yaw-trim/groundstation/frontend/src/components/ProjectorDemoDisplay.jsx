import { useRef, useEffect } from 'react';
import { cscanLayout, layoutCellRect, layoutCellAt, canvasOffsetIn } from '@/lib/cscanGrid';
import { cellsOnLine, GRID_BACKGROUND } from '@/lib/projectorDemo';

// The Projector Demo grid. Same layout, cell snapping and to-scale placement as the
// C-scan plan view (lib/cscanGrid.js), so a calibration means the same thing in both.
//
//   editable      left-drag paints with `color` (or erases with tool 'erase'),
//                 right-drag always erases
//   colorMode     'all' every cell in its colour (unpainted cells navy, GRID_BACKGROUND);
//                 'covered' only cells flagged in `covered`, the rest dark; 'none' empty grid
//   dullUncovered with 'all', cells not in `covered` are drawn dimmed (rover mode, monitor)
//   currentCell   outlined: the cell the rover is in front of
//   projection    null or { toScale: false } fits the pane; to scale uses px/cm + Left/Top
//   chromeless    the projector's image: cells and grid lines only

const BG = '#000000';
const EMPTY_FILL = '#0d0d0d';
const EMPTY_STROKE = '#4a4a4a';
// On the wall the lines ARE the image, so they have to be bright enough to see.
const PROJECTOR_LINE = '#9a9a9a';

// Half the saturation and about half the brightness: still recognisably the colour, clearly
// not lit yet.
const dullCache = new Map();
function dullColor(hex) {
  let out = dullCache.get(hex);
  if (out) return out;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = (c) => Math.round((0.5 * c + 0.5 * lum) * 0.5);
  out = `rgb(${f(r)},${f(g)},${f(b)})`;
  dullCache.set(hex, out);
  return out;
}

function drawGridCanvas(canvas, p, hover, rect, offset, dpr) {
  const ctx = canvas.getContext('2d');
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const { grid, projection, colorMode, covered, dullUncovered, currentCell, chromeless, editable, tool, color, title, lattice } = p;
  if (!grid || w < 80 || h < 80) return null;

  const L = cscanLayout(w, h, grid, projection, offset);
  const { hCount, vCount } = grid;

  ctx.save();
  ctx.beginPath();
  ctx.rect(L.clip.x, L.clip.y, L.clip.w, L.clip.h);
  ctx.clip();

  for (let iy = 0; iy < vCount; iy++) {
    for (let ix = 0; ix < hCount; ix++) {
      const i = iy * hCount + ix;
      const base = grid.colors[i] || GRID_BACKGROUND;
      const isCovered = !!(covered && covered[i]);
      let c = null;
      if (colorMode === 'all') c = dullUncovered && !isCovered ? dullColor(base) : base;
      else if (colorMode === 'covered' && isCovered) c = base;
      const r = layoutCellRect(ix, iy, L);
      if (c) {
        ctx.fillStyle = c;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else if (!chromeless) {
        ctx.fillStyle = EMPTY_FILL;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (r.w > 3 && r.h > 3) {
          ctx.strokeStyle = EMPTY_STROKE;
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        }
      }
    }
  }

  // Projector: one continuous line per cell boundary, on the same snapped pixels the
  // cells use, so the projected lattice lands exactly where the monitor's cells do.
  if (chromeless) {
    ctx.strokeStyle = PROJECTOR_LINE;
    ctx.lineWidth = 1;
    // Boundary k is rounded exactly as layoutCellRect rounds it. The last line is pulled
    // one pixel inward so the frame stays inside the grid's own box.
    const xs = Array.from({ length: hCount + 1 }, (_, k) => Math.round(L.originX + k * L.cellW));
    const ys = Array.from({ length: vCount + 1 }, (_, k) => Math.round(L.originY - k * L.cellH));
    const line = (v, k, n) => (k === n ? v - 0.5 : v + 0.5);
    ctx.beginPath();
    xs.forEach((x, k) => {
      const xx = line(x, k, hCount);
      ctx.moveTo(xx, ys[vCount]); ctx.lineTo(xx, ys[0]);
    });
    ys.forEach((y, k) => {
      // ys runs bottom (k = 0) to top (k = vCount); the bottom edge is the one pulled up.
      const yy = k === 0 ? y - 0.5 : y + 0.5;
      ctx.moveTo(xs[0], yy); ctx.lineTo(xs[hCount], yy);
    });
    ctx.stroke();
  } else {
    // A faint lattice over painted cells, so neighbouring cells of one colour can still
    // be counted while drawing.
    if (lattice && L.cellW >= 8 && L.cellH >= 8) {
      ctx.strokeStyle = '#ffffff14';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let ix = 1; ix < hCount; ix++) {
        const x = layoutCellRect(ix, 0, L).x + 0.5;
        ctx.moveTo(x, L.originY - L.gridH); ctx.lineTo(x, L.originY);
      }
      for (let iy = 1; iy < vCount; iy++) {
        const y = layoutCellRect(0, iy, L).y + layoutCellRect(0, iy, L).h + 0.5;
        ctx.moveTo(L.originX, y); ctx.lineTo(L.originX + L.gridW, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.strokeRect(L.originX, L.originY - L.gridH, L.gridW, L.gridH);

    if (currentCell && currentCell.ix < hCount && currentCell.iy < vCount) {
      const r = layoutCellRect(currentCell.ix, currentCell.iy, L);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }

    if (editable && hover) {
      const r = layoutCellRect(hover.ix, hover.iy, L);
      ctx.strokeStyle = tool === 'erase' ? '#ffffff' : color;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }
  }
  ctx.restore();

  if (chromeless) return L;

  // Axis ticks at cell centres, thinned so labels never collide.
  ctx.font = '9px monospace';
  ctx.fillStyle = '#555555';
  ctx.textAlign = 'center';
  const xEvery = Math.max(1, Math.ceil(hCount / Math.max(1, Math.floor(L.gridW / 34))));
  for (let ix = 0; ix < hCount; ix += xEvery) {
    const r = layoutCellRect(ix, 0, L);
    const cx = r.x + r.w / 2;
    if (cx < L.clip.x || cx > L.clip.x + L.clip.w) continue;
    ctx.fillText((ix * grid.hStep).toFixed(grid.hStep % 1 === 0 ? 0 : 1), cx, L.originY + 14);
  }
  const yEvery = Math.max(1, Math.ceil(vCount / Math.max(1, Math.floor(L.gridH / 16))));
  ctx.textAlign = 'right';
  for (let iy = 0; iy < vCount; iy += yEvery) {
    const r = layoutCellRect(0, iy, L);
    const cy = r.y + r.h / 2;
    if (cy < L.clip.y || cy > L.clip.y + L.clip.h) continue;
    ctx.fillText((iy * grid.vStep).toFixed(grid.vStep % 1 === 0 ? 0 : 1),
      Math.max(6, Math.min(L.originX, L.pad.left)) - 6, cy + 3);
  }

  ctx.fillStyle = '#22d3ee';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title || 'GRID', L.pad.left, 14);
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${hCount} × ${vCount} cells`, w - L.pad.right, 14);

  if (L.toScale) {
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = L.overflows ? '#f59e0b' : '#4aff8a';
    ctx.fillText(
      `TO SCALE · ${L.scale.toFixed(2)} px/cm @ ${(L.originX + L.canvasOffset.x).toFixed(0)},`
      + `${(L.originY - L.gridH + L.canvasOffset.y).toFixed(0)} px${L.overflows ? ' · CLIPPED' : ''}`,
      L.pad.left + L.plotW / 2, 14);
  }

  if (hover) {
    const label = `(${hover.ix * grid.hStep}, ${hover.iy * grid.vStep}) cm · col ${hover.ix + 1}, row ${hover.iy + 1}`;
    ctx.fillStyle = '#888888';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, L.pad.left, h - 8);
  }
  return L;
}

export default function ProjectorDemoDisplay({
  grid, projection, editable = false, tool = 'paint', color = '#ffffff', onPaint,
  colorMode = 'all', covered = null, dullUncovered = false, currentCell = null,
  chromeless = false, rootRef, title, lattice = true,
}) {
  const canvasRef = useRef(null);
  const propsRef = useRef(null);
  propsRef.current = {
    grid, projection, editable, tool, color, colorMode, covered, dullUncovered, currentCell, chromeless, title, lattice,
  };
  const versionRef = useRef(0);
  const hoverRef = useRef(null);
  const dragRef = useRef(null); // { erase, last } while a button is held

  // Any prop change marks the image dirty; the frame loop below redraws only then, or when
  // the canvas size / position / pixel ratio changed.
  useEffect(() => { versionRef.current++; });

  useEffect(() => {
    // Frames come from the canvas's OWN window: the projector copy lives in a second
    // window, and a hidden control window's rAF is throttled.
    let win = window;
    let id = 0;
    let lastSig = '';
    const frame = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.isConnected) {
        win = canvas.ownerDocument.defaultView || window;
        const rect = canvas.getBoundingClientRect();
        const off = canvasOffsetIn(rootRef, rect);
        const dpr = win.devicePixelRatio || 1;
        const h = hoverRef.current;
        const sig = `${versionRef.current}|${rect.width}|${rect.height}|${off.x}|${off.y}|${dpr}|${h ? `${h.ix},${h.iy}` : ''}`;
        if (sig !== lastSig) {
          lastSig = sig;
          drawGridCanvas(canvas, propsRef.current, h, rect, off, dpr);
        }
      }
      if (win.closed) return;
      id = win.requestAnimationFrame(frame);
    };
    id = win.requestAnimationFrame(frame);
    return () => { if (!win.closed) win.cancelAnimationFrame(id); };
  }, [rootRef]);

  const pick = (e) => {
    const g = propsRef.current.grid;
    if (!g) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const L = cscanLayout(rect.width, rect.height, g, propsRef.current.projection, canvasOffsetIn(rootRef, rect));
    return layoutCellAt(e.clientX - rect.left, e.clientY - rect.top, L, g.hCount, g.vCount);
  };

  const paint = (cells, erase) => {
    if (onPaint && cells.length) onPaint(cells, erase ? null : propsRef.current.color);
  };

  if (chromeless) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#000' }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${editable ? 'cursor-crosshair' : ''}`}
      style={editable ? { touchAction: 'none' } : undefined}
      onContextMenu={(e) => { if (editable) e.preventDefault(); }}
      onPointerDown={(e) => {
        if (!editable || (e.button !== 0 && e.button !== 2)) return;
        const cell = pick(e);
        const erase = e.button === 2 || propsRef.current.tool === 'erase';
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { erase, last: cell };
        if (cell) paint([cell], erase);
      }}
      onPointerMove={(e) => {
        const cell = pick(e);
        hoverRef.current = cell;
        const d = dragRef.current;
        if (!d) return;
        if (!cell) { d.last = null; return; }
        if (d.last && d.last.ix === cell.ix && d.last.iy === cell.iy) return;
        paint(d.last ? cellsOnLine(d.last, cell) : [cell], d.erase);
        d.last = cell;
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      onPointerLeave={() => { if (!dragRef.current) hoverRef.current = null; }}
    />
  );
}
