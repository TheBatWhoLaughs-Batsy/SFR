import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import { tomoGridStats, tomoRowProgress } from '../lib/tomoGrid';

export default function TomoPanel({
  tomoParams, onTomoParamsChange,
  tomoData, tomoResult, tomoProgress,
  sfcwRunning, tomoCapturing,
  tomoBgRef, tomoBgModel,
  onTomoAction, onTomoCaptureBg, onTomoClearBg,
  epsilonR, onEpsilonRChange,
}) {
  const {
    xCount = 7, xStep = 5, yCount = 5, yStep = 2,
    maxDepth = 70, tomoResolution = 30,
    tomoWindowType = 'hanning', tomoKaiserBeta = 3,
    tomoRangeComp = 0,
  } = tomoParams || {};

  const stats = tomoGridStats(xCount, yCount, xStep, yStep);
  const captured = tomoData ? tomoData.length : 0;
  const progress = tomoRowProgress(captured, xCount, yCount);
  const full = captured >= stats.total;

  const setParam = (key, val) => {
    onTomoParamsChange({ ...tomoParams, [key]: val });
  };

  const hasBg = !!tomoBgRef || !!tomoBgModel;

  return (
    <>
      <Section label="Status">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Captured" value={`${captured} / ${stats.total}`} />
          <InfoTile label="Row" value={`${progress.currentRow + 1} / ${progress.totalRows}`} />
        </div>
        {tomoResult && (
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="Volume" value={`${tomoResult.pixelsX}×${tomoResult.pixelsY}×${tomoResult.pixelsZ}`} />
            <InfoTile label="Time" value={`${tomoResult.computeTimeMs} ms`} />
          </div>
        )}
        {tomoProgress > 0 && tomoProgress < 1 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-purple-400 font-medium">Reconstructing...</span>
              <span className="text-[10px] font-mono text-white/60">{Math.round(tomoProgress * 100)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-[width] duration-100"
                style={{ width: `${tomoProgress * 100}%` }}
              />
            </div>
          </div>
        )}
      </Section>

      <Section label="Tomo Grid">
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="X count" value={xCount} unit="" onChange={v => setParam('xCount', Math.round(v))} min={2} max={50} />
          <EditableField label="X step" value={xStep} unit="cm" onChange={v => setParam('xStep', v)} min={0.1} max={100} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField label="Y count" value={yCount} unit="" onChange={v => setParam('yCount', Math.round(v))} min={2} max={50} />
          <EditableField label="Y step" value={yStep} unit="cm" onChange={v => setParam('yStep', v)} min={0.1} max={100} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Aperture X" value={`${stats.width.toFixed(1)} cm`} />
          <InfoTile label="Aperture Y" value={`${stats.height.toFixed(1)} cm`} />
        </div>
      </Section>

      <Section label="Session">
        <div className="flex gap-2">
          {!tomoCapturing ? (
            <button
              onClick={() => onTomoAction('start_session')}
              disabled={!sfcwRunning}
              className={cn(
                'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
                !sfcwRunning
                  ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                  : 'bg-purple-500/10 border-purple-500/30 text-purple-400 hover:bg-purple-500/20'
              )}
            >
              Start Session
            </button>
          ) : (
            <button
              onClick={() => onTomoAction('stop_session')}
              className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all"
            >
              Stop Session
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onTomoAction('new')}
            disabled={captured === 0}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              captured === 0
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            New Scan
          </button>
          <button
            onClick={() => onTomoAction('undo')}
            disabled={captured === 0}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              captured === 0
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Undo
          </button>
        </div>
      </Section>

      <Section label="Capture">
        {tomoCapturing && !full && (
          <button
            onClick={() => onTomoAction('add_scan')}
            className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 transition-all"
          >
            Capture Position ({captured + 1} / {stats.total})
          </button>
        )}
        {full && (
          <div className="px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-400 text-center">
            Grid complete ({stats.total} positions)
          </div>
        )}

        <MiniGrid xCount={xCount} yCount={yCount} captured={captured} />
      </Section>

      <Section label="Background">
        <div className="flex gap-2">
          <button
            onClick={onTomoCaptureBg}
            disabled={!sfcwRunning}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              !sfcwRunning
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : tomoBgRef
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            {tomoBgRef ? '● BG Captured' : 'Capture BG'}
          </button>
          <button
            onClick={onTomoClearBg}
            disabled={!hasBg}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              !hasBg
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Clear BG
          </button>
        </div>
      </Section>

      <Section label="Reconstruction">
        <EditableField label="εr (medium)" value={epsilonR} unit="" onChange={onEpsilonRChange} min={1} max={30} />
        <EditableField label="Max Depth" value={maxDepth} unit="cm" onChange={v => setParam('maxDepth', v)} min={1} max={500} />
        <EditableField label="Resolution" value={tomoResolution} unit="mm" onChange={v => setParam('tomoResolution', v)} min={1} max={100} />
        <div className="flex flex-col gap-1 p-3 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Window</span>
          <select
            value={tomoWindowType}
            onChange={(e) => setParam('tomoWindowType', e.target.value)}
            className="bg-transparent text-xs font-mono text-white outline-none cursor-pointer -ml-0.5"
          >
            <option value="rectangular" className="bg-[#0a0a0a]">Rectangular</option>
            <option value="hanning" className="bg-[#0a0a0a]">Hanning</option>
            <option value="kaiser" className="bg-[#0a0a0a]">Kaiser β3</option>
          </select>
        </div>
        <EditableField label="Range Comp" value={tomoRangeComp} unit="" onChange={v => setParam('tomoRangeComp', v)} min={0} max={4} />
      </Section>

      <Section label="Data">
        <div className="flex gap-2">
          <button
            onClick={() => onTomoAction('export')}
            disabled={captured === 0}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              captured === 0
                ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Export
          </button>
          <button
            onClick={() => onTomoAction('import')}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Import
          </button>
        </div>
      </Section>
    </>
  );
}

function MiniGrid({ xCount, yCount, captured }) {
  const cells = [];
  const h = Math.max(1, xCount);
  const total = h * Math.max(1, yCount);
  for (let i = 0; i < total; i++) {
    const iy = Math.floor(i / h);
    const along = i % h;
    const ix = iy % 2 === 0 ? along : h - 1 - along;
    const done = i < captured;
    const next = i === captured;
    cells.push(
      <div
        key={`${ix}-${iy}`}
        className={cn(
          'rounded-sm transition-all',
          done ? 'bg-purple-500/40' : next ? 'bg-purple-500/20 ring-1 ring-purple-400 animate-pulse' : 'bg-white/5'
        )}
        style={{ gridColumn: ix + 1, gridRow: iy + 1 }}
      />
    );
  }
  const size = Math.max(4, Math.min(16, Math.floor(120 / Math.max(xCount, yCount))));
  return (
    <div
      className="mt-1 gap-0.5"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${xCount}, ${size}px)`,
        gridTemplateRows: `repeat(${yCount}, ${size}px)`,
      }}
    >
      {cells}
    </div>
  );
}

function EditableField({ label, value, unit, onChange, min, max, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    if (disabled) return;
    setDraft(String(value));
    setEditing(true);
  };

  const commit = () => {
    const num = parseFloat(draft);
    if (!isNaN(num) && num >= min && num <= max) {
      onChange(num);
    }
    setEditing(false);
  };

  return (
    <div
      onClick={!editing ? startEdit : undefined}
      className={cn(
        'relative flex flex-col gap-0.5 p-3 rounded-xl border transition-all duration-300',
        disabled
          ? 'border-white/5 bg-white/2 cursor-not-allowed opacity-40'
          : editing
            ? 'border-purple-500/40 bg-purple-500/5 cursor-text'
            : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      {editing && !disabled ? (
        <div className="flex items-baseline gap-1">
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            className="bg-transparent text-base font-bold font-mono text-white outline-none w-14"
          />
          {unit && <span className="text-xs font-semibold text-[#888888]">{unit}</span>}
        </div>
      ) : (
        <div className="flex items-baseline gap-1">
          <span className="text-base font-bold font-mono text-white">{value}</span>
          {unit && <span className="text-xs font-semibold text-[#888888]">{unit}</span>}
        </div>
      )}
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-purple-500 to-purple-300 rounded-full" />
      )}
    </div>
  );
}
