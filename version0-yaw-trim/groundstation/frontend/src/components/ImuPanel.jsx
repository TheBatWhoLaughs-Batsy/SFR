import { Section, InfoTile } from './Sidebar';

export default function ImuPanel({ isConnected, imuData }) {
  const accel = imuData?.accel || [null, null, null];
  const gyro = imuData?.gyro || [null, null, null];
  const temp = imuData?.temp ?? null;

  const fmt = (v, d = 3) => v !== null && v !== undefined ? v.toFixed(d) : '—';

  return (
    <>
      <Section label="Accelerometer">
        <p className="text-[10px] text-[#555] uppercase tracking-wider">Body frame (g)</p>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Fwd" value={fmt(accel[0], 4)} />
          <InfoTile label="Left" value={fmt(accel[1], 4)} />
          <InfoTile label="Up" value={fmt(accel[2], 4)} />
        </div>
      </Section>

      <Section label="Gyroscope">
        <p className="text-[10px] text-[#555] uppercase tracking-wider">Body frame (°/s)</p>
        <div className="grid grid-cols-3 gap-2">
          <InfoTile label="Roll" value={fmt(gyro[0], 2)} />
          <InfoTile label="Pitch" value={fmt(gyro[1], 2)} />
          <InfoTile label="Yaw" value={fmt(gyro[2], 2)} />
        </div>
      </Section>

      <Section label="Temperature">
        <InfoTile label="°C" value={fmt(temp, 1)} />
      </Section>

      {!isConnected && (
        <div className="flex items-center justify-center p-4 rounded-xl border border-white/5 bg-[#0a0a0a]/30">
          <span className="text-[10px] text-[#333] uppercase tracking-widest">Connect to view live data</span>
        </div>
      )}
    </>
  );
}
