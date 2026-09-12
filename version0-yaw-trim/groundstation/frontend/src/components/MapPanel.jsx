import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function MapPanel({
  bscanData,
  gateStart,
  gateEnd,
  onGateStartChange,
  onGateEndChange,
  dynRange,
  onDynRangeChange,
  metric,
  onMetricChange,
  focusEnabled,
  focusAperture,
  onFocusEnabledChange,
  onFocusApertureChange,
  svdEnabled,
  svdK,
  svdStrength,
  onSvdEnabledChange,
  onSvdKChange,
  onSvdStrengthChange,
}) {
  const numPositions = bscanData ? bscanData.length : 0;

  return (
    <>
      <Section label="Status">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Positions" value={numPositions || '—'} />
          <InfoTile label="Gate" value={`${gateStart}–${gateEnd} cm`} />
        </div>
      </Section>

      <Section label="Depth Gate">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">Gate start</span>
            <span className="text-[10px] font-mono text-white/60">{gateStart} cm</span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(gateEnd - 1, 1)}
            step={0.5}
            value={gateStart}
            onChange={(e) => onGateStartChange(parseFloat(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-white/10 accent-emerald-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] font-mono text-white/30">
            <span>0</span>
            <span>{Math.max(gateEnd - 1, 1)}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">Gate end</span>
            <span className="text-[10px] font-mono text-white/60">{gateEnd} cm</span>
          </div>
          <input
            type="range"
            min={Math.max(gateStart + 1, 1)}
            max={50}
            step={0.5}
            value={gateEnd}
            onChange={(e) => onGateEndChange(parseFloat(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-white/10 accent-emerald-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] font-mono text-white/30">
            <span>{Math.max(gateStart + 1, 1)}</span>
            <span>50</span>
          </div>
        </div>
      </Section>

      <Section label="Metric">
        <div className="flex gap-2">
          <button
            onClick={() => onMetricChange('peak')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              metric === 'peak'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Peak
          </button>
          <button
            onClick={() => onMetricChange('energy')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              metric === 'energy'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Energy
          </button>
          <button
            onClick={() => onMetricChange('mean')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              metric === 'mean'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Mean
          </button>
        </div>
        <p className="text-[10px] text-[#444] leading-relaxed">
          {metric === 'peak' && 'Maximum magnitude within the gate window'}
          {metric === 'energy' && 'Integrated power (RMS) within the gate window'}
          {metric === 'mean' && 'Average dB level within the gate window'}
        </p>
      </Section>

      <Section label="Focus (SAFT)">
        <button
          onClick={() => onFocusEnabledChange(!focusEnabled)}
          disabled={numPositions < 3}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            numPositions < 3
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : focusEnabled
                ? 'bg-purple-500/10 border-purple-500/30 text-purple-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {focusEnabled ? '● Focus ON' : 'Focus OFF'}
        </button>
        {focusEnabled && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">Aperture (neighbors)</span>
              <span className="text-[10px] font-mono text-white/60">{focusAperture}</span>
            </div>
            <input
              type="range"
              min={3}
              max={Math.max(3, numPositions)}
              step={2}
              value={focusAperture}
              onChange={(e) => onFocusApertureChange(parseInt(e.target.value))}
              className="w-full h-1 rounded-full appearance-none bg-white/10 accent-purple-500 cursor-pointer"
            />
            <div className="flex justify-between text-[9px] font-mono text-white/30">
              <span>3</span>
              <span>{Math.max(3, numPositions)}</span>
            </div>
          </div>
        )}
      </Section>

      <Section label="SVD Filter">
        <button
          onClick={() => onSvdEnabledChange(!svdEnabled)}
          disabled={numPositions < 2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            numPositions < 2
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : svdEnabled
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {svdEnabled ? '● SVD ON' : 'SVD OFF'}
        </button>
        {svdEnabled && (
          <div className="grid grid-cols-2 gap-2">
            <EditableField
              label="k (remove)"
              value={svdK}
              unit=""
              onChange={(v) => onSvdKChange(Math.round(v))}
              min={1}
              max={Math.max(1, numPositions - 1)}
            />
            <EditableField
              label="Strength"
              value={svdStrength}
              unit=""
              onChange={(v) => onSvdStrengthChange(v)}
              min={0.01}
              max={1}
            />
          </div>
        )}
      </Section>

      <Section label="Display">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">Dynamic range</span>
            <span className="text-[10px] font-mono text-white/60">{dynRange} dB</span>
          </div>
          <input
            type="range"
            min={5}
            max={60}
            value={dynRange}
            onChange={(e) => onDynRangeChange(parseInt(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-white/10 accent-emerald-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] font-mono text-white/30">
            <span>5</span>
            <span>60</span>
          </div>
        </div>
      </Section>
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
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
        'relative flex flex-col gap-0.5 p-3 rounded-xl border',
        'transition-all duration-300',
        editing
          ? 'border-emerald-500/40 bg-emerald-500/5 cursor-text'
          : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      {editing ? (
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
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-emerald-500 to-emerald-300 rounded-full" />
      )}
    </div>
  );
}
