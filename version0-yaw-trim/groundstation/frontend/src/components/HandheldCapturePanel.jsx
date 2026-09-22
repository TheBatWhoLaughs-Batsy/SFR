import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import EditableField from './EditableField';
import { CAPTURE_GRID_LIMITS, LATENCY_LIMITS_MS, cellAtCornerOffsetMm } from '@/lib/handheldCapture';
import { MIN_SWEEPS_LIMITS } from '@/hooks/useHandheldCapture';
import { originFromPose, allHandheldLidarsPresent } from '@/lib/handheldPose';

const plainBtn = cn('px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70',
  'enabled:hover:bg-white/10 enabled:hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed');
const greenBtn = 'w-full px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] enabled:hover:border-[#4aff8a]/60 disabled:opacity-30 disabled:cursor-not-allowed';

function Notice({ tone = 'amber', children }) {
  const cls = tone === 'red'
    ? 'bg-red-500/5 border-red-500/30 text-red-400'
    : tone === 'green'
      ? 'bg-[#4aff8a]/5 border-[#4aff8a]/30 text-[#4aff8a]'
      : 'bg-[#f59e0b]/5 border-[#f59e0b]/30 text-[#f59e0b]';
  return <div className={cn('px-2 py-1.5 rounded-lg border text-[9px] leading-relaxed', cls)}>{children}</div>;
}

const fmtMm = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} mm`);
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);

export default function HandheldCapturePanel({
  capture, rough, isConnected, sdrConnected, sfcwRunning, handheldPose, handheldOrigin, onHandheldOriginChange,
}) {
  const c = capture;
  const [originNote, setOriginNote] = useState(null);
  const L = CAPTURE_GRID_LIMITS;
  const active = c.session.active;
  const lidarsReady = allHandheldLidarsPresent(handheldPose, isConnected);
  const originReady = Number.isFinite(handheldOrigin?.x) && Number.isFinite(handheldOrigin?.y);
  // The capture's own measurement-timed position, the one sweeps are placed by.
  const hx = isConnected ? c.livePos?.x ?? null : null;
  const hy = isConnected ? c.livePos?.y ?? null : null;
  const cell = hx != null && hy != null ? cellAtCornerOffsetMm(hx, hy, c.grid) : null;
  const total = c.grid.hCount * c.grid.vCount;
  const dirReady = c.dir.state === 'ready';
  const nameBad = ['exists', 'invalid', 'error'].includes(c.nameCheck.state);

  const startBlockers = [
    c.dir.state === 'unsupported' && 'This browser cannot write to a folder. Use Chrome or Edge on localhost.',
    !dirReady && c.dir.state !== 'unsupported' && 'Choose a folder.',
    c.nameCheck.state !== 'ok' && (c.nameCheck.message || 'Checking the name…'),
    !sdrConnected && 'The SDR is not connected.',
    !lidarsReady && 'Not all three handheld LiDARs are in the sensor stream (Handheld + IMU panel).',
  ].filter(Boolean);

  const setOrigin = () => {
    const { origin: next, set, kept } = originFromPose(handheldPose, handheldOrigin);
    if (!set.length) {
      setOriginNote({ bad: true, text: 'No LiDAR has a fresh reading, origin unchanged.' });
      return;
    }
    onHandheldOriginChange(next);
    c.noteOriginSet({ origin: next, set, kept });
    const missing = ['x', 'y'].filter(k => !set.includes(k));
    setOriginNote(missing.length
      ? { bad: true, text: `No fresh reading on ${missing.join(', ').toUpperCase()}: that axis kept its previous origin.` }
      : { bad: false, text: 'Origin set: this spot is the top-left corner of the patch.' });
  };

  const r = c.rec;

  return (
    <>
      {rough && (
        <div className="grid grid-cols-2 gap-1.5">
          {[['status', 'Status'], ['rough', 'Rough output']].map(([key, label]) => (
            <button key={key} onClick={() => rough.setView(key)}
              className={cn('px-2 py-1.5 rounded-lg text-[10px] font-semibold transition-all border',
                rough.view === key ? 'bg-[#22d3ee]/10 border-[#22d3ee]/40 text-[#22d3ee]'
                  : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80')}>
              {label}
            </button>
          ))}
        </div>
      )}
      <Section label="Save To">
        {c.dir.state === 'unsupported' ? (
          <Notice tone="red">
            This browser has no folder access (File System Access API). Use Chrome or Edge, opened on
            localhost.
          </Notice>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
              <div className="px-2 py-2 rounded-lg border border-white/8 bg-[#0a0a0a]/60 text-[10px] font-mono truncate"
                title={c.dir.name || ''}>
                {c.dir.name
                  ? <span className={dirReady ? 'text-white/80' : 'text-[#f59e0b]'}>{c.dir.name}</span>
                  : <span className="text-white/30">No folder</span>}
              </div>
              {c.dir.state === 'needs-permission' ? (
                <button onClick={c.reconnectFolder} disabled={active} className={cn(plainBtn, 'text-[10px] py-1.5')}>
                  Reconnect
                </button>
              ) : (
                <button onClick={c.chooseFolder} disabled={active} className={cn(plainBtn, 'text-[10px] py-1.5')}>
                  {c.dir.name ? 'Change…' : 'Choose…'}
                </button>
              )}
            </div>
            {c.dir.state === 'needs-permission' && (
              <div className="px-2 text-[9px] text-[#f59e0b]">The browser needs permission again for this folder.</div>
            )}
          </>
        )}
        <div className={cn('flex items-center gap-1 p-2 rounded-lg border bg-[#0a0a0a]/60',
          c.nameCheck.state === 'ok' ? 'border-[#4aff8a]/30' : nameBad ? 'border-red-500/40' : 'border-white/8',
          active && 'opacity-50')}>
          <span className="text-[10px] font-mono text-white/30">/</span>
          <input
            type="text"
            value={active ? c.session.name : c.name}
            disabled={active}
            onChange={(e) => c.setName(e.target.value)}
            placeholder="session name"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-xs font-mono text-white outline-none placeholder:text-[#333]"
          />
        </div>
        {!active && (
          <div className={cn('px-2 text-[9px]',
            c.nameCheck.state === 'ok' ? 'text-[#4aff8a]' : nameBad ? 'text-red-400' : 'text-white/40')}>
            {c.nameCheck.state === 'ok' ? `"${c.name.trim()}" is free: a folder of that name will be created`
              : c.nameCheck.state === 'checking' ? 'Checking…'
                : c.nameCheck.message || ''}
          </div>
        )}
      </Section>

      <Section label="Patch Grid">
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="H Cells" value={c.grid.hCount} unit="ct" locked={active}
            onChange={(v) => c.setGridParams({ hCount: Math.round(v) })} min={L.countMin} max={L.countMax} />
          <EditableField label="H Step" value={c.grid.hStep} unit="cm" locked={active}
            onChange={(v) => c.setGridParams({ hStep: v })} min={L.stepMin} max={L.stepMax} />
          <EditableField label="V Cells" value={c.grid.vCount} unit="ct" locked={active}
            onChange={(v) => c.setGridParams({ vCount: Math.round(v) })} min={L.countMin} max={L.countMax} />
          <EditableField label="V Step" value={c.grid.vStep} unit="cm" locked={active}
            onChange={(v) => c.setGridParams({ vStep: v })} min={L.stepMin} max={L.stepMax} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Patch W × H"
            value={`${(c.grid.hCount * c.grid.hStep).toFixed(1)} × ${(c.grid.vCount * c.grid.vStep).toFixed(1)} cm`} />
          <EditableField label="Min Sweeps" value={c.minSweeps} unit="/cell"
            onChange={c.setMinSweeps} min={MIN_SWEEPS_LIMITS.min} max={MIN_SWEEPS_LIMITS.max} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="LiDAR Latency" value={c.latencyMs} unit="ms"
            onChange={c.setLatencyMs} min={LATENCY_LIMITS_MS.min} max={LATENCY_LIMITS_MS.max} />
          <InfoTile label="Grid is" value="coverage only" />
        </div>
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          Positions are timed by each LiDAR's own measurement time minus LiDAR Latency (0 until
          measured). The grid only drives the coverage map; every sweep and sensor packet is recorded raw.
        </div>
      </Section>

      <Section label="Session">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="State" value={!active ? 'Idle' : c.busy === 'ending' ? 'Saving' : c.session.playing ? 'Scanning' : 'Paused'} />
          <InfoTile label="Cells" value={`${c.stats.captured} / ${total}`} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="X" value={fmtMm(hx)} />
          <InfoTile label="Y" value={fmtMm(hy)} />
          <InfoTile label="Cell" value={cell ? `${cell.ix + 1}, ${c.grid.vCount - cell.iy}` : 'off'} />
        </div>

        {!active ? (
          <>
            <button onClick={c.start} disabled={startBlockers.length > 0 || !!c.busy} className={greenBtn}>
              {c.busy === 'starting' ? 'Starting…' : 'Start session'}
            </button>
            {startBlockers.length > 0 && (
              <div className="px-2 text-[9px] text-white/40 leading-relaxed">
                {startBlockers.map((b) => <div key={b}>· {b}</div>)}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={c.togglePlay}
                disabled={!originReady || !!c.busy}
                title={!originReady ? 'Set the origin first' : undefined}
                className={cn('px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border disabled:opacity-30 disabled:cursor-not-allowed',
                  c.session.playing
                    ? 'bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]'
                    : 'bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] enabled:hover:border-[#4aff8a]/60')}
              >
                {c.session.playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button
                onClick={setOrigin}
                // Moving the origin while scanning would move every cell under the module.
                disabled={!isConnected || c.session.playing || !!c.busy}
                title={c.session.playing ? 'Pause before setting the origin' : undefined}
                className="px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border border-[#D1855C]/40 bg-[#D1855C]/8 text-[#D1855C] enabled:hover:border-[#D1855C]/70 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Set origin
              </button>
            </div>
            <button onClick={c.end} disabled={c.busy === 'ending' || c.busy === 'starting'} className={cn(plainBtn, 'w-full text-[10px] py-1.5')}>
              {c.busy === 'ending' ? 'Saving…' : 'End session'}
            </button>
            {!originReady && (
              <Notice>No origin on X and Y yet. Hold the module at the patch's top-left corner and Set origin.</Notice>
            )}
            {!sfcwRunning && c.busy !== 'ending' && (
              <Notice>
                The SFCW sweep is not running, so no sweeps are being recorded.{' '}
                <button onClick={c.restartSweep} disabled={!sdrConnected} className="underline disabled:opacity-40">
                  Restart sweep
                </button>
              </Notice>
            )}
            {!isConnected && <Notice tone="red">The sensor stream is disconnected: no LiDAR or IMU data is being recorded.</Notice>}
          </>
        )}
        {originNote && <Notice tone={originNote.bad ? 'amber' : 'green'}>{originNote.text}</Notice>}
        {c.error && <Notice tone="red">{c.error}</Notice>}
        {!active && c.lastSession && (
          <Notice tone="green">
            Saved "{c.lastSession.name}": {c.lastSession.lines.toLocaleString()} records, {fmtBytes(c.lastSession.bytes)} in{' '}
            {c.lastSession.segments} segment{c.lastSession.segments === 1 ? '' : 's'}. Name moved on for the next patch.
          </Notice>
        )}
      </Section>

      <Section label="Recorded">
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Sweeps" value={c.stats.sweeps.toLocaleString()} />
          <InfoTile label="Sensor" value={c.stats.sensor.toLocaleString()} />
          <InfoTile label="Events" value={c.stats.events} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Placed" value={c.stats.placed.toLocaleString()} />
          <InfoTile label="No pos" value={c.stats.noPosition} />
          <InfoTile label="Off patch" value={c.stats.offGrid} />
        </div>
        {active && c.session.playing && c.stats.placed === 0 && c.stats.noPosition + c.stats.offGrid > 20 && (
          <Notice>Sweeps are recorded but none land on the patch: check the module is on it and the LiDARs read.</Notice>
        )}
        {c.stats.emptySweeps > 0 && (
          <Notice>{c.stats.emptySweeps} empty DSP sweeps (failed FPGA reads) were recorded but not placed.</Notice>
        )}
      </Section>

      <Section label="Disk">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Written" value={r ? fmtBytes(r.writtenBytes) : '—'} />
          <InfoTile label="Rate" value={r && active ? `${Math.round(r.linesPerS)} rec/s` : '—'} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Segments" value={r ? r.segments : '—'} />
          <InfoTile label="Unsaved" value={r ? fmtBytes(r.backlogBytes) : '—'} />
        </div>
        {r?.lastError && <Notice tone="red">Writing to disk failed: {r.lastError}. Retrying every second.</Notice>}
        {r?.backlogAlarm && (
          <Notice tone="red">Over 64 MB is waiting to be written. The disk is not keeping up or is failing: pause and check it.</Notice>
        )}
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          Saved about once a second as session.json plus stream_*.jsonl files in the session folder. A crash
          loses at most the last second.
        </div>
      </Section>

      {rough && rough.view === 'rough' && <RoughOutputSection rough={rough} />}
    </>
  );
}

// ── Rough output settings ────────────────────────────────────────────────────

const seg = (on, tone = 'cyan') => cn('flex-1 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all border',
  on
    ? tone === 'purple' ? 'bg-purple-500/10 border-purple-500/30 text-purple-400'
      : tone === 'amber' ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
        : 'bg-[#22d3ee]/10 border-[#22d3ee]/30 text-[#22d3ee]'
    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80');

function Slider({ label, value, unit = '', min, max, step, onChange, disabled }) {
  return (
    <div className={cn('flex flex-col gap-1 px-1', disabled && 'opacity-35 pointer-events-none')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">{label}</span>
        <span className="text-[10px] font-mono text-white/60">{value} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer accent-cyan-500" />
    </div>
  );
}

function RoughOutputSection({ rough }) {
  const r = rough;
  const s = r.settings;
  const u = r.update;
  const [models, setModels] = useState(null);
  const [modelError, setModelError] = useState(null);

  const listModels = useCallback(() => {
    setModelError(null);
    fetch('/api/models')
      .then((res) => res.json())
      .then((d) => setModels(Array.isArray(d) ? d : []))
      .catch(() => { setModels([]); setModelError('Could not list models (is the groundstation API running?).'); });
  }, []);
  const loadModel = useCallback((filename) => {
    fetch(`/api/models/${filename}`)
      .then((res) => res.json())
      .then((m) => { r.setBgModel(m); setModels(null); })
      .catch(() => setModelError(`Could not load ${filename}.`));
  }, [r]);

  // Switching to manual starts from the limits currently drawn, so colours do not jump.
  const seedManual = () => {
    const g = r.plan.global;
    if (!g || !isFinite(g.min) || !isFinite(g.max)) return { min: s.scaleRange.min, max: s.scaleRange.max };
    const lo = Math.floor(g.min);
    return { min: lo, max: Math.max(Math.ceil(g.max), lo + 1) };
  };
  const span = r.modelSpan;
  const so = r.standoffs;
  const outside = span && so && (so.min < span.min || so.max > span.max);
  const d = r.diag;
  const hCount = r.grid ? r.grid.hCount : 0;

  return (
    <>
      <Section label="Rough Output">
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          The first sweep placed in each cell, background subtracted and drawn like a C-scan. A quick look
          only: the recording keeps every sweep.
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Cells" value={r.cells} />
          <InfoTile label="Standoff" value={so ? `${so.min.toFixed(0)}–${so.max.toFixed(0)} mm` : '—'} />
        </div>

        <button onClick={models ? () => setModels(null) : listModels}
          className={cn('w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            r.bgModel ? 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa]' : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white')}>
          {r.bgModel ? `Model: ${r.bgModel.name || 'loaded'}` : 'Load BG model'}
        </button>
        {models && (
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0a0a] p-2">
            {models.length === 0 && <span className="text-[10px] text-white/30 px-1">No models saved</span>}
            {models.map((m) => (
              <button key={m.filename} onClick={() => loadModel(m.filename)}
                className="text-left px-2 py-1.5 rounded text-[11px] text-white/70 hover:bg-white/10 hover:text-white truncate">
                {m.name || m.filename}
              </button>
            ))}
          </div>
        )}
        {modelError && <Notice tone="red">{modelError}</Notice>}
        {r.bgModel && (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => u({ bgApplied: !s.bgApplied })} className={seg(s.bgApplied)}>
              {s.bgApplied ? '● BG applied' : 'BG off (raw)'}
            </button>
            <button onClick={() => r.setBgModel(null)} className={seg(false)}>Unload model</button>
          </div>
        )}
        {!r.bgModel && <div className="px-2 text-[9px] text-[#f59e0b]">No model loaded: showing raw sweeps.</div>}
        {r.bgModel && span && (
          <div className={cn('px-2 text-[9px]', outside ? 'text-[#f59e0b]' : 'text-white/40')}>
            Model covers {span.min.toFixed(0)}–{span.max.toFixed(0)} mm of standoff
            {outside ? '; some cells are outside it and are subtracted against a clamped background.' : '.'}
          </div>
        )}
        {r.bgModel && s.bgApplied && d.total > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <InfoTile label="Applied" value={d.applied - d.clamped} />
            <InfoTile label="Clamped" value={d.clamped} />
            <InfoTile label="Invalid" value={d.invalid} />
          </div>
        )}
        {so && so.missing > 0 && r.bgModel && (
          <div className="px-2 text-[9px] text-[#f59e0b]">{so.missing} cells have no forward-LiDAR standoff and are drawn invalid.</div>
        )}
        <div className="flex gap-2">
          {[['complex', 'Complex'], ['magnitude', 'Magnitude']].map(([k, label]) => (
            <button key={k} onClick={() => u({ subMode: k })} className={cn(seg(s.subMode === k), 'disabled:opacity-40')} disabled={!r.bgModel}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 items-center">
          <select value={s.windowType} onChange={(e) => u({ windowType: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg text-[10px] bg-white/5 border border-white/10 text-white/70 outline-none">
            <option value="rectangular" className="bg-[#0a0a0a]">rectangular</option>
            <option value="hanning" className="bg-[#0a0a0a]">hanning</option>
            <option value="kaiser" className="bg-[#0a0a0a]">kaiser</option>
          </select>
          {s.windowType === 'kaiser'
            ? <Slider label="β" value={s.kaiserBeta} min={0} max={14} step={0.5} onChange={(v) => u({ kaiserBeta: v })} />
            : <div />}
        </div>
      </Section>

      <Section label="Rough: Depth Slice">
        <Slider label="Gate start" value={s.gateStart} unit="cm" min={0} max={Math.max(s.gateEnd - 0.5, 0.5)} step={0.5}
          onChange={(v) => u({ gateStart: v })} />
        <Slider label="Gate end" value={s.gateEnd} unit="cm" min={Math.min(s.gateStart + 0.5, s.gateEnd)}
          max={Math.max(r.depthLimitCm, s.gateEnd)} step={0.5} onChange={(v) => u({ gateEnd: v })} />
        <div className="flex gap-2">
          {['peak', 'energy', 'mean'].map((m) => (
            <button key={m} onClick={() => u({ metric: m })} className={cn(seg(s.metric === m), 'capitalize')}>{m}</button>
          ))}
        </div>
      </Section>

      <Section label="Rough: Focus">
        <button onClick={() => u({ focusEnabled: !s.focusEnabled })} disabled={hCount < 3}
          className={cn(seg(s.focusEnabled, 'purple'), 'w-full py-2 disabled:opacity-30')}>
          {s.focusEnabled ? '● Focus ON' : 'Focus OFF'}
        </button>
        {s.focusEnabled && (
          <>
            <div className="flex gap-2">
              {[['saft', 'SAFT'], ['das_cf', 'DAS+CF'], ['dmas_cf', 'DMAS+CF']].map(([k, label]) => (
                <button key={k} onClick={() => u({ focusMethod: k })} className={seg(s.focusMethod === k, 'purple')}>{label}</button>
              ))}
            </div>
            {s.focusMethod !== 'saft' && (
              <Slider label="CF gamma" value={s.focusGamma} min={0} max={3} step={0.1} onChange={(v) => u({ focusGamma: v })} />
            )}
            <Slider label="Aperture (neighbours)" value={s.focusAperture} min={3} max={Math.max(3, hCount)} step={2}
              onChange={(v) => u({ focusAperture: v })} />
          </>
        )}
      </Section>

      <Section label="Rough: Display">
        <div className="flex gap-2">
          <button onClick={() => u({ scaleMode: s.scaleMode === 'linear' ? 'db' : 'linear' })} className={seg(true)}>
            {s.scaleMode === 'linear' ? 'Linear' : 'dB'}
          </button>
          <button onClick={() => u({ smooth: !s.smooth })} className={seg(s.smooth)}>
            {s.smooth ? '● Smooth' : 'Blocky'}
          </button>
          <select value={s.colormap} onChange={(e) => u({ colormap: e.target.value })}
            className="flex-1 px-2 py-1.5 rounded-lg text-[10px] bg-white/5 border border-white/10 text-white/70 outline-none">
            {['jet', 'viridis', 'inferno'].map((m) => <option key={m} value={m} className="bg-[#0a0a0a]">{m}</option>)}
          </select>
        </div>
        <button
          onClick={() => u({ scaleRange: s.scaleRange.dynamic ? { dynamic: false, ...seedManual() } : { ...s.scaleRange, dynamic: true } })}
          className={cn(seg(true, s.scaleRange.dynamic ? 'cyan' : 'amber'), 'w-full py-2')}>
          {s.scaleRange.dynamic ? '● Dynamic scaling' : 'Manual scaling'}
        </button>
        <Slider label="Min" value={s.scaleRange.min} unit="dB" min={-160} max={20} step={1} disabled={s.scaleRange.dynamic}
          onChange={(v) => u({ scaleRange: { ...s.scaleRange, min: Math.min(v, s.scaleRange.max - 1) } })} />
        <Slider label="Max" value={s.scaleRange.max} unit="dB" min={-160} max={20} step={1} disabled={s.scaleRange.dynamic}
          onChange={(v) => u({ scaleRange: { ...s.scaleRange, max: Math.max(v, s.scaleRange.min + 1) } })} />
        <div className="flex gap-2">
          {[['linked', 'Linked scale'], ['independent', 'Gated scale']].map(([k, label]) => (
            <button key={k} onClick={() => u({ scaleLink: k })} disabled={!s.scaleRange.dynamic || s.focusEnabled}
              className={cn(seg(r.plan.effectiveLink === k), 'disabled:opacity-40')}>{label}</button>
          ))}
        </div>
      </Section>
    </>
  );
}
