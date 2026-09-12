import { useState, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ErrorBadge } from './Sidebar';
import {
  EFFECTS, COLORMAP_NAMES, WINDOW_TYPES,
  validateSnapshot, snapshotSummary,
} from '@/lib/imagingEffects';

/**
 * Imaging Bench sidebar. Everything here is offline: it reads a
 * waterfall_snapshot exported from the live SFCW panel and drives the effect
 * chain in ImagingDisplay. No Pi involvement at all.
 */
export default function ImagingPanel({
  snapshot, snapshotName, onLoadSnapshot, onClearSnapshot,
  effect, onEffectChange, params, onParamsChange,
}) {
  const [importError, setImportError] = useState(null);
  const fileRef = useRef(null);

  // Params are one object per effect, so a set() only touches its own group.
  const set = (group, key, value) =>
    onParamsChange({ ...params, [group]: { ...params[group], [key]: value } });
  const setGroup = (group, patch) =>
    onParamsChange({ ...params, [group]: { ...params[group], ...patch } });

  const handleFile = (e) => {
    const file = e.target.files[0];
    e.target.value = '';       // so re-picking the same file fires again
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.target.result);
      } catch (err) {
        setImportError(`Could not parse ${file.name}: ${err.message}`);
        return;
      }
      const problem = validateSnapshot(parsed);
      if (problem) {
        setImportError(problem);
        return;
      }
      setImportError(null);
      onLoadSnapshot(parsed, file.name);
    };
    reader.onerror = () => setImportError(`Could not read ${file.name}.`);
    reader.readAsText(file);
  };

  const summary = snapshot ? snapshotSummary(snapshot) : null;
  const meta = EFFECTS.find(e => e.id === effect) || EFFECTS[0];
  const singleSweep = summary ? summary.sweeps < 2 : true;

  return (
    <>
      {/* ── Snapshot ─────────────────────────────────────────────── */}
      <Section label="Snapshot">
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          onChange={handleFile}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current && fileRef.current.click()}
          className="w-full px-3 py-2.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
        >
          Import Waterfall
        </button>

        {importError && <ErrorBadge message={importError} />}

        {summary && (
          <>
            <div className="px-2 text-[10px] font-mono text-white/50 truncate" title={snapshotName}>
              {snapshotName}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Sweeps" value={String(summary.sweeps)} />
              <InfoTile label="Steps" value={String(summary.steps)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <InfoTile
                label="Span"
                value={summary.startGHz != null
                  ? `${summary.startGHz.toFixed(2)}–${summary.stopGHz.toFixed(2)} GHz`
                  : 'unknown'}
              />
              <InfoTile label="Step" value={`${summary.stepMHz.toFixed(0)} MHz`} />
            </div>
            <div className="px-2 flex flex-col gap-0.5 text-[9px] text-white/40 leading-relaxed">
              <span>
                Captured {summary.timestamp ? new Date(summary.timestamp).toLocaleString() : 'unknown'}
              </span>
              <span>
                Max range {summary.maxRangeM.toFixed(2)} m
                {summary.rangeResCm != null && ` · Δr ${summary.rangeResCm.toFixed(1)} cm`}
                {summary.rangeOffset ? ` · offset ${summary.rangeOffset} m` : ''}
              </span>
              {summary.startGHz == null && (
                <span className="text-amber-400/70">
                  No frequency axis in this file — it predates start_freq. Dispersion and raw S21
                  fall back to step index.
                </span>
              )}
            </div>
            <button
              onClick={() => { onClearSnapshot(); setImportError(null); }}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 hover:text-white transition-all"
            >
              Clear
            </button>
          </>
        )}

        {!summary && !importError && (
          <div className="px-2 text-[9px] text-white/40 leading-relaxed">
            Export a snapshot from the SFCW panel’s waterfall, then load it here to try
            processing chains against identical recorded data.
          </div>
        )}
      </Section>

      {!snapshot ? null : (
        <>
          {/* ── Effect ─────────────────────────────────────────────── */}
          <Section label="Effect">
            <select
              value={effect}
              onChange={(e) => onEffectChange(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-xs text-white/80 outline-none focus:border-[#D1855C]/40 transition-all"
            >
              {EFFECTS.map(e => (
                <option key={e.id} value={e.id} disabled={e.multiSweep && singleSweep}>
                  {e.label}{e.multiSweep && singleSweep ? '  (needs ≥2 sweeps)' : ''}
                </option>
              ))}
            </select>

            {/* Description */}
            <div className="px-2 text-[10px] text-white/40 leading-relaxed">
              {meta.description}
            </div>
            {meta.multiSweep && singleSweep && (
              <ErrorBadge message={`${meta.label} compares sweeps against each other and this snapshot has only one. Pick another effect, or export a snapshot with a longer buffer.`} />
            )}
          </Section>

          {/* ── Parameters ─────────────────────────────────────────── */}
          <Section label="Parameters">
            <EffectParams effect={effect} params={params} set={set} setGroup={setGroup} summary={summary} />
          </Section>

          {/* ── View ───────────────────────────────────────────────── */}
          <Section label="View">
            {(meta.perSweep) && (
              <>
                <Toggle
                  label={params.view.followLatest ? '● Latest sweep' : 'Pinned sweep'}
                  active={params.view.followLatest}
                  onClick={() => set('view', 'followLatest', !params.view.followLatest)}
                />
                <SliderRow
                  label="Sweep"
                  value={Math.min(params.view.sweepIndex, summary.sweeps - 1) + 1}
                  unit={`/ ${summary.sweeps}`}
                  min={1}
                  max={summary.sweeps}
                  step={1}
                  disabled={params.view.followLatest}
                  onChange={(v) => set('view', 'sweepIndex', Math.round(v) - 1)}
                />
              </>
            )}

            <SliderRow
              label="Range min"
              value={params.view.rangeMin}
              unit="m"
              min={0}
              max={Math.max(0.1, summary.maxRangeM / 2)}
              step={0.01}
              decimals={2}
              onChange={(v) => set('view', 'rangeMin', Math.min(v, params.view.rangeMax - 0.02))}
            />
            <SliderRow
              label="Range max"
              value={params.view.rangeMax}
              unit="m"
              min={0}
              max={Math.max(0.1, summary.maxRangeM / 2)}
              step={0.01}
              decimals={2}
              onChange={(v) => set('view', 'rangeMax', Math.max(v, params.view.rangeMin + 0.02))}
            />
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              The zoom is applied before colour limits are computed, so percentiles and dynamic
              scaling describe what is on screen.
            </div>

            <div className="h-px bg-white/5 my-1" />

            <Radio
              label="Colormap"
              value={params.colormap.name}
              options={COLORMAP_NAMES.map(n => ({ value: n, label: n }))}
              onChange={(v) => set('colormap', 'name', v)}
            />
            <Toggle
              label={params.colormap.reverse ? '● Reversed' : 'Reverse colormap'}
              active={params.colormap.reverse}
              onClick={() => set('colormap', 'reverse', !params.colormap.reverse)}
            />
            <SliderRow
              label="Colour gamma"
              value={params.colormap.gamma}
              unit=""
              min={0.2}
              max={3}
              step={0.05}
              decimals={2}
              onChange={(v) => set('colormap', 'gamma', v)}
            />

            {!meta.perSweep && effect !== 'none' && effect !== 'colormap' && (
              <>
                <div className="h-px bg-white/5 my-1" />
                <div className="px-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">
                  Range Profile
                </div>
                <ProfileControls params={params} set={set} />
              </>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/* ── Per-effect parameter blocks ────────────────────────────────────────── */

function EffectParams({ effect, params, set, setGroup, summary }) {
  if (effect === 'none') {
    return (
      <>
        <Radio
          label="Scale"
          value={params.none.scaleMode}
          options={[{ value: 'db', label: 'dB' }, { value: 'linear', label: 'Linear' }]}
          onChange={(v) => set('none', 'scaleMode', v)}
        />
        <ProfileControls params={params} set={set} />
      </>
    );
  }

  if (effect === 'compression') {
    return (
      <>
        <SliderRow
          label="Exponent p"
          value={params.compression.p}
          unit=""
          min={0.05}
          max={3}
          step={0.05}
          decimals={2}
          onChange={(v) => set('compression', 'p', v)}
        />
        <Toggle
          label={params.compression.showDbReference ? '● dB reference inset' : 'Show dB reference'}
          active={params.compression.showDbReference}
          onClick={() => set('compression', 'showDbReference', !params.compression.showDbReference)}
        />
      </>
    );
  }

  if (effect === 'percentile') {
    return (
      <>
        <SliderRow
          label="Low percentile"
          value={params.percentile.low}
          unit="%"
          min={0}
          max={20}
          step={0.1}
          decimals={1}
          onChange={(v) => set('percentile', 'low', v)}
        />
        <SliderRow
          label="High percentile"
          value={params.percentile.high}
          unit="%"
          min={80}
          max={100}
          step={0.1}
          decimals={1}
          onChange={(v) => set('percentile', 'high', v)}
        />
        <Radio
          label="Scope"
          value={params.percentile.scope}
          options={[
            { value: 'history', label: 'Visible history' },
            { value: 'row', label: 'Per-row' },
          ]}
          onChange={(v) => set('percentile', 'scope', v)}
        />
      </>
    );
  }

  if (effect === 'binnorm') {
    return (
      <>
        <Radio
          label="Statistic"
          value={params.binnorm.stat}
          options={[
            { value: 'median', label: 'Median' },
            { value: 'mean', label: 'Mean' },
            { value: 'trimmed', label: 'Trimmed' },
          ]}
          onChange={(v) => set('binnorm', 'stat', v)}
        />
        <Toggle
          label={params.binnorm.sliding ? '● Sliding window' : 'Whole buffer'}
          active={params.binnorm.sliding}
          onClick={() => set('binnorm', 'sliding', !params.binnorm.sliding)}
        />
        <SliderRow
          label="Window length"
          value={params.binnorm.windowLen}
          unit="sweeps"
          min={5}
          max={Math.max(5, summary.sweeps)}
          step={1}
          disabled={!params.binnorm.sliding}
          onChange={(v) => set('binnorm', 'windowLen', Math.round(v))}
        />
        <Radio
          label="Output"
          value={params.binnorm.units}
          options={[{ value: 'db', label: 'dB ratio' }, { value: 'ratio', label: 'Ratio' }]}
          onChange={(v) => set('binnorm', 'units', v)}
        />
        <SliderRow
          label="Floor guard"
          value={params.binnorm.floorDb}
          unit="dB"
          min={-120}
          max={-10}
          step={1}
          onChange={(v) => set('binnorm', 'floorDb', Math.round(v))}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          Bins whose statistic falls below the guard are clamped to it, so an empty bin divides
          by a floor rather than by nearly zero.
        </div>
      </>
    );
  }

  if (effect === 'cfar') {
    return (
      <>
        <SliderRow
          label="Guard cells"
          value={params.cfar.guard}
          unit="bins"
          min={0}
          max={20}
          step={1}
          onChange={(v) => set('cfar', 'guard', Math.round(v))}
        />
        <SliderRow
          label="Training cells"
          value={params.cfar.train}
          unit="bins"
          min={1}
          max={64}
          step={1}
          onChange={(v) => set('cfar', 'train', Math.round(v))}
        />
        <SliderRow
          label="Alpha"
          value={params.cfar.alpha}
          unit="dB"
          min={0}
          max={20}
          step={0.5}
          decimals={1}
          onChange={(v) => set('cfar', 'alpha', v)}
        />
        <Radio
          label="Variant"
          value={params.cfar.variant}
          options={[
            { value: 'ca', label: 'CA' },
            { value: 'go', label: 'GO' },
            { value: 'so', label: 'SO' },
          ]}
          onChange={(v) => set('cfar', 'variant', v)}
        />
        <Toggle
          label={params.cfar.detectionsOnly ? '● Detections only' : 'Show ratio'}
          active={params.cfar.detectionsOnly}
          onClick={() => set('cfar', 'detectionsOnly', !params.cfar.detectionsOnly)}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          GO (greatest-of) holds the threshold up on the far side of the wall return, where CA
          lets a clutter edge drag it down.
        </div>
      </>
    );
  }

  if (effect === 'colormap') {
    return (
      <div className="px-2 text-[9px] text-white/40 leading-relaxed">
        All five maps are shown side by side. Pick the one you want in the View section below —
        the choice persists across every other effect.
      </div>
    );
  }

  if (effect === 'phasehue') {
    return (
      <>
        <SliderRow
          label="Value gamma"
          value={params.phasehue.valueGamma}
          unit=""
          min={0.1}
          max={3}
          step={0.05}
          decimals={2}
          onChange={(v) => set('phasehue', 'valueGamma', v)}
        />
        <SliderRow
          label="Saturation"
          value={params.phasehue.saturation}
          unit=""
          min={0}
          max={1}
          step={0.05}
          decimals={2}
          onChange={(v) => set('phasehue', 'saturation', v)}
        />
        <SliderRow
          label="Phase rotation"
          value={params.phasehue.rotationDeg}
          unit="°"
          min={-180}
          max={180}
          step={1}
          onChange={(v) => set('phasehue', 'rotationDeg', Math.round(v))}
        />
        <SliderRow
          label="Magnitude floor"
          value={params.phasehue.floorDb}
          unit="dB"
          min={-100}
          max={0}
          step={1}
          onChange={(v) => set('phasehue', 'floorDb', Math.round(v))}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          The floor is relative to the image peak. Below it a pixel goes black rather than
          showing a hue that means nothing.
        </div>
      </>
    );
  }

  if (effect === 'coherence') {
    return (
      <>
        <SliderRow
          label="Window K"
          value={params.coherence.K}
          unit="pairs"
          min={2}
          max={20}
          step={1}
          onChange={(v) => set('coherence', 'K', Math.round(v))}
        />
        <SliderRow
          label="Lag"
          value={params.coherence.lag}
          unit="sweeps"
          min={1}
          max={Math.max(1, Math.min(20, summary.sweeps - 1))}
          step={1}
          onChange={(v) => set('coherence', 'lag', Math.round(v))}
        />
        <Toggle
          label={params.coherence.maskEnabled ? '● Mask by magnitude' : 'Mask by magnitude'}
          active={params.coherence.maskEnabled}
          onClick={() => set('coherence', 'maskEnabled', !params.coherence.maskEnabled)}
        />
        <SliderRow
          label="Mask threshold"
          value={params.coherence.maskDb}
          unit="dB"
          min={-100}
          max={0}
          step={1}
          disabled={!params.coherence.maskEnabled}
          onChange={(v) => set('coherence', 'maskDb', Math.round(v))}
        />
        <Toggle
          label={params.coherence.autoScale ? '● Auto scale' : 'Fixed 0 → 1'}
          active={params.coherence.autoScale}
          onClick={() => set('coherence', 'autoScale', !params.coherence.autoScale)}
        />
      </>
    );
  }

  if (effect === 'integration') {
    return (
      <>
        <SliderRow
          label="Integration K"
          value={params.integration.K}
          unit="sweeps"
          min={2}
          max={Math.max(2, summary.sweeps)}
          step={1}
          onChange={(v) => set('integration', 'K', Math.round(v))}
        />
        <Radio
          label="View"
          value={params.integration.mode}
          options={[
            { value: 'coherent', label: 'Coherent' },
            { value: 'noncoherent', label: 'Non-coh.' },
            { value: 'ratio', label: 'Ratio (dB)' },
            { value: 'side', label: 'Side-by-side' },
          ]}
          onChange={(v) => set('integration', 'mode', v)}
        />
      </>
    );
  }

  if (effect === 'dispersion') {
    return (
      <>
        <SliderRow
          label="Sub-bands"
          value={params.dispersion.count}
          unit="ct"
          min={4}
          max={16}
          step={1}
          onChange={(v) => set('dispersion', 'count', Math.round(v))}
        />
        <SliderRow
          label="Sub-band width"
          value={params.dispersion.widthFrac}
          unit="× BW"
          min={0.1}
          max={0.5}
          step={0.01}
          decimals={2}
          onChange={(v) => set('dispersion', 'widthFrac', v)}
        />
        <SliderRow
          label="Overlap"
          value={params.dispersion.overlap}
          unit=""
          min={0}
          max={0.95}
          step={0.05}
          decimals={2}
          onChange={(v) => set('dispersion', 'overlap', v)}
        />
        <Radio
          label="Sub-band taper"
          value={params.dispersion.windowType}
          options={WINDOW_TYPES.map(w => ({ value: w, label: w.slice(0, 4) }))}
          onChange={(v) => set('dispersion', 'windowType', v)}
        />
        <SliderRow
          label="Coherent average"
          value={params.dispersion.avgN}
          unit="sweeps"
          min={1}
          max={Math.max(1, Math.min(32, summary.sweeps))}
          step={1}
          onChange={(v) => set('dispersion', 'avgN', Math.round(v))}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          One sweep is noisy at sub-band resolution; averaging a few coherently costs nothing
          on recorded data. The resulting sub-band resolution is printed on the canvas.
        </div>
      </>
    );
  }

  if (effect === 's21') {
    return (
      <>
        <Radio
          label="Component"
          value={params.s21.component}
          options={[
            { value: 'mag', label: 'Magnitude' },
            { value: 'phase', label: 'Phase (wrap)' },
            { value: 'unwrapped', label: 'Phase (unwrap)' },
            { value: 'reim', label: 'Real & imag' },
            { value: 'residual', label: 'Residual' },
          ]}
          onChange={(v) => set('s21', 'component', v)}
        />
        <Radio
          label="Display"
          value={params.s21.display}
          options={[
            { value: 'line', label: 'Single sweep' },
            { value: 'waterfall', label: 'All sweeps' },
          ]}
          onChange={(v) => set('s21', 'display', v)}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          Residual is unwrapped phase minus its linear fit — the direct corrupted-sweep
          detector. Anything past 0.3 rad is flagged red.
        </div>
      </>
    );
  }

  return null;
}

/** Window / zero-pad / range-comp: shared by every range-domain effect. */
function ProfileControls({ params, set }) {
  return (
    <>
      <Radio
        label="Window"
        value={params.profile.windowType}
        options={[
          { value: 'rectangular', label: 'Rect' },
          { value: 'hanning', label: 'Hann' },
          { value: 'kaiser', label: 'Kaiser' },
        ]}
        onChange={(v) => set('profile', 'windowType', v)}
      />
      {params.profile.windowType === 'kaiser' && (
        <SliderRow
          label="Kaiser β"
          value={params.profile.kaiserBeta}
          unit=""
          min={2}
          max={14}
          step={0.5}
          decimals={1}
          onChange={(v) => set('profile', 'kaiserBeta', v)}
        />
      )}
      <Radio
        label="Zero pad"
        value={params.profile.zeroPad}
        options={[
          { value: 2, label: '×2' },
          { value: 4, label: '×4' },
          { value: 8, label: '×8' },
        ]}
        onChange={(v) => set('profile', 'zeroPad', v)}
      />
      <Radio
        label="Range comp"
        value={params.profile.rangeComp}
        options={[
          { value: 0, label: 'Off' },
          { value: 2, label: 'R²' },
          { value: 4, label: 'R⁴' },
        ]}
        onChange={(v) => set('profile', 'rangeComp', v)}
      />
    </>
  );
}

/* ── Shared controls ────────────────────────────────────────────────────── */

/**
 * A slider with a numeric field beside it. Some of these want a precise value
 * typed rather than dragged for, so the field commits on Enter/blur and the
 * slider keeps working live.
 */
function SliderRow({ label, value, unit, min, max, step, onChange, disabled, decimals = 0 }) {
  const [draft, setDraft] = useState(null);

  const commit = () => {
    const num = parseFloat(draft);
    if (!isNaN(num)) onChange(Math.max(min, Math.min(max, num)));
    setDraft(null);
  };

  return (
    <div className={cn('flex flex-col gap-1', disabled && 'opacity-35 pointer-events-none')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium truncate">{label}</span>
        <div className="flex items-baseline gap-1 shrink-0">
          <input
            type="text"
            value={draft !== null ? draft : Number(value).toFixed(decimals)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => { setDraft(String(value)); e.target.select(); }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { commit(); e.target.blur(); }
              if (e.key === 'Escape') { setDraft(null); e.target.blur(); }
            }}
            disabled={disabled}
            className="w-12 bg-white/5 border border-white/10 rounded px-1 py-0.5 text-[10px] font-mono text-white/70 text-right outline-none focus:border-[#6B9BD2]/50 transition-all"
          />
          {unit && <span className="text-[9px] text-white/30 w-10 truncate">{unit}</span>}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={cn(
          'w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer accent-cyan-500',
          disabled && 'cursor-not-allowed',
        )}
      />
    </div>
  );
}

function Radio({ label, value, options, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(opt => (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-2 py-1 rounded text-[10px] font-medium border transition-all capitalize',
              value === opt.value
                ? 'bg-[#6B9BD2]/15 border-[#6B9BD2]/40 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
        active
          ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
          : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white',
      )}
    >
      {label}
    </button>
  );
}
