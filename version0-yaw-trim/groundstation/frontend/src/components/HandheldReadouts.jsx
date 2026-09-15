import { cn } from '@/lib/utils';
import { HANDHELD_AXES } from '@/lib/handheldPose';

// Text readouts for the Handheld viewport quadrants. The IMU orientation quadrant
// is ImuDisplay itself.

const STATUS_TEXT = {
  live: 'text-[#22d3ee]',
  held: 'text-amber-300',
  lost: 'text-red-400',
  absent: 'text-[#444]',
};

const fmtSigned = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);
const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));

export function HandheldPositionReadout({ pose }) {
  const { x, y, z } = pose.pos;
  const range = x != null && y != null && z != null ? Math.hypot(x, y, z) : null;
  const noOrigin = HANDHELD_AXES.every(a => pose.axes[a.key].originMm == null);
  // Spacing in this file is inline: index.css has an unlayered `margin: 0; padding: 0`
  // reset that overrides Tailwind's padding/margin utilities.
  return (
    <div className="h-full flex flex-col justify-center gap-3 font-mono" style={{ padding: '16px 32px' }}>
      {HANDHELD_AXES.map(a => {
        const ax = pose.axes[a.key];
        return (
          <div key={a.key} className="flex items-baseline gap-4">
            <span className="w-6 text-2xl text-[#555]">{a.label}</span>
            <span className={cn('min-w-[7ch] text-right text-5xl tabular-nums',
              ax.posMm == null ? 'text-[#333]' : STATUS_TEXT[ax.status])}>
              {fmtSigned(ax.posMm)}
            </span>
            <span className="text-lg text-[#555]">mm</span>
            <span className="text-xs text-[#444] uppercase tracking-wider">{a.dir}</span>
          </div>
        );
      })}
      <div className="text-sm text-[#666]" style={{ marginTop: 8 }}>
        |r| {range == null ? '—' : `${range.toFixed(1)} mm`}
        {pose.windowMs > 0 && <span className="text-[#444]" style={{ marginLeft: 16 }}>avg {pose.windowMs} ms</span>}
        {/* Say what was DONE, not what was asked for: `tiltActive` is false when
            any part of the chain (no IMU, no origin attitude, grazing) made the
            correction fall back, and those numbers are then the raw ones. */}
        <span className={cn('uppercase tracking-wider text-xs', pose.tiltActive ? 'text-emerald-500/70' : 'text-[#444]')}
              style={{ marginLeft: 16 }}>
          {pose.tiltActive ? 'tilt corrected' : 'no tilt corr'}
        </span>
      </div>
      {noOrigin && pose.connected && (
        <div className="text-xs text-amber-300/80">No origin set. Press “Set origin here” in the panel.</div>
      )}
    </div>
  );
}

export function HandheldLidarReadout({ pose }) {
  return (
    <div className="h-full overflow-auto" style={{ padding: '16px 24px' }}>
      <table className="w-full font-mono text-sm" style={{ borderSpacing: '12px 8px', borderCollapse: 'separate' }}>
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-[#555] text-left">
            <th className="pb-2 font-medium">Head</th>
            <th className="pb-2 font-medium">UART</th>
            <th className="pb-2 font-medium text-right">Distance</th>
            <th className="pb-2 font-medium text-right">Raw</th>
            <th className="pb-2 font-medium text-right">Tilt</th>
            <th className="pb-2 font-medium text-right">Meas/s</th>
            <th className="pb-2 font-medium pl-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {HANDHELD_AXES.map(a => {
            const ax = pose.axes[a.key];
            const primary = pose.primary && ax.uart === pose.primary;
            return (
              <tr key={a.key} className="border-t border-white/5">
                <td className="py-2 text-[#aaa]">{a.name} <span className="text-[#555]">{a.label}</span></td>
                <td className="py-2 text-[#777]">{ax.uart ?? '—'}{primary && <span className="text-[10px] text-[#D1855C]" style={{ marginLeft: 6 }}>PRIMARY</span>}</td>
                <td className="py-2 text-right text-white tabular-nums">{fmt(ax.mm)} <span className="text-[#555]">mm</span></td>
                <td className="py-2 text-right text-[#666] tabular-nums">{ax.rawMm == null ? '—' : ax.rawMm}</td>
                {/* Incidence angle of this beam against its surface, relative to
                    the origin pose. Also the aiming aid: hold every axis near 0
                    when declaring the origin and the correction's one remaining
                    approximation (see handheldTilt.js) costs nothing. */}
                <td className={cn('py-2 text-right tabular-nums',
                  ax.grazing ? 'text-red-400' : ax.tiltDeg == null ? 'text-[#444]'
                    : ax.tiltDeg > 25 ? 'text-amber-300' : 'text-[#777]')}>
                  {ax.tiltDeg == null ? '—' : `${ax.tiltDeg.toFixed(1)}°`}
                </td>
                <td className="py-2 text-right text-[#777] tabular-nums">{fmt(ax.hz)}</td>
                <td className={cn('py-2 pl-4 text-xs', STATUS_TEXT[ax.status])}>
                  {ax.status === 'held' ? `held ${ax.ageS.toFixed(1)}s` : ax.status}
                  {ax.err && ax.status !== 'live' && <span className="text-[#555]" style={{ marginLeft: 8 }}>{ax.err}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ImuReadout({ imuData }) {
  const accel = imuData?.accel || [null, null, null];
  const gyro = imuData?.gyro || [null, null, null];
  const rows = [
    ['Accel (g)', [['Fwd', accel[0], 4], ['Left', accel[1], 4], ['Up', accel[2], 4]]],
    ['Gyro (°/s)', [['Roll', gyro[0], 2], ['Pitch', gyro[1], 2], ['Yaw', gyro[2], 2]]],
    ['Other', [['Heading °', imuData?.yaw_deg ?? null, 1], ['Temp °C', imuData?.temp ?? null, 1]]],
  ];
  return (
    <div className="h-full overflow-auto flex flex-col gap-4 font-mono" style={{ padding: '16px 24px' }}>
      {rows.map(([title, cells]) => (
        <div key={title} className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#555]">{title}</span>
          <div className="grid grid-cols-3 gap-2">
            {cells.map(([label, v, d]) => (
              <div key={label} className="flex flex-col">
                <span className="text-[10px] text-[#444]">{label}</span>
                <span className={cn('text-lg tabular-nums', v == null ? 'text-[#333]' : 'text-white')}>{fmt(v, d)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
