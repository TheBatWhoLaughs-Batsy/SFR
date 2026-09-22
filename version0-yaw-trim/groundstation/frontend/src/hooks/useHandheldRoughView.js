import { useCallback, useMemo, useState } from 'react';
import { applyBscanBg, modelSpan } from '@/lib/bscanBg';
import { bgDiagnostics, computeGridScales, computeRowScales, computeSharedScale, planViewScales } from '@/lib/cscanGrid';

// Handheld Capture panel, rough output view: a quick look at a patch while it is being scanned.
//
// It takes the FIRST sweep placed in each cell (useHandheldCapture's `rough`), subtracts a
// background model at that sweep's own standoff, and draws the result as a C-scan plan view.
// Every step is the C-scan panel's own code -- applyBscanBg for the subtraction and range
// profile, computeCellValues (via CscanDisplay / computeGridScales) for gate, metric and
// focusing, planViewScales for the colour limits -- so the rough view and a C-scan of the same
// cells cannot disagree. Nothing here touches the recording: it is a display of a subset.
//
// Everything is computed only while the rough view is showing.

const VIEW_KEY = 'handheld_capture_view_v1';
const SETTINGS_KEY = 'handheld_capture_rough_v1';

export const ROUGH_DEFAULTS = {
  bgApplied: true,
  subMode: 'complex',
  windowType: 'rectangular',
  kaiserBeta: 3,
  gateStart: 2,
  gateEnd: 70,
  metric: 'peak',
  focusEnabled: false,
  focusAperture: 7,
  focusMethod: 'saft',
  focusGamma: 1.0,
  scaleMode: 'linear',
  scaleRange: { dynamic: true, min: -90, max: -20 },
  scaleLink: 'linked',
  colormap: 'jet',
  smooth: false,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (s && typeof s === 'object') {
      return { ...ROUGH_DEFAULTS, ...s, scaleRange: { ...ROUGH_DEFAULTS.scaleRange, ...(s.scaleRange || {}) } };
    }
  } catch { /* defaults */ }
  return { ...ROUGH_DEFAULTS };
}

export default function useHandheldRoughView({ rough, sfcwParams }) {
  const [view, setViewState] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'rough' ? 'rough' : 'status'; } catch { return 'status'; }
  });
  const [settings, setSettings] = useState(loadSettings);
  // Not persisted: a model is a file the operator picks for this site.
  const [bgModel, setBgModel] = useState(null);

  const setView = useCallback((v) => {
    const next = v === 'rough' ? 'rough' : 'status';
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* session only */ }
  }, []);
  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* session only */ }
      return next;
    });
  }, []);

  const showing = view === 'rough';
  const data = rough?.data || [];
  const grid = rough?.grid || null;
  const { bgApplied, subMode, windowType, kaiserBeta } = settings;
  const startFreq = sfcwParams?.startFreq;
  const stopFreq = sfcwParams?.stopFreq;

  const processed = useMemo(() => (showing
    ? applyBscanBg(data, {
      enabled: bgApplied && !!bgModel, bgModel, mode: subMode, windowType, kaiserBeta, avgMode: 'coherent',
    }, { startFreq, stopFreq })
    : []), [showing, data, bgApplied, bgModel, subMode, windowType, kaiserBeta, startFreq, stopFreq]);

  const params = useMemo(() => (grid ? {
    ...grid,
    gateStart: settings.gateStart,
    gateEnd: settings.gateEnd,
    metric: settings.metric,
    focusEnabled: settings.focusEnabled,
    focusAperture: settings.focusAperture,
    focusMethod: settings.focusMethod,
    focusGamma: settings.focusGamma,
    windowType,
    kaiserBeta,
    startFreqHz: (startFreq || 2000) * 1e6,
    scanMode: 'manual',
  } : null), [grid, settings.gateStart, settings.gateEnd, settings.metric, settings.focusEnabled,
    settings.focusAperture, settings.focusMethod, settings.focusGamma, windowType, kaiserBeta, startFreq]);

  const sharedScale = useMemo(() => computeSharedScale(processed), [processed]);
  const rowScales = useMemo(() => computeRowScales(processed), [processed]);
  const gridScales = useMemo(() => (params && processed.length ? computeGridScales(processed, params) : null),
    [processed, params]);
  const plan = useMemo(
    () => planViewScales(settings.scaleLink, gridScales, sharedScale, rowScales, settings.focusEnabled),
    [settings.scaleLink, gridScales, sharedScale, rowScales, settings.focusEnabled],
  );
  const diag = useMemo(() => bgDiagnostics(processed), [processed]);

  // How deep the record goes, read off a profile, bounds the gate sliders.
  const depthLimitCm = useMemo(() => {
    const d = processed.find((p) => Array.isArray(p.distances) && p.distances.length)?.distances;
    return d ? Math.floor(d[d.length - 1] * 100) : 70;
  }, [processed]);

  const standoffs = useMemo(() => {
    const v = data.map((p) => p.lidar_standoff_mm).filter(Number.isFinite);
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), missing: data.length - v.length };
  }, [data]);

  return {
    view, setView, settings, update, bgModel, setBgModel,
    processed, params, plan, diag, depthLimitCm, standoffs,
    modelSpan: modelSpan(bgModel),
    cells: data.length,
    grid,
  };
}
