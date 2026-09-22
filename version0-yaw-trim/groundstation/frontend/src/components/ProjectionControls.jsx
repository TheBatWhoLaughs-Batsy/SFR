import { useState } from 'react';
import { cn } from '@/lib/utils';
import { InfoTile } from './Sidebar';
import EditableField from './EditableField';
import { listDisplays } from './ProjectorWindow';

// To-scale / px-per-cm / placement controls and the projector-window button. Shared by
// the C-scan panel and the Projector Demo panel, so a calibration is set the same way in
// both. `projection` is { toScale, pxPerCm, leftPx, topPx, ... }; `onProjectionChange`
// takes a value or an updater. `projector` is null (closed), { target } or
// { error: 'blocked' }.
export default function ProjectionControls({
  projection, onProjectionChange, projector, onProjectorChange,
  widthCm, heightCm, hStep, vStep,
}) {
  const proj = projection;
  // Displays offered for the projector window; null when the picker is closed.
  const [displays, setDisplays] = useState(null);
  const [projectorNote, setProjectorNote] = useState(null);

  // Relative, so they go through the updater form -- clicking faster than React
  // re-renders must compose rather than collapse to a single step.
  const nudgeScale = (f) => onProjectionChange(p => ({
    ...p,
    pxPerCm: Math.min(200, Math.max(0.2, Math.round(p.pxPerCm * f * 1000) / 1000)),
  }));
  const nudgePlace = (key, d) => onProjectionChange(p => ({
    ...p,
    [key]: Math.round((p[key] + d) * 10) / 10,
  }));

  // Display picker for the projector window. `listDisplays()` needs a user
  // gesture (it is what prompts for the window-management permission), so it
  // runs on the click rather than on mount -- and it returns null wherever the
  // browser will not enumerate displays at all, which is not an error, just the
  // case where the operator has to drag the window across themselves.
  const openProjector = async () => {
    setProjectorNote(null);
    const found = await listDisplays();
    if (!found || found.length < 2) {
      // Nothing to choose between: either the API is unavailable, or this
      // machine has one screen and the projector is not attached yet.
      setDisplays(null);
      onProjectorChange({ target: found && found.length === 1 ? found[0] : null });
      if (!found) {
        setProjectorNote('This browser will not list displays — drag the window to the projector and press F11. Chrome can list them if you allow window management.');
      } else {
        setProjectorNote('Only one display detected. Connect the projector, then reopen to pick it.');
      }
      return;
    }
    setDisplays(found);
  };

  return (
    <>
      <button
        onClick={() => onProjectionChange({ ...proj, toScale: !proj.toScale })}
        className={cn(
          'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
          proj.toScale
            ? 'bg-[#4aff8a]/10 border-[#4aff8a]/40 text-[#4aff8a]'
            : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80',
        )}
      >
        {proj.toScale ? '● To scale' : 'Fit to pane'}
      </button>

      <EditableField
        label="Scale"
        value={proj.pxPerCm}
        unit="px/cm"
        onChange={(v) => onProjectionChange({ ...proj, pxPerCm: v })}
        min={0.2}
        max={200}
        locked={!proj.toScale}
      />

      {/* Multiplicative trim, because aligning a projected image is a matter
          of a few percent either way rather than a fixed number of pixels. */}
      <div className="grid grid-cols-4 gap-1.5">
        {[['-5%', 1 / 1.05], ['-1%', 1 / 1.01], ['+1%', 1.01], ['+5%', 1.05]].map(([label, f]) => (
          <button
            key={label}
            disabled={!proj.toScale}
            onClick={() => nudgeScale(f)}
            className={cn(
              'px-2 py-1.5 rounded-lg text-[10px] font-mono font-semibold transition-all border',
              proj.toScale
                ? 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:border-white/25'
                : 'bg-[#0a0a0a]/40 border-white/5 text-white/20 cursor-not-allowed',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Placement. Measured from the top-left of the VIEWPORT (everything
          right of this sidebar), not of the C-scan canvas, so the projected
          grid holds its position when the Live Sweep pane appears or a row's
          B-scan opens underneath it. */}
      <div className="px-1 pt-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">
        Grid top-left, from the viewport corner
      </div>
      <div className="grid grid-cols-2 gap-2">
        <EditableField
          label="Left"
          value={proj.leftPx}
          unit="px"
          onChange={(v) => onProjectionChange({ ...proj, leftPx: v })}
          min={-20000}
          max={20000}
          locked={!proj.toScale}
        />
        <EditableField
          label="Top"
          value={proj.topPx}
          unit="px"
          onChange={(v) => onProjectionChange({ ...proj, topPx: v })}
          min={-20000}
          max={20000}
          locked={!proj.toScale}
        />
      </div>

      {[['leftPx', 'Left'], ['topPx', 'Top']].map(([key, label]) => (
        <div key={key} className="flex items-center gap-1.5">
          <span className="w-7 shrink-0 text-[9px] font-medium uppercase tracking-wider text-[#555555]">
            {label}
          </span>
          {[-10, -1, 1, 10].map(d => (
            <button
              key={d}
              disabled={!proj.toScale}
              onClick={() => nudgePlace(key, d)}
              className={cn(
                'flex-1 px-1 py-1.5 rounded-lg text-[10px] font-mono font-semibold transition-all border',
                proj.toScale
                  ? 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:border-white/25'
                  : 'bg-[#0a0a0a]/40 border-white/5 text-white/20 cursor-not-allowed',
              )}
            >
              {d > 0 ? `+${d}` : d}
            </button>
          ))}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-2">
        <InfoTile
          label="Grid on screen"
          value={proj.toScale
            ? `${(widthCm * proj.pxPerCm).toFixed(0)} × ${(heightCm * proj.pxPerCm).toFixed(0)} px`
            : 'fitted'}
        />
        <InfoTile
          label="Cell on screen"
          value={proj.toScale
            ? `${(hStep * proj.pxPerCm).toFixed(1)} × ${(vStep * proj.pxPerCm).toFixed(1)} px`
            : '—'}
        />
      </div>

      {/* Projector output. A second window holding the grid and nothing
          else, opened on a chosen display and full-screened there. It reads
          the same scale and placement as the pane above, so this section
          stays the control surface while the wall shows the result. */}
      <div className="px-1 pt-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">
        Projector output
      </div>
      {projector && projector.error === 'blocked' ? null : projector ? (
        <>
          <button
            onClick={() => onProjectorChange(null)}
            className="w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]"
          >
            ● Close projector window
          </button>
          <div className="px-2 text-[9px] text-white/40">
            Showing on <span className="text-white/70">{projector.target ? projector.target.label : 'a free window'}</span>
          </div>
        </>
      ) : displays ? (
        <>
          <div className="px-2 text-[9px] text-white/40 leading-relaxed">
            Pick the display the projector is on:
          </div>
          {displays.map(d => (
            <button
              key={d.id}
              onClick={() => { setDisplays(null); onProjectorChange({ target: d }); }}
              className="w-full px-3 py-2 rounded-lg text-left text-xs font-medium transition-all border bg-white/5 border-white/10 text-white/70 hover:text-white hover:border-white/25"
            >
              {d.label}
              <span className="ml-2 text-[9px] font-mono text-white/35">
                {d.width}×{d.height}{d.isInternal ? ' · built-in' : ''}
              </span>
            </button>
          ))}
          <button
            onClick={() => setDisplays(null)}
            className="w-full px-3 py-1.5 rounded-lg text-[10px] font-medium border bg-transparent border-white/10 text-white/40 hover:text-white/70"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          onClick={openProjector}
          disabled={!proj.toScale}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            proj.toScale
              ? 'bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] hover:border-[#4aff8a]/60'
              : 'bg-[#0a0a0a]/40 border-white/5 text-white/20 cursor-not-allowed',
          )}
        >
          Open projector view…
        </button>
      )}
      {projector && projector.error === 'blocked' && (
        <div className="px-2 py-1.5 rounded-lg bg-[#ff4d6d]/5 border border-[#ff4d6d]/30 text-[9px] text-[#ff4d6d] leading-relaxed">
          The browser blocked the popup. Allow pop-ups for this page, then try
          again.
        </div>
      )}
      {projectorNote && (
        <div className="px-2 py-1.5 rounded-lg bg-[#f59e0b]/5 border border-[#f59e0b]/30 text-[9px] text-[#f59e0b] leading-relaxed">
          {projectorNote}
        </div>
      )}
    </>
  );
}
