import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

export default function RfCalibPanel({ isConnected, sdrConnected, txActive, rxActive, showFFT, onToggleFFT, graphPaused, onTogglePause, sendSdr }) {
  const [freq, setFreq] = useState(2000);
  const [txGain, setTxGain] = useState(50);
  const [txAmp, setTxAmp] = useState(100);
  const [rxGain, setRxGain] = useState(25);
  const [waveform, setWaveform] = useState('cw');
  const [cwOffset, setCwOffset] = useState(100);
  const [chirpBw, setChirpBw] = useState(500);
  const [chirpDur, setChirpDur] = useState(1);
  const [sampleRate, setSampleRate] = useState(10);

  const canActivate = isConnected && sdrConnected;

  return (
    <>
      {/* Frequency */}
      <Section label="Center Frequency">
                <FreqField
          value={freq}
          onChange={(v) => { setFreq(v); sendSdr({ cmd: 'set_freq', value: v }); }}
        />
      </Section>

      {/* Sample Rate */}
      <Section label="Sample Rate">
        <SampleRateField
          value={sampleRate}
          onChange={(v) => { setSampleRate(v); sendSdr({ cmd: 'set_sample_rate', value: v }); }}
        />
      </Section>

      {/* Transmission */}
      <Section label="Transmission">
        <ToggleButton
          active={txActive}
          canActivate={canActivate}
          onToggle={() => sendSdr({ cmd: txActive ? 'stop_tx' : 'start_tx' })}
          activeLabel="Stop Transmission"
          idleLabel="Start Transmission"
          activeSubLabel={waveform === 'cw' ? 'CW tone on TX1 antenna' : 'Chirp on TX1 antenna'}
          idleSubLabel={!sdrConnected ? 'SDR not connected' : 'Ready to transmit'}
          color="orange"
        />

        {/* Waveform select */}
        <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Waveform</span>
          </div>
          <select
            value={waveform}
            onChange={e => {
              const v = e.target.value;
              setWaveform(v);
              sendSdr({ cmd: 'set_waveform', type: v, offset_khz: cwOffset, amplitude: txAmp / 100, chirp_bw_khz: chirpBw, chirp_duration_ms: chirpDur });
            }}
            className="bg-[#111] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white outline-none cursor-pointer appearance-none"
          >
            <option value="cw">CW (Continuous Wave)</option>
            <option value="chirp">Chirp (Linear FM)</option>
          </select>
        </div>

        {/* CW Offset — only for CW mode */}
        {waveform === 'cw' && (
          <OffsetField
            value={cwOffset}
            onChange={(v) => { setCwOffset(v); sendSdr({ cmd: 'set_waveform', type: waveform, offset_khz: v, amplitude: txAmp / 100 }); }}
          />
        )}

        {/* Chirp params — only for chirp mode */}
        {waveform === 'chirp' && (
          <>
            <ChirpBwField
              value={chirpBw}
              onChange={(v) => { setChirpBw(v); sendSdr({ cmd: 'set_waveform', type: waveform, chirp_bw_khz: v, chirp_duration_ms: chirpDur, amplitude: txAmp / 100 }); }}
            />
            <ChirpDurField
              value={chirpDur}
              onChange={(v) => { setChirpDur(v); sendSdr({ cmd: 'set_waveform', type: waveform, chirp_bw_khz: chirpBw, chirp_duration_ms: v, amplitude: txAmp / 100 }); }}
            />
          </>
        )}

        {/* TX Gain */}
        <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">TX Gain</span>
            <span className="text-sm font-semibold font-mono text-[#D1855C]">{txGain} dB</span>
          </div>
          <input
            type="range" min={-23} max={66} step={1} value={txGain}
            onChange={e => setTxGain(Number(e.target.value))}
            onPointerUp={e => sendSdr({ cmd: 'set_tx_gain', value: Number(e.target.value) })}
            className="imu-slider"
            style={{ '--pct': `${((txGain + 23) / 89) * 100}%` }}
          />
          <div className="flex justify-between">
            <span className="text-[9px] text-[#333333]">-23</span>
            <span className="text-[9px] text-[#333333]">66 dB</span>
          </div>
        </div>

        {/* Amplitude */}
        <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Amplitude</span>
            <span className="text-sm font-semibold font-mono text-[#D1855C]">{txAmp}%</span>
          </div>
          <input
            type="range" min={0} max={100} step={1} value={txAmp}
            onChange={e => setTxAmp(Number(e.target.value))}
            onPointerUp={() => sendSdr({ cmd: 'set_waveform', type: waveform, offset_khz: cwOffset, amplitude: txAmp / 100 })}
            className="imu-slider"
            style={{ '--pct': `${txAmp}%` }}
          />
        </div>
      </Section>

      {/* Reception */}
      <Section label="Reception">
        <ToggleButton
          active={rxActive}
          canActivate={canActivate}
          onToggle={() => sendSdr({ cmd: rxActive ? 'stop_rx' : 'start_rx' })}
          activeLabel="Stop Reception"
          idleLabel="Start Reception"
          activeSubLabel="Streaming IQ from RX1"
          idleSubLabel={!sdrConnected ? 'SDR not connected' : 'Ready to receive'}
          color="cyan"
        />

        {/* RX Gain */}
        <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">RX Gain</span>
            <span className="text-sm font-semibold font-mono text-[#22d3ee]">{rxGain} dB</span>
          </div>
          <input
            type="range" min={0} max={60} step={1} value={rxGain}
            onChange={e => setRxGain(Number(e.target.value))}
            onPointerUp={e => sendSdr({ cmd: 'set_rx_gain', value: Number(e.target.value) })}
            className="rx-slider"
            style={{ '--pct': `${(rxGain / 60) * 100}%` }}
          />
          <div className="flex justify-between">
            <span className="text-[9px] text-[#333333]">0</span>
            <span className="text-[9px] text-[#333333]">60 dB</span>
          </div>
        </div>

        {/* FFT + Pause toggles */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onToggleFFT(!showFFT)}
            className={cn(
              'py-3 rounded-2xl text-xs font-semibold uppercase tracking-widest',
              'border transition-all duration-200 cursor-pointer',
              showFFT
                ? 'bg-[#22d3ee]/12 text-[#22d3ee] border-[#22d3ee]/30'
                : 'bg-[#0a0a0a]/50 text-[#666666] border-white/5 hover:bg-white/8',
            )}
          >
            FFT
          </button>
          <button
            onClick={() => onTogglePause(!graphPaused)}
            className={cn(
              'py-3 rounded-2xl text-xs font-semibold uppercase tracking-widest',
              'border transition-all duration-200 cursor-pointer',
              graphPaused
                ? 'bg-[#D1855C]/12 text-[#D1855C] border-[#D1855C]/30'
                : 'bg-[#0a0a0a]/50 text-[#666666] border-white/5 hover:bg-white/8',
            )}
          >
            {graphPaused ? 'Play' : 'Pause'}
          </button>
        </div>

        {/* Device Reset */}
        <button
          onClick={() => sendSdr({ cmd: 'device_reset' })}
          disabled={!canActivate}
          className={cn(
            'w-full py-3 rounded-2xl text-xs font-semibold uppercase tracking-widest',
            'border transition-all duration-200 cursor-pointer',
            'bg-[#ef4444]/8 text-[#ef4444] border-[#ef4444]/20 hover:bg-[#ef4444]/15',
            !canActivate && 'opacity-30 cursor-not-allowed',
          )}
        >
          Reset Device
        </button>
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
        'relative flex items-center justify-between p-4 rounded-2xl border',
        'transition-all duration-300',
        editing
          ? 'border-[#D1855C]/40 bg-[#D1855C]/5 cursor-text'
          : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
        {editing ? (
          <div className="flex items-baseline gap-1.5">
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
              className="bg-transparent text-xl font-bold font-mono text-white outline-none w-20"
            />
            <span className="text-sm font-semibold text-[#888888]">{unit}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-white">{value}</span>
            <span className="text-sm font-semibold text-[#888888]">{unit}</span>
          </div>
        )}
      </div>
      {!editing && (
        <span className="text-[9px] font-medium uppercase tracking-widest text-[#333333] self-end pb-0.5">
          tap to edit
        </span>
      )}
      {editing && (
        <div className="absolute bottom-0 left-4 right-4 h-px bg-gradient-to-r from-[#D1855C] to-[#E5A986] rounded-full" />
      )}
    </div>
  );
}

function FreqField({ value, onChange }) {
  return <EditableField label="Frequency" value={value} unit="MHz" onChange={onChange} min={47} max={6000} />;
}

function OffsetField({ value, onChange }) {
  return <EditableField label="Offset" value={value} unit="kHz" onChange={onChange} min={0} max={5000} />;
}

function SampleRateField({ value, onChange }) {
  return <EditableField label="Sample Rate" value={value} unit="MSPS" onChange={onChange} min={0.5} max={40} />;
}

function ChirpBwField({ value, onChange }) {
  return <EditableField label="Chirp BW" value={value} unit="kHz" onChange={onChange} min={10} max={20000} />;
}

function ChirpDurField({ value, onChange }) {
  return <EditableField label="Chirp Duration" value={value} unit="ms" onChange={onChange} min={0.1} max={100} />;
}
