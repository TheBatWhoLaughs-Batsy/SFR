import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Crosshair, OctagonX, Ruler } from 'lucide-react';
import { Section, InfoTile, ErrorBadge } from './Sidebar';

// The firmware stops a jog on its own if refreshes stop arriving (500 ms by
// default), so the heartbeat has to be comfortably faster than that. 150 ms
// survives three lost frames before the rover coasts to a halt by itself.
const HOLD_INTERVAL_MS = 150;

const DIRS = {
  up:    { axis: 'y', dir:  1, icon: ChevronUp,    key: 'ArrowUp' },
  down:  { axis: 'y', dir: -1, icon: ChevronDown,  key: 'ArrowDown' },
  left:  { axis: 'x', dir: -1, icon: ChevronLeft,  key: 'ArrowLeft' },
  right: { axis: 'x', dir:  1, icon: ChevronRight, key: 'ArrowRight' },
};

export default function RoverPanel({
  roverConnected, roverStatus, sendRover, onClearTrail,
}) {
  const cfg = roverStatus?.config;
  const yaw = roverStatus?.yaw;
  const linked = roverConnected && roverStatus?.board_connected;
  const estopped = !!roverStatus?.estop;
  const canMove = linked && !estopped;

  const [posDraftX, setPosDraftX] = useState('0');
  const [posDraftY, setPosDraftY] = useState('0');
  const [nudgeMm, setNudgeMm] = useState('1');
  const [calAxis, setCalAxis] = useState('x');
  const [calCommanded, setCalCommanded] = useState('500');
  const [calMeasured, setCalMeasured] = useState('');
  const [showMotion, setShowMotion] = useState(false);

  // Which direction is currently held. A ref because the pointer and keyboard
  // handlers both need to read it synchronously, and a stale closure here would
  // leave the rover driving with nothing holding it.
  const heldRef = useRef(null);
  const timerRef = useRef(null);
  const [held, setHeld] = useState(null);

  const endJog = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (heldRef.current) {
      heldRef.current = null;
      setHeld(null);
      sendRover({ cmd: 'rover_jog_stop' });
    }
  }, [sendRover]);

  const beginJog = useCallback((name) => {
    if (heldRef.current === name) return;
    if (heldRef.current) endJog();
    const d = DIRS[name];
    if (!d) return;
    heldRef.current = name;
    setHeld(name);
    sendRover({ cmd: 'rover_jog_start', axis: d.axis, dir: d.dir });
    timerRef.current = setInterval(() => sendRover({ cmd: 'rover_jog_hold' }), HOLD_INTERVAL_MS);
  }, [sendRover, endJog]);

  // A pointer released outside the button, a tab switch or the window losing
  // focus all have to end the jog. The firmware's dead-man is the backstop, but
  // it costs up to half a second of unwanted travel, so stop here first.
  useEffect(() => {
    const stop = () => endJog();
    const onVis = () => { if (document.hidden) endJog(); };
    window.addEventListener('blur', stop);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.removeEventListener('visibilitychange', onVis);
      endJog();
    };
  }, [endJog]);

  // Arrow keys mirror the D-pad. Ignored while a field has focus; auto-repeat
  // is dropped, or the jog would restart dozens of times a second.
  useEffect(() => {
    if (!canMove) return;
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const down = (e) => {
      if (e.repeat || typing(e.target)) return;
      const name = Object.keys(DIRS).find(k => DIRS[k].key === e.key);
      if (!name) return;
      e.preventDefault();
      beginJog(name);
    };
    const up = (e) => {
      const name = Object.keys(DIRS).find(k => DIRS[k].key === e.key);
      if (name && heldRef.current === name) endJog();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [canMove, beginJog, endJog]);

  const setConfig = (patch) => sendRover({ cmd: 'rover_set_config', config: patch });

  const declarePosition = () => {
    const x = parseFloat(posDraftX);
    const y = parseFloat(posDraftY);
    if (isNaN(x) || isNaN(y)) return;
    sendRover({ cmd: 'rover_set_position', x_mm: x, y_mm: y });
    onClearTrail?.();
  };

  const nudge = (axis, sign) => {
    const d = parseFloat(nudgeMm);
    if (isNaN(d) || d === 0) return;
    sendRover({
      cmd: 'rover_move_rel',
      dx_mm: axis === 'x' ? d * sign : 0,
      dy_mm: axis === 'y' ? d * sign : 0,
    });
  };

  const applyCalibration = () => {
    const c = parseFloat(calCommanded);
    const m = parseFloat(calMeasured);
    if (isNaN(c) || isNaN(m) || m === 0) return;
    sendRover({ cmd: 'rover_calibrate', axis: calAxis, commanded_mm: c, measured_mm: m });
    setCalMeasured('');
  };

  return (
    <>
      {/* ── E-stop ─────────────────────────────────────────────────────── */}
      <button
        onClick={() => sendRover({ cmd: estopped ? 'rover_clear_estop' : 'rover_estop' })}
        disabled={!roverConnected}
        className={cn(
          'flex items-center gap-3 w-full p-4 rounded-2xl border transition-all cursor-pointer',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          estopped
            ? 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15'
            : 'border-red-500/30 bg-red-500/8 hover:bg-red-500/12 hover:border-red-500/50',
        )}
      >
        <OctagonX size={20} strokeWidth={2.2} className={estopped ? 'text-amber-400' : 'text-red-400'} />
        <div className="flex flex-col text-left">
          <span className={cn('text-sm font-bold', estopped ? 'text-amber-400' : 'text-red-400')}>
            {estopped ? 'Clear E-Stop' : 'Emergency Stop'}
          </span>
          <span className="text-[10px] text-[#666] leading-relaxed">
            {estopped ? 'Latched — position may be unreliable' : 'Cuts motion instantly, latches'}
          </span>
        </div>
      </button>

      {/* ── Link ───────────────────────────────────────────────────────── */}
      <Section label="Rover Link">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Server" value={roverConnected ? 'OK' : '—'} />
          <InfoTile label="Controller" value={roverStatus?.board_connected ? 'OK' : '—'} />
        </div>
        {roverStatus?.board_fw && (
          <p className="text-[10px] text-[#555]">Firmware {roverStatus.board_fw}</p>
        )}
        {roverConnected && !roverStatus?.board_connected && (
          <p className="text-[10px] leading-relaxed text-[#666]">
            Waiting for the controller to dial in on port 8765.
          </p>
        )}
        {roverStatus?.last_error && <ErrorBadge message={roverStatus.last_error} />}
      </Section>

      {/* ── Position ───────────────────────────────────────────────────── */}
      <Section label="Position">
        <div className="grid grid-cols-2 gap-2">
          <BigTile label="X · left-right" value={roverStatus ? roverStatus.x_mm.toFixed(2) : '—'}
                   unit="mm" sub={roverStatus ? `${roverStatus.x_speed_mm_s.toFixed(1)} mm/s` : ''} />
          <BigTile label="Y · up-down" value={roverStatus ? roverStatus.y_mm.toFixed(2) : '—'}
                   unit="mm" sub={roverStatus ? `${roverStatus.y_speed_mm_s.toFixed(1)} mm/s` : ''} />
        </div>

        {roverStatus?.position_conflict && (
          <Warn>
            The controller and this Pi disagree about where the rover is: controller
            says ({roverStatus.position_conflict.board_x_mm}, {roverStatus.position_conflict.board_y_mm}),
            the Pi saved ({roverStatus.position_conflict.saved_x_mm}, {roverStatus.position_conflict.saved_y_mm}) mm.
            Something moved while the other side was not watching — measure and re-declare.
          </Warn>
        )}
        {roverStatus?.position_stale && !roverStatus?.position_conflict && (
          <Warn>
            Position restored from disk and not verified against the rig. There are no
            endstops, so measuring and declaring it is the only ground truth.
          </Warn>
        )}

        <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">
            Declare current position
          </span>
          <div className="grid grid-cols-2 gap-2">
            <RawInput label="X · mm" value={posDraftX} onChange={setPosDraftX} onEnter={declarePosition} />
            <RawInput label="Y · mm" value={posDraftY} onChange={setPosDraftY} onEnter={declarePosition} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <SmallButton onClick={declarePosition} disabled={!linked} icon={Crosshair}>Set</SmallButton>
            <SmallButton
              onClick={() => {
                setPosDraftX('0'); setPosDraftY('0');
                sendRover({ cmd: 'rover_set_position', x_mm: 0, y_mm: 0 });
                onClearTrail?.();
              }}
              disabled={!linked}
            >Zero Here</SmallButton>
          </div>
          <p className="text-[10px] leading-relaxed text-[#555]">
            All values are millimetres. With no endstops this is the rig's only ground
            truth, so measure where the head actually is and enter that — the soft limits
            only protect you once the frame matches reality. Declaring also resets the
            travel odometer.
          </p>
        </div>
      </Section>

      {/* ── Jog ────────────────────────────────────────────────────────── */}
      <Section label="Jog">
        <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <div className="grid grid-cols-3 gap-1.5">
            <div />
            <JogKey name="up" held={held} onBegin={beginJog} onEnd={endJog} disabled={!canMove} />
            <div />
            <JogKey name="left" held={held} onBegin={beginJog} onEnd={endJog} disabled={!canMove} />
            <div className="flex items-center justify-center w-[52px] h-[52px]">
              <div className={cn('w-2 h-2 rounded-full transition-colors',
                roverStatus?.moving ? 'bg-[#4aff8a] animate-pulse' : 'bg-[#222]')} />
            </div>
            <JogKey name="right" held={held} onBegin={beginJog} onEnd={endJog} disabled={!canMove} />
            <div />
            <JogKey name="down" held={held} onBegin={beginJog} onEnd={endJog} disabled={!canMove} />
            <div />
          </div>
          <p className="text-[10px] text-[#555] text-center leading-relaxed">
            Hold to drive continuously, release to decelerate. Arrow keys work too.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumTile label="X jog" unit="mm/s" value={cfg?.x_jog_speed}
                   onCommit={v => setConfig({ x_jog_speed: v })} disabled={!roverConnected} />
          <NumTile label="Y jog" unit="mm/s" value={cfg?.y_jog_speed}
                   onCommit={v => setConfig({ y_jog_speed: v })} disabled={!roverConnected} />
        </div>

        {/* Nudge — for placing the head precisely, where holding a key is too coarse. */}
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Nudge</span>
            <div className="flex items-center gap-1">
              <input
                type="text" value={nudgeMm} onChange={e => setNudgeMm(e.target.value)}
                className="w-12 bg-[#111] border border-white/8 rounded px-2 py-1 text-xs font-mono text-white outline-none text-right"
                spellCheck={false}
              />
              <span className="text-[10px] text-[#666]">mm</span>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <NudgeButton onClick={() => nudge('x', -1)} disabled={!canMove}>X−</NudgeButton>
            <NudgeButton onClick={() => nudge('x', +1)} disabled={!canMove}>X+</NudgeButton>
            <NudgeButton onClick={() => nudge('y', -1)} disabled={!canMove}>Y−</NudgeButton>
            <NudgeButton onClick={() => nudge('y', +1)} disabled={!canMove}>Y+</NudgeButton>
          </div>
        </div>
      </Section>

      {/* ── Steering trim ──────────────────────────────────────────────── */}
      <Section label="Steering Trim">
        <YawModeSwitch yaw={yaw} onMode={m => sendRover({ cmd: 'rover_yaw_mode', mode: m })}
                       disabled={!roverConnected} />
        {yaw?.mode === 'manual' ? (
          <YawTrim value={cfg?.yaw_trim_pct} onChange={v => setConfig({ yaw_trim_pct: v })}
                   disabled={!roverConnected} />
        ) : (
          <YawAuto
            yaw={yaw}
            onZero={() => sendRover({ cmd: 'rover_yaw_zero' })}
            onHoldStandoff={() => sendRover({ cmd: 'rover_standoff_hold' })}
            onInvert={v => setConfig({ yaw_invert: v })}
            onStandoffInvert={v => setConfig({ standoff_invert: v })}
            disabled={!roverConnected} />
        )}
        <p className="text-[10px] leading-relaxed text-[#555]">
          {yaw?.mode === 'track'
            ? 'The LiDAR holds the distance and the IMU holds the heading. Being too far from ' +
              'the wall becomes a small request to point at it, which the heading loop flies. ' +
              'Set both references with the rover where you want it. If it drives AWAY from ' +
              'the target distance, flip the standoff sign.'
            : yaw?.mode === 'heading'
            ? 'The IMU heading is held at the reference — this keeps the rover PARALLEL but ' +
              'cannot fix being in the wrong place: a knock leaves it parallel along a new ' +
              'line. Use Track to close that. If the drift gets WORSE, flip the heading sign.'
            : 'The two rear wheels are on separate axles, so running one a few percent faster ' +
              'than the other turns the nose. Jog along the wall, watch the gap: if it closes, ' +
              'steer away from the wall; if it opens, steer toward it. One step is 1 %.'}
        </p>
      </Section>

      {/* ── Limits ─────────────────────────────────────────────────────── */}
      <Section label="Soft Limits">
        <Check label="Clamp travel to the envelope" checked={!!cfg?.limits_enabled}
               onChange={v => setConfig({ limits_enabled: v })} disabled={!roverConnected} />
        {cfg?.limits_enabled && (
          <div className="grid grid-cols-2 gap-2">
            <NumTile label="X min" unit="mm" value={cfg.x_min_mm} onCommit={v => setConfig({ x_min_mm: v })} />
            <NumTile label="X max" unit="mm" value={cfg.x_max_mm} onCommit={v => setConfig({ x_max_mm: v })} />
            <NumTile label="Y min" unit="mm" value={cfg.y_min_mm} onCommit={v => setConfig({ y_min_mm: v })} />
            <NumTile label="Y max" unit="mm" value={cfg.y_max_mm} onCommit={v => setConfig({ y_max_mm: v })} />
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-[#555]">
          There are no endstops, so these are the only thing between a jog and the end
          of the rail. They are held by the controller as well as here, so they still
          apply if this link drops. A jog decelerates to land on the limit rather than
          running into it.
        </p>
      </Section>

      {/* ── Calibration ────────────────────────────────────────────────── */}
      <Section label="Calibration">
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="X steps/mm" value={cfg ? cfg.x_steps_per_mm.toFixed(4) : '—'} />
            <InfoTile label="Y steps/mm" value={cfg ? cfg.y_steps_per_mm.toFixed(2) : '—'} />
          </div>
          <div className="flex gap-1.5">
            {['x', 'y'].map(a => (
              <button
                key={a}
                onClick={() => setCalAxis(a)}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer',
                  calAxis === a ? 'border-[#D1855C]/40 bg-[#D1855C]/8 text-[#D1855C]'
                                : 'border-white/8 bg-[#0d0d0d] text-[#666] hover:text-white',
                )}
              >{a === 'x' ? 'X · left-right' : 'Y · up-down'}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <RawInput label="Commanded · mm" value={calCommanded} onChange={setCalCommanded} />
            <RawInput label="Measured · mm" value={calMeasured} onChange={setCalMeasured}
                      onEnter={applyCalibration} />
          </div>
          <SmallButton onClick={applyCalibration} disabled={!roverConnected || !calMeasured}
                       icon={Ruler}>Apply correction</SmallButton>
          <p className="text-[10px] leading-relaxed text-[#555]">
            Drive a long known distance, measure what actually happened, and enter both.
            Longer is better — the error in your tape measure divides by the distance.
            The X axis rolls on wheels and its effective diameter is slightly under the
            66 mm measured with calipers, so this is where its accuracy comes from.
            Y is a leadscrew at exactly 200 steps/mm and should never need it.
          </p>
        </div>
      </Section>

      {/* ── Motion + diagnostics ───────────────────────────────────────── */}
      <Section label="Motion">
        <button
          onClick={() => setShowMotion(v => !v)}
          className="text-left text-[11px] text-[#666] hover:text-[#999] transition-colors cursor-pointer"
        >{showMotion ? '− Hide' : '+ Show'} speeds and diagnostics</button>
        {showMotion && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <NumTile label="X speed" unit="mm/s" value={cfg?.x_max_speed} onCommit={v => setConfig({ x_max_speed: v })} />
              <NumTile label="X accel" unit="mm/s²" value={cfg?.x_accel} onCommit={v => setConfig({ x_accel: v })} />
              <NumTile label="Y speed" unit="mm/s" value={cfg?.y_max_speed} onCommit={v => setConfig({ y_max_speed: v })} />
              <NumTile label="Y accel" unit="mm/s²" value={cfg?.y_accel} onCommit={v => setConfig({ y_accel: v })} />
            </div>
            {cfg && (
              <p className="text-[10px] leading-relaxed text-[#555]">
                Stopping distance is v²/2a — currently{' '}
                <b>{(cfg.x_max_speed ** 2 / (2 * cfg.x_accel)).toFixed(1)} mm</b> on X at full
                speed and{' '}
                <b>{(cfg.x_jog_speed ** 2 / (2 * cfg.x_accel)).toFixed(2)} mm</b> jogging.
                Raise acceleration before raising speed, or the rover needs a long
                runway to stop in.
              </p>
            )}
            <Check
              label="De-energise the drivers when idle"
              checked={(cfg?.idle_disable_s ?? 0) > 0}
              onChange={v => setConfig({ idle_disable_s: v ? 30 : 0 })}
              disabled={!roverConnected}
            />
            {(cfg?.idle_disable_s ?? 0) > 0 && (
              <NumTile label="Idle after" unit="s" value={cfg.idle_disable_s}
                       onCommit={v => setConfig({ idle_disable_s: v })} />
            )}
            <p className="text-[10px] leading-relaxed text-[#555]">
              Stops the standstill whine and the holding-current heat — the drivers chop
              current continuously to hold position, which is what you hear. Off by
              default: with no endstop and no encoder, an axis that creeps while
              de-energised is silently in the wrong place and nothing can detect it. The
              drivers re-energise automatically before any move.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Travel since home"
                        value={roverStatus ? `${roverStatus.travel_mm.toFixed(0)} mm` : '—'} />
              <InfoTile label="Queued"
                        value={roverStatus ? `${roverStatus.pending_moves}+${roverStatus.queue_depth}` : '—'} />
            </div>
            <p className="text-[10px] leading-relaxed text-[#555]">
              Travel since the position was last declared is the exposure to wheel slip
              and missed steps — the only error sources left that nothing can observe.
              Re-declare the position if it gets large and accuracy matters.
            </p>
            {roverStatus && (
              <p className="text-[10px] font-mono text-[#444]">
                x: {roverStatus.x_mode}/{roverStatus.x_stop_reason} · y: {roverStatus.y_mode}/{roverStatus.y_stop_reason}
              </p>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────── */

function JogKey({ name, held, onBegin, onEnd, disabled }) {
  const { icon: Icon } = DIRS[name];
  const active = held === name;
  return (
    <button
      disabled={disabled}
      // Pointer capture keeps the release on this button even if the cursor
      // slides off mid-hold, which is the usual way to leave a jog running.
      onPointerDown={e => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onBegin(name);
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onLostPointerCapture={onEnd}
      onContextMenu={e => e.preventDefault()}
      className={cn(
        'flex items-center justify-center w-[52px] h-[52px] rounded-xl border select-none touch-none',
        'transition-all duration-150 cursor-pointer',
        'disabled:opacity-25 disabled:cursor-not-allowed',
        active
          ? 'bg-[#4aff8a]/15 border-[#4aff8a]/50 text-[#4aff8a] scale-95'
          : 'bg-[#0d0d0d] border-white/8 text-[#888] hover:border-white/20 hover:text-white',
      )}
    >
      <Icon size={20} strokeWidth={2.2} />
    </button>
  );
}

function YawModeSwitch({ yaw, onMode, disabled }) {
  const mode = yaw?.mode || 'manual';
  const imuOk = !!yaw?.imu_ok;
  const lidarOk = !!yaw?.lidar_ok;
  const btn = (m, label, blocked) => (
    <button
      onClick={() => onMode(m)} disabled={disabled || blocked}
      className={cn('flex-1 px-2 py-1.5 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer',
        mode === m ? 'border-[#4aff8a]/50 bg-[#4aff8a]/10 text-[#4aff8a]'
                   : 'border-white/8 bg-[#0d0d0d] text-[#777] hover:text-white',
        'disabled:opacity-25 disabled:cursor-not-allowed')}
    >{label}</button>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        {btn('manual', 'Manual', false)}
        {btn('heading', 'Heading', !imuOk)}
        {btn('track', 'Track', !imuOk || !lidarOk)}
      </div>
      <div className="flex gap-2 text-[10px]">
        <span className={imuOk ? 'text-[#4aff8a]/70' : 'text-[#a06a2a]'}>
          IMU {imuOk ? 'ok' : 'no heading'}
        </span>
        <span className={lidarOk ? 'text-[#4aff8a]/70' : 'text-[#a06a2a]'}>
          LiDAR {lidarOk ? 'ok' : 'no range'}
        </span>
        {(!imuOk || !lidarOk) && (
          <span className="text-[#555]">— check stream.py on the Pi</span>
        )}
      </div>
    </div>
  );
}

// Read-only view of whichever loop is running, plus the references and signs
// the operator owns. In track mode the standoff row appears.
function YawAuto({ yaw, onZero, onHoldStandoff, onInvert, onStandoffInvert, disabled }) {
  const track = yaw?.mode === 'track';
  const a = yaw?.alpha ?? 0;
  const err = yaw?.error_deg ?? 0;
  const dErr = yaw?.standoff_err_mm ?? 0;
  const imuStale = !yaw?.imu_ok;
  const lidarStale = !yaw?.lidar_ok;
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[#555]">alpha</div>
          <div className={cn('text-sm font-mono', imuStale ? 'text-[#a06a2a]' : 'text-[#4aff8a]')}>
            {a > 0 ? '+' : ''}{a}%
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[#555]">heading err</div>
          <div className={cn('text-sm font-mono', Math.abs(err) > 1 ? 'text-[#ff6a6a]' : 'text-white')}>
            {err > 0 ? '+' : ''}{err.toFixed(2)}°
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[#555]">
            {track ? 'standoff err' : 'learned bias'}
          </div>
          <div className={cn('text-sm font-mono',
            track ? (Math.abs(dErr) > 15 ? 'text-[#ff6a6a]' : 'text-white') : 'text-[#aaa]')}>
            {track
              ? `${dErr > 0 ? '+' : ''}${dErr.toFixed(0)} mm`
              : `${(yaw?.bias ?? 0) > 0 ? '+' : ''}${(yaw?.bias ?? 0).toFixed(1)}%`}
          </div>
        </div>
      </div>
      {imuStale && (
        <span className="text-[10px] text-[#a06a2a] text-center">
          IMU stale — holding the last alpha, not steering.
        </span>
      )}
      {track && lidarStale && (
        <span className="text-[10px] text-[#a06a2a] text-center">
          LiDAR stale — holding heading only, distance is not being corrected.
        </span>
      )}
      <NudgeButton onClick={onZero} disabled={disabled || imuStale}>
        this is parallel · re-zero heading
      </NudgeButton>
      {track && (
        <NudgeButton onClick={onHoldStandoff} disabled={disabled || lidarStale}>
          hold this distance{yaw?.standoff_mm != null ? ` · ${yaw.standoff_mm.toFixed(0)} mm` : ''}
        </NudgeButton>
      )}
      <Check label="Flip heading sign (it made the drift worse)"
             checked={!!yaw?.invert} onChange={onInvert} disabled={disabled} />
      {track && (
        <Check label="Flip standoff sign (it drives away from the target)"
               checked={!!yaw?.standoff_invert} onChange={onStandoffInvert} disabled={disabled} />
      )}
      <div className="text-[9px] text-[#444] font-mono text-center leading-relaxed">
        yaw {yaw?.yaw_deg == null ? '—' : yaw.yaw_deg.toFixed(2)}° · ref {yaw?.yaw_ref_deg == null ? '—' : yaw.yaw_ref_deg.toFixed(2)}° · board holds {yaw?.board_pct ?? '—'}%
        {track && (
          <><br />range {yaw?.standoff_mm == null ? '—' : `${yaw.standoff_mm.toFixed(0)} mm`} · target {yaw?.standoff_ref_mm == null ? '—' : `${yaw.standoff_ref_mm.toFixed(0)} mm`} · lean {(yaw?.psi_deg ?? 0).toFixed(2)}°</>
        )}
      </div>
    </div>
  );
}

// Steering trim: signed integer percent, ±1 per tap, clamped to the same
// range the firmware and the Pi enforce. Sign convention (from
// rover/config.h): positive = left rear wheel faster = nose turns RIGHT.
const YAW_MAX = 30;
function YawTrim({ value, onChange, disabled }) {
  const v = Number.isFinite(value) ? Math.round(value) : 0;
  const set = (n) => onChange(Math.max(-YAW_MAX, Math.min(YAW_MAX, n)));
  const label = v === 0 ? 'straight' : v > 0 ? `${v}% right` : `${-v}% left`;
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Yaw</span>
        <span className={cn('text-xs font-mono', v === 0 ? 'text-[#666]' : 'text-[#4aff8a]')}>
          {v > 0 ? '+' : ''}{v}% <span className="text-[#555]">· {label}</span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <NudgeButton onClick={() => set(v - 5)} disabled={disabled || v <= -YAW_MAX}>◀◀ 5</NudgeButton>
        <NudgeButton onClick={() => set(v - 1)} disabled={disabled || v <= -YAW_MAX}>◀ left</NudgeButton>
        <NudgeButton onClick={() => set(v + 1)} disabled={disabled || v >= YAW_MAX}>right ▶</NudgeButton>
        <NudgeButton onClick={() => set(v + 5)} disabled={disabled || v >= YAW_MAX}>5 ▶▶</NudgeButton>
      </div>
      <button
        onClick={() => set(0)} disabled={disabled || v === 0}
        className="text-[10px] text-[#666] hover:text-white disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer text-center"
      >
        reset to straight
      </button>
    </div>
  );
}

function NudgeButton({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2 py-2 rounded-lg border text-[11px] font-mono font-semibold transition-all cursor-pointer',
        'border-white/8 bg-[#0d0d0d] text-[#aaa] hover:border-[#4aff8a]/40 hover:text-white',
        'disabled:opacity-25 disabled:cursor-not-allowed',
      )}
    >{children}</button>
  );
}

function Warn({ children }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/5">
      <span className="text-[10px] leading-relaxed text-amber-400">{children}</span>
    </div>
  );
}

function BigTile({ label, value, unit, sub }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-bold font-mono text-[#4aff8a]">{value}</span>
        <span className="text-[10px] font-semibold text-[#888888]">{unit}</span>
      </div>
      {sub ? <span className="text-[9px] font-mono text-[#444]">{sub}</span> : null}
    </div>
  );
}

function RawInput({ label, value, onChange, onEnter }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-[#111] border border-white/8 focus-within:border-[#D1855C]/40 transition-colors">
      <span className="text-[9px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); }}
        className="bg-transparent text-sm font-mono text-white outline-none w-full"
        spellCheck={false}
      />
    </div>
  );
}

function SmallButton({ children, onClick, disabled, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold',
        'transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed',
        'border-white/8 bg-[#0d0d0d] text-[#aaa] hover:border-[#D1855C]/40 hover:text-white',
      )}
    >
      {Icon && <Icon size={12} strokeWidth={2.2} />}
      {children}
    </button>
  );
}

/** A tile that shows a number and turns into a text input when clicked. */
function NumTile({ label, unit, value, onCommit, disabled }) {
  const [draft, setDraft] = useState(null);
  const shown = value === undefined || value === null ? '—'
    : (Math.abs(value) >= 100 ? value.toFixed(0) : String(Number(value.toFixed(3))));

  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n)) onCommit(n);
    setDraft(null);
  };

  return (
    <div
      onClick={() => { if (!disabled && draft === null) setDraft(shown === '—' ? '' : shown); }}
      className={cn(
        'flex flex-col gap-1 p-3 rounded-xl border transition-all',
        disabled ? 'border-white/5 bg-[#0a0a0a]/40 opacity-40 cursor-not-allowed'
          : draft !== null ? 'border-[#D1855C]/40 bg-[#D1855C]/5 cursor-text'
            : 'border-white/5 bg-[#0a0a0a]/50 cursor-pointer hover:border-white/15',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <div className="flex items-baseline gap-1">
        {draft !== null ? (
          <input
            autoFocus type="text" value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
            className="bg-transparent text-sm font-bold font-mono text-white outline-none w-12"
          />
        ) : (
          <span className="text-sm font-bold font-mono text-white">{shown}</span>
        )}
        <span className="text-[10px] font-semibold text-[#888888]">{unit}</span>
      </div>
    </div>
  );
}

function Check({ label, checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'flex items-center gap-2.5 p-3 rounded-xl border transition-all text-left',
        'cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed',
        checked ? 'border-[#4aff8a]/30 bg-[#4aff8a]/5' : 'border-white/5 bg-[#0a0a0a]/50 hover:border-white/15',
      )}
    >
      <div className={cn('w-3.5 h-3.5 rounded shrink-0 border transition-all',
        checked ? 'bg-[#4aff8a] border-[#4aff8a]' : 'border-white/20')} />
      <span className={cn('text-xs', checked ? 'text-white' : 'text-[#888]')}>{label}</span>
    </button>
  );
}
