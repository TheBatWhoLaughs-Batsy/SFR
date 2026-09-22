import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  parseGrid, serializeGrid, DEFAULT_GRID, PROJECTOR_DEMO_FILE_TYPE, PROJECTOR_DEMO_FILE_VERSION,
} from '@/lib/projectorDemo';
import {
  emptyRadarDoc, resizeRadarDoc, paintRadarDoc, renderRadarLook, radarDocToFile, radarDocFromFile,
  normalizeLook, newSeed, DEFAULT_LOOK,
} from '@/lib/radarLook';

// State for the Projector Demo panel. Lives in App (via this hook) rather than in the
// panel or the viewport, so switching to another panel does not tear down a projector
// window that is lighting the wall -- same reason as the C-scan's projector.
//
// Three modes. Draw edits a "radar look" drawing: pipe and seepage layers plus a noise seed and
// look settings (lib/radarLook.js), shown as its rendered viridis image. Rover and Handheld each
// hold a grid loaded from a file and reveal it; they share one projection calibration, because
// scale and placement are properties of the projector and the rig, not of the pattern.

// v2: the drawing became pipe/seepage layers. A v1 colour drawing is not carried over.
const DRAW_KEY = 'projector_demo_draw_v2';
const MODES = ['draw', 'rover', 'handheld'];
export const BRUSH_TOOLS = ['pipe', 'seepage', 'erase'];
export const BRUSH_SIZE = { min: 0, max: 10, dflt: 2 };
export const BRUSH_STRENGTH = { min: 0.05, max: 1, step: 0.05, dflt: 1 };

function loadDrawDoc() {
  try {
    const raw = localStorage.getItem(DRAW_KEY);
    if (raw) {
      const parsed = parseGrid(JSON.parse(raw));
      if (parsed.grid && parsed.radar) {
        const { doc } = radarDocFromFile(parsed.radar, parsed.grid);
        if (doc) return doc;
      }
    }
  } catch { /* unreadable storage: start empty */ }
  return emptyRadarDoc(DEFAULT_GRID);
}

function loadNum(key, dflt, min, max) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

function loadProjection() {
  // Seeded from the C-scan's calibration the first time, since it is usually the same
  // projector on the same rig.
  const num = (k, fallbackKey, dflt) => {
    let v = parseFloat(localStorage.getItem(k));
    if (!Number.isFinite(v)) v = parseFloat(localStorage.getItem(fallbackKey));
    return Number.isFinite(v) ? v : dflt;
  };
  const px = num('projdemo_px_per_cm', 'cscan_px_per_cm', 8);
  return {
    toScale: localStorage.getItem('projdemo_to_scale') === 'true',
    pxPerCm: px > 0 ? px : 8,
    leftPx: num('projdemo_left_px', 'cscan_left_px', 60),
    topPx: num('projdemo_top_px', 'cscan_top_px', 80),
  };
}

export default function useProjectorDemo() {
  // Always opens in Draw. Rover mode needs the rover link and Handheld mode needs all three
  // LiDARs, and neither exists yet when the page loads.
  const [mode, setModeState] = useState('draw');

  const [drawDoc, setDrawDoc] = useState(loadDrawDoc);
  // What Draw shows, and exactly what Export writes as cell colours.
  const drawGrid = useMemo(() => renderRadarLook(drawDoc), [drawDoc]);
  // { rover: { grid, name } | null, handheld: ... }. Session only; the file is the source.
  const [patterns, setPatterns] = useState({ rover: null, handheld: null });

  const [tool, setToolState] = useState('pipe');
  const [strength, setStrengthState] = useState(() => loadNum(
    'projdemo_brush_strength', BRUSH_STRENGTH.dflt, BRUSH_STRENGTH.min, BRUSH_STRENGTH.max));
  const [brushSize, setBrushSizeState] = useState(() => loadNum(
    'projdemo_brush_size', BRUSH_SIZE.dflt, BRUSH_SIZE.min, BRUSH_SIZE.max));
  // Painting reads the brush through a ref: the display calls back during a drag, and a
  // stroke must use the brush as it is now, not as it was when the callback was created.
  const brushRef = useRef(null);
  brushRef.current = { tool, strength, brushSize };

  const [projection, setProjectionState] = useState(loadProjection);
  // null = closed; { target } open; { error: 'blocked' } when the popup was refused.
  const [projector, setProjector] = useState(null);
  const projectorRootRef = useRef(null);

  // One projector window for all three modes: it follows the mode, so switching keeps it open.
  const setMode = useCallback((m) => {
    if (!MODES.includes(m)) return;
    setModeState(m);
  }, []);

  // Persist the drawing's layers (not its rendered colours, which re-render identically),
  // debounced so a drag does not serialise on every cell.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAW_KEY, JSON.stringify({
          version: PROJECTOR_DEMO_FILE_VERSION,
          type: PROJECTOR_DEMO_FILE_TYPE,
          grid: { hCount: drawDoc.hCount, hStep: drawDoc.hStep, vCount: drawDoc.vCount, vStep: drawDoc.vStep },
          cells: [],
          radar: radarDocToFile(drawDoc),
        }));
      } catch { /* quota */ }
    }, 400);
    return () => clearTimeout(t);
  }, [drawDoc]);

  const setDrawGridParams = useCallback((params) => setDrawDoc(d => resizeRadarDoc(d, params)), []);
  // `value` null erases (right-drag, or the Erase tool); anything else paints with the tool.
  const paintDraw = useCallback((cells, value) => {
    const b = brushRef.current;
    const t = value == null ? 'erase' : b.tool;
    setDrawDoc(d => paintRadarDoc(d, cells, t, b.strength, b.brushSize));
  }, []);
  const clearDraw = useCallback(() => setDrawDoc(d => emptyRadarDoc(d, d.seed, d.look)), []);
  const loadDraw = useCallback((doc) => setDrawDoc(doc), []);
  const setLook = useCallback(
    (partial) => setDrawDoc(d => ({ ...d, look: normalizeLook({ ...d.look, ...partial }) })), []);
  const resetLook = useCallback(() => setDrawDoc(d => ({ ...d, look: { ...DEFAULT_LOOK } })), []);
  const reseed = useCallback(() => setDrawDoc(d => ({ ...d, seed: newSeed() })), []);
  // The export file: every cell's rendered colour (what Rover and Handheld show) plus the layers.
  const makeDrawFile = useCallback(
    () => serializeGrid(drawGrid, radarDocToFile(drawDoc)), [drawGrid, drawDoc]);

  const setTool = useCallback((t) => { if (BRUSH_TOOLS.includes(t)) setToolState(t); }, []);
  const setStrength = useCallback((v) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(BRUSH_STRENGTH.max, Math.max(BRUSH_STRENGTH.min, v));
    localStorage.setItem('projdemo_brush_strength', String(c));
    setStrengthState(c);
  }, []);
  const setBrushSize = useCallback((v) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(BRUSH_SIZE.max, Math.max(BRUSH_SIZE.min, Math.round(v)));
    localStorage.setItem('projdemo_brush_size', String(c));
    setBrushSizeState(c);
  }, []);

  const loadPattern = useCallback((m, grid, name) => {
    setPatterns(p => ({ ...p, [m]: { grid, name } }));
  }, []);
  const clearPattern = useCallback((m) => setPatterns(p => ({ ...p, [m]: null })), []);

  // Value or updater, composed through a ref so a burst of relative nudges adds up
  // (see the C-scan's setCscanProjection for the measured failure this avoids).
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const setProjection = useCallback((next) => {
    const v = typeof next === 'function' ? next(projectionRef.current) : next;
    projectionRef.current = v;
    localStorage.setItem('projdemo_to_scale', String(!!v.toScale));
    localStorage.setItem('projdemo_px_per_cm', String(v.pxPerCm));
    localStorage.setItem('projdemo_left_px', String(v.leftPx));
    localStorage.setItem('projdemo_top_px', String(v.topPx));
    setProjectionState(v);
  }, []);

  const activeGrid = mode === 'draw' ? drawGrid : (patterns[mode] ? patterns[mode].grid : null);

  return {
    mode, setMode,
    drawDoc, drawGrid, setDrawGridParams, paintDraw, clearDraw, loadDraw,
    setLook, resetLook, reseed, makeDrawFile,
    patterns, loadPattern, clearPattern,
    tool, setTool, strength, setStrength, brushSize, setBrushSize,
    projection, setProjection,
    projector, setProjector, projectorRootRef,
    activeGrid,
  };
}
