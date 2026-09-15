import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import { HANDHELD_AXES, UART_CHOICES, AVERAGE_WINDOWS_MS, originFromPose } from '@/lib/handheldPose';
import {
  fitProblems, acceptedMount, CAL_MIN_SAMPLES, CAL_MIN_ROT_DEG, CAL_MIN_SECOND_AXIS_DEG,
} from '@/lib/handheldTilt';

const STATUS_STYLE = {
  live:   'text-emerald-400 border-emerald-500/30 bg-emerald-500/5',
  held:   'text-amber-300 border-amber-400/30 bg-amber-400/5',
  lost:   'text-red-400 border-red-500/30 bg-red-500/5',
  absent: 'text-[#666] border-white/10 bg-white/[0.02]',
};

const fmtMm = (v) => (v == null ? '—' : `${v.toFixed(1)} mm`);
const fmtPos = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
const fmt = (v, d) => (v !== null && v !== undefined ? v.toFixed(d) : '—');

// Live gate on a calibration in progress, mirroring the gates the fit itself
// applies afterwards -- the operator should learn the run is degenerate while
// they can still fix it, not after they stop moving.
const calReady = (cal) => !!cal?.coverage
  && cal.coverage.maxDeg >= CAL_MIN_ROT_DEG
  && cal.coverage.spreadDeg[1] >= CAL_MIN_SECOND_AXIS_DEG
  && cal.coverage.n >= CAL_MIN_SAMPLES;

// At least one axis has to have produced something usable, or there is nothing
// to accept. Axes that failed keep the nominal mount, which is a fine fallback.
const calUsable = (result) => !!acceptedMount(result);

export default function HandheldPanel({
  isConnected, imuData, pose, origin, onOriginChange,
  assignment, onAssignmentChange, avgMs, onAvgMsChange,
  tiltEnabled, onTiltEnabledChange, mount, onMountChange,
  cal, onCalStart, onCalFinish, onCalCancel,
}) {
  const [resetNote, setResetNote] = useState(null);

  const handleSetOrigin = () => {
    const { origin: next, set, kept } = originFromPose(pose, origin);
    if (!set.length) {
      setResetNote({ bad: true, text: 'No LiDAR has a fresh reading, origin unchanged.' });
      return;
    }
    onOriginChange(next);
    const keptText = kept.map(k => {
      const had = Number.isFinite(origin?.[k]);
      return `${k.toUpperCase()} ${had ? 'kept its previous origin' : 'has no origin'}`;
    });
    setResetNote(kept.length
      ? { bad: true, text: `Set ${set.join(', ').toUpperCase()}. No fresh reading on ${keptText.join('; ')}.` }
      : { bad: false, text: 'Origin set on all three axes.' });
  };

  const handleAssign = (role, uart) => {
    onAssignmentChange({ ...assignment, [role]: uart });
    setResetNote({ bad: true, text: 'Wiring changed, origin cleared. Set it again.' });
  };

  const { x, y, z } = pose.pos;
  const range = x != null && y != null && z != null ? Math.hypot(x, y, z) : null;
  const anyReading = HANDHELD_AXES.some(a => pose.axes[a.key].mm != null);
  const used = HANDHELD_AXES.map(a => assignment?.[a.lidar]);
  const duplicate = new Set(used).size !== used.length;
  const primaryMismatch = pose.primary && assignment?.fwd && pose.primary !== assignment.fwd;

  const accel = imuData?.accel || [null, null, null];
  const gyro = imuData?.gyro || [null, null, null];

  return (
    <>
      <Section label="Position">
        <p className="text-[10px] text-[#555] uppercase tracking-wider">From origin (mm) · X right · Y up · Z fwd</p>
        <div className="grid grid-cols-3 gap-2">
          {HANDHELD_AXES.map(a => (
            <InfoTile key={a.key} label={a.label} value={fmtPos(pose.axes[a.key].posMm)} />
          ))}
        </div>
        <InfoTile label="Distance from origin" value={range == null ? '—' : `${range.toFixed(1)} mm`} />
      </Section>

      <Section label="Origin">
        <button
          onClick={handleSetOrigin}
          disabled={!isConnected || !anyReading}
          className={cn(
            'w-full py-2.5 rounded-xl border text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer',
            'border-[#D1855C]/40 bg-[#D1855C]/8 text-[#D1855C] hover:border-[#D1855C]/70',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          Set origin here
        </button>
        <div className="grid grid-cols-3 gap-2">
          {HANDHELD_AXES.map(a => (
            <InfoTile key={a.key} label={`${a.label} ref`} value={fmtMm(pose.axes[a.key].originMm)} />
          ))}
        </div>
        {resetNote && (
          <p className={cn('text-[11px] leading-relaxed', resetNote.bad ? 'text-amber-300' : 'text-[#777]')}>
            {resetNote.text}
          </p>
        )}
        <button
          onClick={() => { onOriginChange(null); setResetNote(null); }}
          disabled={!origin}
          className="py-2 rounded-xl border border-white/10 bg-[#0a0a0a]/60 text-[11px] font-semibold text-[#aaa] hover:border-white/25 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear origin
        </button>
      </Section>

      <Section label="Averaging">
        <div className="grid grid-cols-5 gap-1">
          {AVERAGE_WINDOWS_MS.map(ms => (
            <button
              key={ms}
              onClick={() => onAvgMsChange(ms)}
              className={cn(
                'py-1.5 rounded-lg border text-[11px] font-mono cursor-pointer transition-colors',
                avgMs === ms
                  ? 'border-[#22d3ee]/40 bg-[#22d3ee]/10 text-[#22d3ee]'
                  : 'border-white/10 bg-[#0a0a0a]/60 text-[#888] hover:border-white/25',
              )}
            >
              {ms === 0 ? 'Off' : ms}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[#555] leading-relaxed">
          Mean over the last {avgMs} ms. Jitter is ~1 mm with it off, ~0.6 mm at 100, ~0.5 mm at 250. Lag is about half the window.
        </p>
      </Section>

      <Section label="Tilt compensation">
        <button
          onClick={() => onTiltEnabledChange(!tiltEnabled)}
          className={cn(
            'w-full py-2 rounded-xl border text-[11px] font-semibold uppercase tracking-wider cursor-pointer transition-colors',
            tiltEnabled
              ? 'border-emerald-500/40 bg-emerald-500/8 text-emerald-400'
              : 'border-white/10 bg-[#0a0a0a]/60 text-[#888] hover:border-white/25',
          )}
        >
          {tiltEnabled ? 'On' : 'Off'}
        </button>
        <div className="grid grid-cols-3 gap-2">
          {HANDHELD_AXES.map(a => {
            const ax = pose.axes[a.key];
            return (
              <InfoTile
                key={a.key}
                label={`${a.label} tilt`}
                value={ax.tiltDeg == null ? '—' : `${ax.tiltDeg.toFixed(1)}°`}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {HANDHELD_AXES.map(a => (
            <InfoTile
              key={a.key}
              label={`${a.label} corr`}
              value={pose.axes[a.key].tiltGainMm == null ? '—' : `${fmtPos(pose.axes[a.key].tiltGainMm)} mm`}
            />
          ))}
        </div>
        {tiltEnabled && !pose.hasOrientation && isConnected && (
          <p className="text-[11px] text-amber-300 leading-relaxed">
            No orientation from the IMU, so nothing is corrected. Check the BNO085 on the Pi.
          </p>
        )}
        {tiltEnabled && pose.hasOrientation && !origin && (
          <p className="text-[11px] text-[#777] leading-relaxed">
            Set the origin to start correcting. Hold the module square to its surfaces when you do —
            each reading is at its MINIMUM when that beam is perpendicular.
          </p>
        )}
        {HANDHELD_AXES.filter(a => pose.axes[a.key].grazing).map(a => (
          <p key={a.key} className="text-[11px] text-amber-300 leading-relaxed">
            {a.name} is past 90° from its surface; that axis is not corrected.
          </p>
        ))}
        <p className="text-[10px] text-[#555] leading-relaxed">
          {mount
            ? `Calibrated mount in use${mount.at ? ` · ${new Date(mount.at).toLocaleDateString()}` : ''}.`
            : 'Using the nominal mount. That is worth ~1 mm at 20° tilt against ~51 mm uncorrected, so calibration is a refinement.'}
        </p>
      </Section>

      <Section label="Mount calibration">
        {!cal && (
          <>
            <button
              onClick={onCalStart}
              disabled={!isConnected || !pose.hasOrientation}
              className={cn(
                'w-full py-2.5 rounded-xl border text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer',
                'border-[#D1855C]/40 bg-[#D1855C]/8 text-[#D1855C] hover:border-[#D1855C]/70',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              Start calibration
            </button>
            <p className="text-[10px] text-[#555] leading-relaxed">
              Finds where each LiDAR points relative to the IMU. Stand in a corner so all three
              beams see a surface, hold the module in ONE SPOT, and tumble it about two different
              axes — at least {CAL_MIN_ROT_DEG}°. Rotating about one axis only cannot be solved and
              is rejected.
            </p>
          </>
        )}

        {cal?.active && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <InfoTile label="Time" value={`${cal.elapsedS.toFixed(0)} s`} />
              <InfoTile label="Rotated" value={cal.coverage ? `${cal.coverage.maxDeg.toFixed(0)}°` : '—'} />
              <InfoTile label="2nd axis" value={cal.coverage ? `${cal.coverage.spreadDeg[1].toFixed(1)}°` : '—'} />
            </div>
            <p className={cn('text-[11px] leading-relaxed',
              calReady(cal) ? 'text-emerald-400' : 'text-amber-300')}>
              {calReady(cal)
                ? 'Enough movement. Finish when ready.'
                : `Keep tumbling — need ${CAL_MIN_ROT_DEG}° of rotation about two axes and ${CAL_MIN_SAMPLES} samples.`}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={onCalFinish}
                className="py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/8 text-[11px] font-semibold uppercase tracking-wider text-emerald-400 cursor-pointer"
              >
                Finish
              </button>
              <button
                onClick={onCalCancel}
                className="py-2 rounded-xl border border-white/10 bg-[#0a0a0a]/60 text-[11px] font-semibold text-[#aaa] hover:border-white/25 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {cal && !cal.active && cal.result && (
          <>
            {HANDHELD_AXES.map(a => {
              const f = cal.result.axes[a.key];
              const probs = fitProblems(f);
              return (
                <div key={a.key} className="flex flex-col gap-1 p-2.5 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-[#888]">{a.name}</span>
                    <span className={cn('px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wider',
                      probs.length ? STATUS_STYLE.lost : STATUS_STYLE.live)}>
                      {probs.length ? 'REJECTED' : 'OK'}
                    </span>
                  </div>
                  {f && (
                    <div className="text-[10px] font-mono text-[#666]">
                      {f.mountDeg.toFixed(1)}° from nominal · {f.rmsMm.toFixed(1)} mm residual · {f.H.toFixed(0)} mm range
                    </div>
                  )}
                  {probs.length > 0 && (
                    <div className="text-[10px] text-amber-300 leading-relaxed">{probs.join('; ')}</div>
                  )}
                </div>
              );
            })}
            {cal.result.orthoDeg != null && (
              <p className="text-[10px] text-[#555] leading-relaxed">
                The three fitted beams are {cal.result.orthoDeg.toFixed(1)}° off mutually perpendicular.
                They are mounted square, and nothing in the fit knows that, so a large number here means
                the run was bad even where the per-axis checks passed.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { onMountChange(acceptedMount(cal.result)); onCalCancel(); }}
                disabled={!calUsable(cal.result)}
                className={cn(
                  'py-2 rounded-xl border text-[11px] font-semibold uppercase tracking-wider cursor-pointer',
                  'border-emerald-500/40 bg-emerald-500/8 text-emerald-400',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                Use it
              </button>
              <button
                onClick={onCalCancel}
                className="py-2 rounded-xl border border-white/10 bg-[#0a0a0a]/60 text-[11px] font-semibold text-[#aaa] hover:border-white/25 cursor-pointer"
              >
                Discard
              </button>
            </div>
          </>
        )}

        {mount && !cal && (
          <button
            onClick={() => onMountChange(null)}
            className="py-2 rounded-xl border border-white/10 bg-[#0a0a0a]/60 text-[11px] font-semibold text-[#aaa] hover:border-white/25 cursor-pointer"
          >
            Clear calibration
          </button>
        )}
      </Section>

      <Section label="Wiring">
        <div className="grid grid-cols-3 gap-2">
          {HANDHELD_AXES.map(a => (
            <label key={a.key} className="flex flex-col gap-1 p-2 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#555]">{a.name}</span>
              <select
                value={assignment?.[a.lidar] ?? ''}
                onChange={e => handleAssign(a.lidar, e.target.value)}
                className="bg-transparent text-xs font-mono text-white outline-none cursor-pointer"
              >
                {UART_CHOICES.map(u => (
                  <option key={u} value={u} className="bg-black">
                    {u}{pose.uarts.length && !pose.uarts.includes(u) ? ' (none)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {duplicate && (
          <p className="text-[11px] text-amber-300 leading-relaxed">Two directions are set to the same UART.</p>
        )}
        {primaryMismatch && (
          <p className="text-[11px] text-amber-300 leading-relaxed">
            The Pi's standoff LiDAR is {pose.primary}, but forward is set to {assignment.fwd}. Radar standoff and
            rover tracking use {pose.primary}. Check stream.py's LIDAR_PORTS_DEFAULT.
          </p>
        )}
        {pose.uarts.length > 0 && (
          <p className="text-[10px] text-[#555] font-mono">
            Pi publishes: {pose.uarts.join(', ')}{pose.primary ? ` · standoff = ${pose.primary}` : ''}
          </p>
        )}
      </Section>

      <Section label="LiDARs">
        {pose.legacy && isConnected && (
          <p className="text-[11px] text-amber-300 leading-relaxed">
            The Pi's stream.py does not publish the handheld LiDARs. Only the forward LiDAR is available.
          </p>
        )}
        {HANDHELD_AXES.map(a => {
          const ax = pose.axes[a.key];
          const statusText = ax.status === 'held' ? `HELD ${ax.ageS.toFixed(1)}s` : ax.status.toUpperCase();
          return (
            <div key={a.key} className="flex flex-col gap-1.5 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[#888]">
                  {a.name} · {a.label}
                </span>
                <span className={cn('px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wider', STATUS_STYLE[ax.status])}>
                  {isConnected ? statusText : '—'}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-white">{fmtMm(ax.mm)}</span>
                <span className="text-[10px] font-mono text-[#555]">
                  {ax.hz == null ? '— meas/s' : `${ax.hz.toFixed(1)} meas/s`}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
                <span className="text-[#444]">{[ax.uart, ax.port].filter(Boolean).join(' · ')}</span>
                {ax.err && ax.status !== 'live' && <span className="text-[#777] truncate">{ax.err}</span>}
              </div>
            </div>
          );
        })}
      </Section>

      <Section label="IMU">
        <p className="text-[10px] text-[#555] uppercase tracking-wider">Accelerometer · body frame (g)</p>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Fwd" value={fmt(accel[0], 4)} />
          <InfoTile label="Left" value={fmt(accel[1], 4)} />
          <InfoTile label="Up" value={fmt(accel[2], 4)} />
        </div>
        <p className="text-[10px] text-[#555] uppercase tracking-wider">Gyroscope · body frame (°/s)</p>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Roll" value={fmt(gyro[0], 2)} />
          <InfoTile label="Pitch" value={fmt(gyro[1], 2)} />
          <InfoTile label="Yaw" value={fmt(gyro[2], 2)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Heading °" value={fmt(imuData?.yaw_deg ?? null, 1)} />
          <InfoTile label="Temp °C" value={fmt(imuData?.temp ?? null, 1)} />
        </div>
      </Section>

      {!isConnected && (
        <div className="flex items-center justify-center p-4 rounded-xl border border-white/5 bg-[#0a0a0a]/30">
          <span className="text-[10px] text-[#333] uppercase tracking-widest">Connect to view live data</span>
        </div>
      )}
    </>
  );
}
