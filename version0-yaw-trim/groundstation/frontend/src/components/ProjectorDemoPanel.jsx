import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import EditableField from './EditableField';
import ProjectionControls from './ProjectionControls';
import { GRID_LIMITS, parseGrid } from '@/lib/projectorDemo';
import { LOOK_CONTROLS, radarDocFromFile, featureCount } from '@/lib/radarLook';
import { BRUSH_SIZE, BRUSH_STRENGTH } from '@/hooks/useProjectorDemo';
import { PAINT_SPEED, PAINT_VNEIGHBOURS, paintRows } from '@/hooks/useRoverPaint';
import { HANDHELD_BRUSH_RADIUS } from '@/hooks/useHandheldPaint';
import { originFromPose, allHandheldLidarsPresent } from '@/lib/handheldPose';

const MODES = [['draw', 'Draw'], ['rover', 'Rover'], ['handheld', 'Handheld']];

const BRUSH_BUTTONS = [['pipe', 'Pipe'], ['seepage', 'Seepage'], ['erase', 'Erase']];
const LOOK_GROUPS = ['Background', 'Pipes', 'Seepage'];

function segBtn(active, accent = 'cyan') {
  const on = accent === 'amber'
    ? 'bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]'
    : 'bg-[#22d3ee]/10 border-[#22d3ee]/40 text-[#22d3ee]';
  return cn('px-2 py-1.5 rounded-lg text-[10px] font-semibold transition-all border',
    'disabled:opacity-30 disabled:cursor-not-allowed',
    active ? on : 'bg-white/5 border-white/10 text-white/50 enabled:hover:text-white/80');
}

const plainBtn = cn('px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70',
  'enabled:hover:bg-white/10 enabled:hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed');

function Notice({ tone = 'amber', children }) {
  const cls = tone === 'red'
    ? 'bg-red-500/5 border-red-500/30 text-red-400'
    : tone === 'green'
      ? 'bg-[#4aff8a]/5 border-[#4aff8a]/30 text-[#4aff8a]'
      : 'bg-[#f59e0b]/5 border-[#f59e0b]/30 text-[#f59e0b]';
  return <div className={cn('px-2 py-1.5 rounded-lg border text-[9px] leading-relaxed', cls)}>{children}</div>;
}

// Opens a file picker and hands back the parsed grid, or an error message.
function pickGridFile(onResult) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = parseGrid(JSON.parse(ev.target.result));
      } catch {
        parsed = { error: 'The file is not valid JSON.' };
      }
      onResult(parsed, file.name);
    };
    reader.readAsText(file);
  };
  input.click();
}

function Slider({ label, value, min, max, step, digits = 2, unit = '', onChange }) {
  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">{label}</span>
        <span className="text-[10px] font-mono text-white/60">{Number(value).toFixed(digits)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer accent-cyan-500"
      />
    </div>
  );
}

function downloadFile(file, prefix = 'projector_grid') {
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function GridTiles({ grid, features }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <InfoTile label="Size W × H" value={`${(grid.hCount * grid.hStep).toFixed(1)} × ${(grid.vCount * grid.vStep).toFixed(1)} cm`} />
        <InfoTile label="Cells" value={`${grid.hCount} × ${grid.vCount}`} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <InfoTile label="Step H × V" value={`${grid.hStep} × ${grid.vStep} cm`} />
        {features != null
          ? <InfoTile label="Features" value={`${features} / ${grid.hCount * grid.vCount}`} />
          : <InfoTile label="Area" value={`${(grid.hCount * grid.hStep * grid.vCount * grid.vStep).toFixed(0)} cm²`} />}
      </div>
    </>
  );
}

function fmtDuration(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(0)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export default function ProjectorDemoPanel({
  demo, roverConnected, roverStatus, isConnected, handheldPose, handheldOrigin, onHandheldOriginChange,
}) {
  const {
    mode, setMode, drawDoc, drawGrid, setDrawGridParams, clearDraw, loadDraw,
    setLook, resetLook, reseed, makeDrawFile,
    patterns, loadPattern, clearPattern, tool, setTool, strength, setStrength, brushSize, setBrushSize,
    projection, setProjection, projector, setProjector, roverRun, handheldRun,
  } = demo;
  const [originNote, setOriginNote] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const L = GRID_LIMITS;

  const roverLinked = !!roverConnected && !!roverStatus?.board_connected;
  // Handheld mode needs all three LiDARs in the sensor stream.
  const lidarsReady = allHandheldLidarsPresent(handheldPose, isConnected);
  // A rover run or a handheld session locks the mode and the loaded grid.
  const running = !!roverRun?.active || !!handheldRun?.active;
  const pattern = patterns[mode] || null;
  const pgrid = pattern ? pattern.grid : null;

  const changeMode = (m) => { setFileError(null); setConfirmClear(false); setMode(m); };

  // Rough time for a run: every pass driven end to end at the traverse speed, plus the drive
  // down to the last pass at the vertical axis's own speed. Ramps ignored.
  const ySpeed = roverStatus?.config?.y_max_speed || 25;
  const passRows = pgrid && roverRun ? paintRows(pgrid.vCount, roverRun.vNeighbours) : [];
  const runSeconds = pgrid && roverRun
    ? (passRows.length * (pgrid.hCount - 1) * pgrid.hStep * 10) / roverRun.speed
      + (passRows[passRows.length - 1] * pgrid.vStep * 10) / ySpeed
    : NaN;

  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {MODES.map(([key, label]) => (
          <button
            key={key}
            onClick={() => changeMode(key)}
            // Rover mode needs a live controller. Nothing switches mode while the rover is
            // running over the grid.
            disabled={running
              || (key === 'rover' && mode !== 'rover' && !roverLinked)
              || (key === 'handheld' && mode !== 'handheld' && !lidarsReady)}
            title={key === 'rover' && !roverLinked ? 'Connect the rover to use this mode'
              : key === 'handheld' && !lidarsReady ? 'Needs all three handheld LiDARs' : undefined}
            className={segBtn(mode === key)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'draw' && (
        <>
          <Section label="Grid">
            <div className="px-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">Horizontal</div>
            <div className="grid grid-cols-2 gap-2">
              <EditableField label="H Cells" value={drawDoc.hCount} unit="ct"
                onChange={(v) => setDrawGridParams({ hCount: Math.round(v) })} min={L.countMin} max={L.countMax} />
              <EditableField label="H Step" value={drawDoc.hStep} unit="cm"
                onChange={(v) => setDrawGridParams({ hStep: v })} min={L.stepMin} max={L.stepMax} />
            </div>
            <div className="px-1 pt-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">Vertical</div>
            <div className="grid grid-cols-2 gap-2">
              <EditableField label="V Cells" value={drawDoc.vCount} unit="ct"
                onChange={(v) => setDrawGridParams({ vCount: Math.round(v) })} min={L.countMin} max={L.countMax} />
              <EditableField label="V Step" value={drawDoc.vStep} unit="cm"
                onChange={(v) => setDrawGridParams({ vStep: v })} min={L.stepMin} max={L.stepMax} />
            </div>
            <GridTiles grid={drawGrid} features={featureCount(drawDoc)} />
          </Section>

          <Section label="Brush">
            <div className="grid grid-cols-3 gap-1.5">
              {BRUSH_BUTTONS.map(([key, label]) => (
                <button key={key} onClick={() => setTool(key)}
                  className={segBtn(tool === key, key === 'erase' ? 'amber' : 'cyan')}>
                  {label}
                </button>
              ))}
            </div>
            <Slider label="Strength" value={strength} min={BRUSH_STRENGTH.min} max={BRUSH_STRENGTH.max}
              step={BRUSH_STRENGTH.step} digits={2} onChange={setStrength} />
            <Slider label="Brush size" value={brushSize} min={BRUSH_SIZE.min} max={BRUSH_SIZE.max}
              step={1} digits={0} unit=" cells" onChange={setBrushSize} />
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              Click or drag on the grid to paint; right-drag erases. A pipe stroke is one cell wide
              (its width on screen is under Look). Brush size is the radius of seepage and of the eraser.
            </div>
            <button
              onClick={() => {
                if (confirmClear) { clearDraw(); setConfirmClear(false); } else setConfirmClear(true);
              }}
              onBlur={() => setConfirmClear(false)}
              className={cn(plainBtn, 'w-full', confirmClear && 'border-red-500/40 text-red-400 bg-red-500/5')}
            >
              {confirmClear ? 'Click again to clear every pipe and seepage' : 'Clear pipes and seepage'}
            </button>
          </Section>

          <Section label="Look">
            {LOOK_GROUPS.map(group => (
              <div key={group} className="flex flex-col gap-2">
                <div className="px-1 pt-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">{group}</div>
                {LOOK_CONTROLS.filter(c => c.group === group).map(c => (
                  <Slider key={c.key} label={c.label} value={drawDoc.look[c.key]} min={c.min} max={c.max}
                    step={c.step} digits={c.digits} unit={c.unit || ''} onChange={(v) => setLook({ [c.key]: v })} />
                ))}
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button onClick={reseed} className={plainBtn}>New background</button>
              <button onClick={resetLook} className={plainBtn}>Reset look</button>
            </div>
          </Section>

          <Section label="File">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => downloadFile(makeDrawFile())} className={plainBtn}>Export</button>
              <button
                onClick={() => pickGridFile((parsed) => {
                  if (parsed.error) { setFileError(parsed.error); return; }
                  if (!parsed.radar) {
                    setFileError('This grid has no pipe or seepage layers (it was made before the radar look), so it can only be shown in Rover or Handheld mode.');
                    return;
                  }
                  const r = radarDocFromFile(parsed.radar, parsed.grid);
                  if (r.error) { setFileError(r.error); return; }
                  setFileError(null);
                  loadDraw(r.doc);
                })}
                className={plainBtn}
              >
                Import
              </button>
            </div>
            {fileError && <Notice tone="red">{fileError}</Notice>}
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              Export saves the image exactly as shown, cell by cell, which is what Rover and Handheld
              display, plus the pipe and seepage layers so Draw can edit it again.
            </div>
          </Section>

          <Section label="Projection">
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              The projector shows the whole drawing with its grid lines. Align it to the wall, then
              draw: the grid on this screen uses the same scale and placement.
            </div>
            <ProjectionControls
              projection={projection}
              onProjectionChange={setProjection}
              projector={projector}
              onProjectorChange={setProjector}
              widthCm={drawDoc.hCount * drawDoc.hStep}
              heightCm={drawDoc.vCount * drawDoc.vStep}
              hStep={drawDoc.hStep}
              vStep={drawDoc.vStep}
            />
          </Section>
        </>
      )}

      {mode !== 'draw' && (
        <>
          {mode === 'handheld' && !lidarsReady && (
            <Notice>
              Not all three handheld LiDARs are in the sensor stream. Check the Handheld + IMU panel.
            </Notice>
          )}

          {mode === 'rover' && !roverLinked && (
            <Notice>
              Rover controller not connected. Connect it (Rover Scan panel) to run over the grid.
            </Notice>
          )}

          <Section label="Pattern">
            <button
              disabled={running}
              onClick={() => pickGridFile(({ grid, error }, name) => {
                setFileError(error || null);
                if (grid) loadPattern(mode, grid, name);
              })}
              className={cn(plainBtn, 'w-full')}
            >
              Import grid…
            </button>
            {fileError && <Notice tone="red">{fileError}</Notice>}
            {pattern ? (
              <>
                <div className="px-2 text-[9px] text-white/50 truncate" title={pattern.name}>
                  Loaded <span className="text-white/80">{pattern.name}</span>
                </div>
                <GridTiles grid={pgrid} />
                <button disabled={running} onClick={() => clearPattern(mode)}
                  className={cn(plainBtn, 'w-full text-[10px] py-1.5')}>
                  Unload
                </button>
              </>
            ) : (
              <div className="px-2 text-[9px] text-white/40">No grid loaded. Export one from Draw mode.</div>
            )}
          </Section>

          {mode === 'rover' && roverRun && (
            <Section label="Rover Run">
              <div className="grid grid-cols-2 gap-2">
                <EditableField label="Speed" value={roverRun.speed} unit="mm/s"
                  onChange={roverRun.setSpeed} min={PAINT_SPEED.min} max={PAINT_SPEED.max} locked={running} />
                <EditableField label="V Neighbours" value={roverRun.vNeighbours} unit="rows"
                  onChange={roverRun.setVNeighbours} min={PAINT_VNEIGHBOURS.min} max={PAINT_VNEIGHBOURS.max} locked={running} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <InfoTile label="Covered" value={pgrid ? `${roverRun.coveredCount} / ${pgrid.hCount * pgrid.vCount}` : '—'} />
                <InfoTile label="Est. time" value={pgrid ? fmtDuration(runSeconds) : '—'} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <InfoTile label="Pass"
                  value={running && roverRun.pass != null ? `${roverRun.pass + 1} / ${roverRun.passesTotal}`
                    : pgrid ? `${passRows.length} total` : '—'} />
                <InfoTile label="Band" value={`${2 * roverRun.vNeighbours + 1} rows`} />
              </div>
              {running ? (
                <button
                  onClick={roverRun.stop}
                  className="w-full px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b] hover:bg-[#f59e0b]/20"
                >
                  ■ Stop
                </button>
              ) : (
                <button
                  onClick={roverRun.start}
                  disabled={!roverLinked || !pgrid}
                  className="w-full px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] enabled:hover:border-[#4aff8a]/60 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ▶ Start
                </button>
              )}
              {!running && roverRun.coveredCount > 0 && (
                <button onClick={roverRun.resetCoverage} className={cn(plainBtn, 'w-full text-[10px] py-1.5')}>
                  Reset coverage
                </button>
              )}
              {running && roverRun.message && (
                <div className="px-2 text-[9px] text-[#4aff8a]">{roverRun.message}</div>
              )}
              {!running && roverRun.error && <Notice tone="red">{roverRun.error}</Notice>}
              {!running && roverRun.message && <Notice tone="green">{roverRun.message}</Notice>}
              <div className="px-2 text-[9px] text-white/40 leading-relaxed">
                Park the rover in front of the grid's top-left cell, then Start. It drives the grid
                in a snake from the top. Each pass lights its row plus V Neighbours rows above and
                below, and the next pass is one whole band lower, so the first pass runs V Neighbours
                rows below the top. Stop decelerates; the E-stop is in the Rover Scan panel.
              </div>
            </Section>
          )}

          {mode === 'handheld' && handheldRun && (() => {
            const hx = handheldPose?.pos?.x;
            const hy = handheldPose?.pos?.y;
            const originReady = Number.isFinite(handheldOrigin?.x) && Number.isFinite(handheldOrigin?.y);
            const cell = handheldRun.currentCell;
            const fmtMm = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} mm`);
            // Same rule as the Handheld + IMU panel's "Set origin here": every axis with a fresh
            // reading takes it, the others keep what they had.
            const setOrigin = () => {
              const { origin: next, set } = originFromPose(handheldPose, handheldOrigin);
              if (!set.length) {
                setOriginNote({ bad: true, text: 'No LiDAR has a fresh reading, origin unchanged.' });
                return;
              }
              onHandheldOriginChange(next);
              const missing = ['x', 'y'].filter(k => !set.includes(k));
              setOriginNote(missing.length
                ? { bad: true, text: `No fresh reading on ${missing.join(', ').toUpperCase()}: that axis kept its previous origin.` }
                : { bad: false, text: 'Origin set. This spot is the centre of the top-left cell.' });
            };
            return (
              <Section label="Handheld Session">
                <div className="grid grid-cols-2 gap-2">
                  <InfoTile label="Reached" value={pgrid ? `${handheldRun.coveredCount} / ${pgrid.hCount * pgrid.vCount}` : '—'} />
                  <InfoTile label="State" value={!handheldRun.active ? 'Idle' : handheldRun.playing ? 'Playing' : 'Paused'} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <InfoTile label="X" value={fmtMm(hx)} />
                  <InfoTile label="Y" value={fmtMm(hy)} />
                  <InfoTile label="Cell" value={!handheldRun.active ? '—' : cell ? `${cell.ix + 1}, ${cell.iy + 1}` : 'off'} />
                </div>
                {!handheldRun.active ? (
                  <button
                    onClick={() => { setOriginNote(null); handheldRun.start(); }}
                    disabled={!pgrid || !lidarsReady}
                    className="w-full px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] enabled:hover:border-[#4aff8a]/60 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Start session
                  </button>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={handheldRun.togglePlay}
                        disabled={!originReady}
                        title={!originReady ? 'Set the origin first' : undefined}
                        className={cn('px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border disabled:opacity-30 disabled:cursor-not-allowed',
                          handheldRun.playing
                            ? 'bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]'
                            : 'bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] enabled:hover:border-[#4aff8a]/60')}
                      >
                        {handheldRun.playing ? '❚❚ Pause' : '▶ Play'}
                      </button>
                      <button
                        onClick={setOrigin}
                        disabled={!isConnected}
                        className="px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border border-[#D1855C]/40 bg-[#D1855C]/8 text-[#D1855C] enabled:hover:border-[#D1855C]/70 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Set origin
                      </button>
                    </div>
                    <button onClick={handheldRun.end} className={cn(plainBtn, 'w-full text-[10px] py-1.5')}>
                      End session
                    </button>
                  </>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <InfoTile label="Path" value={`${handheldRun.pathPoints} pts`} />
                  <InfoTile label="Segments" value={`${handheldRun.pathSegments}`} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => downloadFile(handheldRun.makePathFile(), 'handheld_path')}
                    disabled={handheldRun.pathPoints === 0}
                    className={cn(plainBtn, 'text-[10px] py-1.5')}
                  >
                    Export path
                  </button>
                  <button
                    onClick={handheldRun.resetCoverage}
                    disabled={handheldRun.active || (handheldRun.coveredCount === 0 && handheldRun.pathPoints === 0)}
                    title={handheldRun.active ? 'End the session first' : 'Clear the reached cells and the recorded path'}
                    className={cn(plainBtn, 'text-[10px] py-1.5')}
                  >
                    Reset cells + path
                  </button>
                </div>
                {handheldRun.active && !originReady && (
                  <Notice>No origin on X and Y yet. Hold the module in front of the top-left cell and Set origin.</Notice>
                )}
                {originNote && <Notice tone={originNote.bad ? 'amber' : 'green'}>{originNote.text}</Notice>}
                <div className="px-2 text-[9px] text-white/40 leading-relaxed">
                  Start a session, hold the module in front of the grid's top-left cell and Set origin,
                  then Play. The module is a brush: every cell within {HANDHELD_BRUSH_RADIUS} cells of it
                  gets its colour back, and its path is recorded (each Play starts a new segment) for
                  Export path. Pause to move without lighting cells or recording. The origin is the same one
                  the Handheld + IMU panel uses.
                </div>
              </Section>
            );
          })()}

          <Section label="Projection">
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              {mode === 'rover'
                ? 'The projector shows the colours of the cells the rover has covered.'
                : 'The projector shows the colours of the cells the module has reached.'}
            </div>
            <ProjectionControls
              projection={projection}
              onProjectionChange={setProjection}
              projector={projector}
              onProjectorChange={setProjector}
              widthCm={pgrid ? pgrid.hCount * pgrid.hStep : 0}
              heightCm={pgrid ? pgrid.vCount * pgrid.vStep : 0}
              hStep={pgrid ? pgrid.hStep : 0}
              vStep={pgrid ? pgrid.vStep : 0}
            />
          </Section>
        </>
      )}
    </>
  );
}
