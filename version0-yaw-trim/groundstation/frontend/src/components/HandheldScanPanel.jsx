import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import {
  cellForPosition, filledCells, nextEmptyCell, scanProgress,
  captureReadiness, isFilled, READINESS_TEXT, cellCentreMm,
} from '@/lib/handheldScan';

// Once the head is ready over an empty cell, hold this long before an
// auto-capture fires. Long enough that a hand passing through a cell does not
// trigger it, short enough not to feel like waiting.
const DWELL_MS = 400;

// The radar wants the antenna within this of the wall. Same window the C-scan
// panel's standoff readout is judged against.
const STANDOFF_OK_MM = [0, 150];

function NumField({ label, value, unit, onChange, min, max, disabled }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const v = parseFloat(text);
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <div className={cn('flex flex-col gap-1 p-2 rounded-lg bg-[#0a0a0a]/50 border border-white/5',
      disabled && 'opacity-40')}>
      <span className="text-[9px] uppercase tracking-wider text-[#555]">{label}</span>
      <div className="flex items-baseline gap-1">
        <input
          value={text} disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          className="w-full bg-transparent text-sm font-mono text-white outline-none disabled:cursor-not-allowed"
          inputMode="decimal"
        />
        <span className="text-[10px] text-[#555]">{unit}</span>
      </div>
    </div>
  );
}

function SmallButton({ children, onClick, disabled, tone = 'neutral' }) {
  const tones = {
    neutral: 'border-white/10 bg-[#0d0d0d] text-[#aaa] hover:border-white/20 hover:text-white',
    danger: 'border-[#ff6a6a]/30 bg-[#ff6a6a]/5 text-[#ff6a6a] hover:bg-[#ff6a6a]/10',
    cyan: 'border-[#22d3ee]/40 bg-[#22d3ee]/10 text-[#22d3ee] hover:bg-[#22d3ee]/15',
  };
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={cn('py-2 rounded-lg border text-[11px] font-medium transition-all cursor-pointer',
        'disabled:opacity-30 disabled:cursor-not-allowed', tones[tone])}
    >{children}</button>
  );
}

// Play / pause / stop for the scan as a whole. Play arms auto-capture and makes
// sure the sweep is running; pause disarms but leaves the sweep up so resuming
// is instant; stop takes the sweep down.
function Transport({ sfcwRunning, autoCapture, sdrConnected, onStart, onPause, onStop }) {
  const running = sfcwRunning && autoCapture;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <button
        onClick={onStart} disabled={!sdrConnected || running}
        className={cn('py-2.5 rounded-xl border text-sm font-semibold transition-all cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-40',
          running ? 'border-[#4aff8a]/50 bg-[#4aff8a]/10 text-[#4aff8a]'
                  : 'border-[#4aff8a]/40 bg-[#0d0d0d] text-[#4aff8a] hover:bg-[#4aff8a]/10')}
      >▶ {running ? 'Scanning' : 'Start'}</button>
      <button
        onClick={onPause} disabled={!sfcwRunning || !autoCapture}
        className={cn('py-2.5 rounded-xl border text-sm font-semibold transition-all cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'border-[#f59e0b]/40 bg-[#0d0d0d] text-[#f59e0b] hover:bg-[#f59e0b]/10')}
      >❚❚ Pause</button>
      <button
        onClick={onStop} disabled={!sfcwRunning}
        className={cn('py-2.5 rounded-xl border text-sm font-semibold transition-all cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'border-[#ff6a6a]/40 bg-[#0d0d0d] text-[#ff6a6a] hover:bg-[#ff6a6a]/10')}
      >■ Stop</button>
    </div>
  );
}

// One tile per LiDAR head: whether it is reading, so a missing axis is obvious
// without leaving this panel.
function LidarRow({ pose }) {
  const ax = pose?.axes || {};
  const tile = (key, label) => {
    const a = ax[key];
    const st = a?.status;
    const color = st === 'live' ? 'text-[#4aff8a]' : st === 'held' ? 'text-[#f59e0b]' : 'text-[#ff6a6a]';
    const text = a?.mm != null ? `${a.mm.toFixed(0)} mm` : '—';
    return (
      <div className="flex flex-col gap-0.5 p-2 rounded-lg bg-[#0a0a0a]/50 border border-white/5">
        <span className="text-[9px] uppercase tracking-wider text-[#555]">{label}</span>
        <span className={cn('text-xs font-mono', color)}>{text}</span>
        <span className="text-[9px] text-[#555]">{st || 'absent'}</span>
      </div>
    );
  };
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {tile('x', 'Right')}{tile('y', 'Down')}{tile('z', 'Forward')}
    </div>
  );
}

function Guidance({ pose, params, filled, standoffMm }) {
  const x = pose?.pos?.x;
  const y = pose?.pos?.y;
  const has = x != null && y != null;
  const cell = has ? cellForPosition(x, y, params) : null;
  const next = nextEmptyCell(filled, params);
  const tilt = pose?.axes?.z?.tiltDeg;

  let target = null;
  if (cell && !isFilled(cell, filled)) target = cellCentreMm(cell.ix, cell.iy, params);
  else if (next) target = cellCentreMm(next.ix, next.iy, params);
  const dx = has && target ? target.x - x : null;
  const dy = has && target ? target.y - y : null;
  const arrowX = (d) => d == null ? '·' : Math.abs(d) < 8 ? '✓' : d > 0 ? '→' : '←';
  const arrowY = (d) => d == null ? '·' : Math.abs(d) < 8 ? '✓' : d > 0 ? '↑' : '↓';

  const standoffOk = standoffMm != null && standoffMm >= STANDOFF_OK_MM[0] && standoffMm <= STANDOFF_OK_MM[1];

  return (
    <div className="grid grid-cols-3 gap-1.5">
      <InfoTile label="X" value={has ? `${(x / 10).toFixed(1)} cm` : '—'} />
      <InfoTile label="Y" value={has ? `${(y / 10).toFixed(1)} cm` : '—'} />
      <InfoTile label="Cell" value={cell ? `${cell.ix + 1}, ${cell.iy + 1}` : (has ? 'outside' : '—')} />
      <InfoTile label="Aim X" value={target ? `${arrowX(dx)} ${Math.abs(dx).toFixed(0)}` : '—'} />
      <InfoTile label="Aim Y" value={target ? `${arrowY(dy)} ${Math.abs(dy).toFixed(0)}` : '—'} />
      <InfoTile label="Tilt" value={tilt == null ? '—' : `${Math.abs(tilt).toFixed(1)}°`} />
      <div className={cn('col-span-3 flex items-center justify-between px-2 py-1.5 rounded-lg border text-[10px]',
        standoffMm == null ? 'border-white/5 text-[#555]'
          : standoffOk ? 'border-[#4aff8a]/20 text-[#4aff8a]/80' : 'border-[#f59e0b]/30 text-[#f59e0b]')}>
        <span className="uppercase tracking-wider">Standoff</span>
        <span className="font-mono">
          {standoffMm == null ? '—' : `${standoffMm.toFixed(0)} mm`}
          {standoffMm != null && !standoffOk ? `  · want ${STANDOFF_OK_MM[0]}–${STANDOFF_OK_MM[1]}` : ''}
        </span>
      </div>
    </div>
  );
}

export default function HandheldScanPanel({
  isConnected, sdrConnected, sfcwRunning,
  pose, scanData, scanCapturing, captureProgress,
  params, onParamsChange,
  avgCount, onAvgCountChange,
  onStart, onPause, onStop,
  onCapture, onCaptureAt, onRecapture, onClearCell,
  onClear, onExport, onImport,
  origin, onSetOrigin, autoCapture,
  beep, onBeepChange, lastEvent,
  lidarMm, lidarOffsetMm,
}) {
  const update = (key, value) => onParamsChange({ ...params, [key]: value });

  const filled = filledCells(scanData);
  const progress = scanProgress(scanData, params);
  const readiness = captureReadiness(pose, params, filled);
  const hasOrigin = pose?.axes?.x?.originMm != null && pose?.axes?.y?.originMm != null;
  const posLive = pose?.pos?.x != null && pose?.pos?.y != null;
  const overCell = posLive ? cellForPosition(pose.pos.x, pose.pos.y, params) : null;
  const overFilled = overCell && isFilled(overCell, filled);
  const standoffMm = lidarMm != null && lidarOffsetMm != null ? lidarMm - lidarOffsetMm : null;

  // Auto-capture dwell, as a timer rather than a per-render clock so it does
  // not depend on how often the panel happens to re-render. Arms when the head
  // becomes ready over a cell; disarms if that cell or the readiness changes
  // before it fires.
  const readyKey = readiness.ready && readiness.cell ? `${readiness.cell.ix},${readiness.cell.iy}` : null;
  const armed = autoCapture && sfcwRunning && !scanCapturing && !!readyKey;
  const captureAtRef = useRef(onCaptureAt);
  captureAtRef.current = onCaptureAt;
  const readyCellRef = useRef(readiness.cell);
  readyCellRef.current = readiness.cell;
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => {
      const cell = readyCellRef.current;
      if (cell) captureAtRef.current(cell);
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [armed, readyKey]);

  // The last-event line fades on its own.
  const [eventShown, setEventShown] = useState(null);
  useEffect(() => {
    if (!lastEvent) { setEventShown(null); return undefined; }
    setEventShown(lastEvent);
    const t = setTimeout(() => setEventShown(null), 4000);
    return () => clearTimeout(t);
  }, [lastEvent]);

  const captureLabel = scanCapturing
    ? `Capturing ${captureProgress ? `${Math.min(captureProgress.got + 1, captureProgress.need)}/${captureProgress.need}` : ''}`
    : readiness.cell
      ? `Capture cell ${readiness.cell.ix + 1}, ${readiness.cell.iy + 1}`
      : 'Capture';

  return (
    <div className="flex flex-col gap-4">
      {/* Transport */}
      <Section label="Scan">
        <Transport
          sfcwRunning={sfcwRunning} autoCapture={autoCapture} sdrConnected={sdrConnected}
          onStart={onStart} onPause={onPause} onStop={onStop}
        />
        <div className="flex items-center justify-between text-[10px] text-[#555] px-1">
          <span>
            {!sdrConnected ? 'SDR not connected'
              : !sfcwRunning ? 'Sweep stopped'
              : autoCapture ? 'Sweeping · auto-capture on'
              : 'Sweeping · paused (manual capture only)'}
          </span>
          <span className="font-mono">{progress.filled}/{progress.total} cells</span>
        </div>
        {eventShown && (
          <div className={cn('px-2 py-1.5 rounded-lg border text-[10px] text-center',
            eventShown.kind === 'captured'
              ? 'border-[#4aff8a]/30 bg-[#4aff8a]/5 text-[#4aff8a]'
              : 'border-[#f59e0b]/30 bg-[#f59e0b]/5 text-[#f59e0b]')}>
            {eventShown.kind === 'captured'
              ? `Captured cell ${eventShown.cell.ix + 1}, ${eventShown.cell.iy + 1} (${eventShown.looks} looks)`
              : `Capture of ${eventShown.cell.ix + 1}, ${eventShown.cell.iy + 1} aborted — ${eventShown.why}`}
          </div>
        )}
        {progress.complete && (
          <div className="px-2 py-1.5 rounded-lg bg-[#4aff8a]/5 border border-[#4aff8a]/30 text-[10px] text-[#4aff8a] text-center">
            Grid complete — {progress.total} cells.
          </div>
        )}
      </Section>

      {/* Origin + LiDARs */}
      <Section label="Origin">
        <LidarRow pose={pose} />
        <SmallButton onClick={onSetOrigin} disabled={!pose?.axes} tone="cyan">
          Set origin here — grid bottom-left corner
        </SmallButton>
        <p className="text-[10px] leading-relaxed text-[#555]">
          Hold the head at the bottom-left corner of the area, square to the wall, and set
          the origin. {hasOrigin
            ? 'Origin set. Re-set it whenever the head is moved to a new wall.'
            : 'No origin yet — nothing can be captured until it is set.'}
        </p>
      </Section>

      {/* Grid */}
      <Section label="Grid">
        <div className="grid grid-cols-2 gap-1.5">
          <NumField label="Columns" value={params.hCount} unit="ct"
            onChange={(v) => update('hCount', Math.round(v))} min={1} max={200} />
          <NumField label="Column pitch" value={params.hStep} unit="cm"
            onChange={(v) => update('hStep', v)} min={0.5} max={50} />
          <NumField label="Rows" value={params.vCount} unit="ct"
            onChange={(v) => update('vCount', Math.round(v))} min={1} max={200} />
          <NumField label="Row pitch" value={params.vStep} unit="cm"
            onChange={(v) => update('vStep', v)} min={0.5} max={50} />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NumField label="Gate from" value={params.gateStart} unit="cm"
            onChange={(v) => update('gateStart', v)} min={0} max={500} />
          <NumField label="Gate to" value={params.gateEnd} unit="cm"
            onChange={(v) => update('gateEnd', v)} min={0} max={500} />
          <div className="flex flex-col gap-1 p-2 rounded-lg bg-[#0a0a0a]/50 border border-white/5">
            <span className="text-[9px] uppercase tracking-wider text-[#555]">Metric</span>
            <select
              value={params.metric || 'peak'}
              onChange={(e) => update('metric', e.target.value)}
              className="bg-transparent text-sm font-mono text-white outline-none cursor-pointer"
            >
              {['peak', 'energy', 'mean'].map(m => <option key={m} value={m} className="bg-black">{m}</option>)}
            </select>
          </div>
        </div>
        <div className="text-[10px] text-[#555] px-1">
          {(params.hCount * params.hStep).toFixed(0)} × {(params.vCount * params.vStep).toFixed(0)} cm ·
          the gate is the depth window a cell's colour is taken from.
        </div>
      </Section>

      {/* Position + capture */}
      <Section label="Capture">
        <Guidance pose={pose} params={params} filled={filled} standoffMm={standoffMm} />
        <button
          onClick={() => onCapture(readiness.cell)}
          disabled={!readiness.ready || scanCapturing || !sfcwRunning}
          className={cn(
            'w-full py-3 rounded-xl border text-sm font-semibold transition-all cursor-pointer',
            'disabled:cursor-not-allowed',
            scanCapturing
              ? 'border-[#22d3ee]/40 bg-[#22d3ee]/10 text-[#22d3ee]'
              : readiness.ready && sfcwRunning
                ? 'border-[#4aff8a]/50 bg-[#4aff8a]/10 text-[#4aff8a] hover:bg-[#4aff8a]/15'
                : 'border-white/8 bg-[#0d0d0d] text-[#555]')}
        >{captureLabel}</button>
        <div className={cn('text-[10px] text-center',
          readiness.ready ? 'text-[#4aff8a]/80' : 'text-[#777]')}>
          {!sfcwRunning ? 'Start the scan to capture' : READINESS_TEXT[readiness.reason]}
          {readiness.reason === 'tilted' ? ` (${Math.abs(readiness.tiltDeg).toFixed(0)}° > ${readiness.maxTiltDeg}°)` : ''}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <SmallButton
            onClick={() => onRecapture(overCell)}
            disabled={!overFilled || !sfcwRunning || scanCapturing}
          >Recapture this cell</SmallButton>
          <SmallButton
            onClick={() => onClearCell(overCell)}
            disabled={!overFilled || scanCapturing}
            tone="danger"
          >Clear this cell</SmallButton>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <NumField label="Looks per cell" value={avgCount} unit="sweeps"
            onChange={(v) => onAvgCountChange(Math.round(v))} min={1} max={64} />
          <button
            onClick={() => onBeepChange(!beep)}
            className={cn('flex flex-col items-start justify-center gap-0.5 p-2 rounded-lg border text-left transition-all cursor-pointer',
              beep ? 'border-[#4aff8a]/30 bg-[#4aff8a]/5' : 'border-white/8 bg-[#0a0a0a]/50 hover:border-white/15')}
          >
            <span className="text-[9px] uppercase tracking-wider text-[#555]">Beep on capture</span>
            <span className={cn('text-sm font-semibold', beep ? 'text-[#4aff8a]' : 'text-[#777]')}>
              {beep ? 'On' : 'Off'}
            </span>
          </button>
        </div>
        <p className="text-[10px] leading-relaxed text-[#555]">
          With auto-capture on, holding the head still and centred over an empty cell for
          {' '}{DWELL_MS} ms takes a look: two rising notes means captured, one low note
          means it was thrown away because the head moved. The dashed cell is the next
          suggested one; fill in any order.
        </p>
      </Section>

      {/* Data */}
      <Section label="Data">
        <div className="grid grid-cols-2 gap-1.5">
          <SmallButton onClick={onExport} disabled={scanData.length === 0}>Export</SmallButton>
          <SmallButton onClick={onImport}>Import</SmallButton>
        </div>
        <SmallButton onClick={onClear} disabled={scanData.length === 0} tone="danger">
          Clear scan
        </SmallButton>
      </Section>
    </div>
  );
}
