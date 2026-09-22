import { useRef, useEffect, useState, lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';
import { Activity, Radio, Radar, ScanLine, Grid3x3, Map, Zap, Brain, FlaskConical, Move, X, ChevronLeft, ChevronRight, Box, Locate, Projector, HardDriveDownload, Maximize, Minimize } from 'lucide-react';
import ImuDisplay from './ImuDisplay';
import { HandheldPositionReadout, HandheldLidarReadout, ImuReadout } from './HandheldReadouts';
import WaveformDisplay from './WaveformDisplay';
import ReceiverDisplay from './ReceiverDisplay';
import FftDisplay from './FftDisplay';
import SfcwDisplay from './SfcwDisplay';
import BscanDisplay from './BscanDisplay';
import CscanDisplay from './CscanDisplay';
import SarDisplay from './SarDisplay';
import MapDisplay from './MapDisplay';
import BgModelDisplay from './BgModelDisplay';
import ImagingDisplay from './ImagingDisplay';
import RoverDisplay from './RoverDisplay';
import ProjectorDemoDisplay from './ProjectorDemoDisplay';
import HandheldCaptureDisplay from './HandheldCaptureDisplay';
import { planViewScales } from '@/lib/cscanGrid';

// three.js is only pulled in when the operator opens the 3D view.
const SarWall3D = lazy(() => import('./SarWall3D'));

// What the automated raster is doing, for the badge over the plan view.
const ROVER_PHASE_TEXT = {
  homing: 'Driving to origin',
  moving: 'Moving',
  settling: 'Settling',
  capturing: 'Sweeping',
};

export default function Viewport({
  activePanel,
  isConnected,
  sweepPeriodMs,
  imuData,
  txActive,
  rxActive,
  rxSamplesAnt,
  rxSamplesRef,
  fftDataAnt,
  fftDataRef,
  showFFT,
  graphPaused,
  sfcwResult,
  sfcwProgress,
  sfcwRunning,
  sfcwRangeScale,
  sfcwScaleRange,
  onSfcwScaleRangeChange,
  onSfcwDynamicScale,
  bscanData,
  bscanBgDisplay,
  bscanBgSubMode,
  cscanSharedScale,
  bscanParams,
  cscanFocusParams,
  bscanCapturing,
  roverScan,
  bscanScaleMode,
  bscanDisplayMode,
  bscanScaleRange,
  bscanScaleScope,
  bscanShowGate,
  cscanProjection,
  cscanSmooth,
  cscanColormap,
  bscanScaleLink,
  cscanRowScales,
  cscanGridScales,
  sarResult,
  sarProgress,
  sarScaleMode,
  sarDynRange,
  sarViewMode,
  sarColormap,
  sarDetection,
  sarDetectProgress,
  sarHandleEnds,
  sarRows,
  sarActiveRow,
  onSarRowStep,
  cscanSelectedCell: selectedCell,
  onCscanSelectCell,
  onCscanCloseRow,
  mapBscanData,
  mapGateStart,
  mapGateEnd,
  mapDynRange,
  mapMetric,
  mapStepSize,
  mapFocusEnabled,
  mapFocusAperture,
  bgModelCaptures,
  bgModelCapturing,
  bgModelStopFreq,
  imagingSnapshot,
  imagingEffect,
  imagingParams,
  roverStatus,
  roverTrail,
  roverLog,
  handheldPose,
  projectorDemo,
  handheldCapture,
  handheldRough,
}) {
  // SAR panel: image vs 3D digital twin of the wall. Off by default.
  const [sar3d, setSar3d] = useState(false);
  // `selectedCell` (the cscanSelectedCell prop) is which C-scan cell the B-scan
  // pane is showing the row for. It lives in App.jsx because the SAR panel follows
  // the selected row. Null means the C-scan plan view has the whole viewport to
  // itself, which is the default: the grid is the image, and the B-scan is a detail
  // view of one row of it that the operator opens by clicking a cell and closes again.
  // The plan view's current layout, published every frame so the B-scan pane
  // below can put each position under the grid cell it came from.
  const cscanLayoutRef = useRef(null);
  const publishCscanLayout = useRef((L) => { cscanLayoutRef.current = L; }).current;
  // The viewport itself -- everything right of the sidebar. To-scale placement
  // is measured from this element's top-left corner, so the projected grid does
  // not move when the Live Sweep pane appears or a row's B-scan opens.
  const cscanRootRef = useRef(null);
  // Projector Demo: to-scale placement is measured from this element, like the C-scan's.
  const projDemoRootRef = useRef(null);
  // Called unconditionally, before any of the per-panel early returns -- hooks cannot
  // live inside those branches. Idles to null whenever the SFCW pane is not the one up.
  // The sweep rate is measured in App.jsx from EVERY sfcw_result, before the
  // ~20 Hz live-display throttle. It must not be derived from `sfcwResult` here:
  // that state is only set inside the throttle gate, so this header would report
  // the DISPLAY rate while claiming to report the radar's. The two alias badly --
  // a 50 ms gate against a 27.9 ms sweep passes exactly every other one, so a
  // healthy 35.9 Hz radar read 17.9 Hz, which is indistinguishable from the
  // ~18 Hz a board that has reverted to the stock FPGA image actually runs at
  // (see CLAUDE.md, "The 18 Hz regression"). That collision cost a real
  // debugging session: the FPGA was reloaded, the wire measured at 35.9 Hz, and
  // the readout did not move. Keep this on the unthrottled measurement.
  const sweepActive = activePanel === 'sfcw' && (sfcwRunning || !!sfcwResult);
  const sweepRate = (sweepActive && sweepPeriodMs > 0)
    ? { ms: sweepPeriodMs, hz: 1000 / sweepPeriodMs }
    : null;

  // Browser fullscreen, for the home screen's button (phones and tablets opening
  // http://10.42.0.1:5000 have no F11). Tracked from the fullscreenchange event --
  // not from the click -- so leaving fullscreen via the system gesture / Esc keeps
  // the label honest. webkit-prefixed variants cover older Safari; iPhone Safari
  // has no Fullscreen API at all, so there the button is not rendered rather than
  // rendered broken (Add to Home Screen is the fullscreen route on iPhone).
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  const fullscreenSupported = typeof document !== 'undefined'
    && !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  const toggleFullscreen = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      // The promise rejects when the browser refuses (permission, iframe policy);
      // the fullscreenchange listener above never fires then, so the label stays
      // right on its own -- just keep the rejection from surfacing as an error.
      try { req?.call(el)?.catch?.(() => {}); } catch { /* older sync throwers */ }
    }
  };

  if (!activePanel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-black select-none">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-[#D1855C]/[0.03] blur-[120px] rounded-full" />
        </div>
        <h1 className="text-[56px] font-bold tracking-[0.25em] uppercase mb-4">
          <span className="text-primary">ver</span><span className="text-white/80">sion0</span>
        </h1>
        <p className="text-[16px] font-medium tracking-[0.4em] uppercase text-white/30">
          Groundstation
        </p>
        {fullscreenSupported && (
          <button type="button" onClick={toggleFullscreen}
            title={isFullscreen ? 'Leave browser fullscreen' : 'Take the browser fullscreen'}
            className="mt-8 flex items-center gap-2 px-4 py-2 rounded-md text-[11px] font-medium tracking-[0.15em] uppercase border transition-colors bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10">
            {isFullscreen ? <Minimize size={14} strokeWidth={2} /> : <Maximize size={14} strokeWidth={2} />}
            {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        )}
      </div>
    );
  }

  if (activePanel === 'handheld') {
    const live = isConnected && !!imuData;
    const imuLive = live && !!imuData?.accel;
    // Quadrants: position | IMU orientation / LiDARs | IMU values.
    return (
      <div className="flex-1 grid grid-cols-2 grid-rows-2 h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0 border-r border-b border-white/5">
          <PaneHeader icon={Locate} label="Position From Origin" active={live} color="cyan" />
          <div className="flex-1 min-h-0">
            {handheldPose && <HandheldPositionReadout pose={handheldPose} />}
          </div>
        </div>
        <div className="relative flex flex-col min-h-0 border-b border-white/5">
          <PaneHeader icon={Activity} label="IMU Orientation" active={imuLive} color="orange" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <ImuDisplay imuData={imuData} />
            {!imuLive && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No IMU data</span>
              </div>
            )}
          </div>
        </div>
        <div className="relative flex flex-col min-h-0 border-r border-white/5">
          <PaneHeader icon={Locate} label="LiDARs" active={live} color="cyan" />
          <div className="flex-1 min-h-0">
            {handheldPose && <HandheldLidarReadout pose={handheldPose} />}
          </div>
        </div>
        <div className="relative flex flex-col min-h-0">
          <PaneHeader icon={Activity} label="IMU" active={imuLive} color="orange" />
          <div className="flex-1 min-h-0">
            <ImuReadout imuData={imuData} />
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'rfcalib') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">

        {/* Upper: TX Waveform — antenna (left) / reference (right) */}
        <div className="flex min-h-0 border-b border-white/5" style={{ flex: '1 1 0%' }}>
          <div className="relative flex flex-col min-w-0 border-r border-white/5" style={{ flex: '1 1 0%' }}>
            <PaneHeader icon={Zap} label="Transmitter · Antenna" active={txActive} color="orange" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {txActive && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/5 blur-[80px] rounded-full" />
                </div>
              )}
              <WaveformDisplay active={txActive} />
            </div>
          </div>
          <div className="relative flex flex-col min-w-0" style={{ flex: '1 1 0%' }}>
            <PaneHeader icon={Zap} label="Transmitter · Reference" active={txActive} color="orange" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {txActive && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/5 blur-[80px] rounded-full" />
                </div>
              )}
              <WaveformDisplay active={txActive} />
            </div>
          </div>
        </div>

        {/* Lower: Receiver — antenna (left) / reference (right) */}
        <div className="flex min-h-0" style={{ flex: '1 1 0%' }}>
          <div className="relative flex flex-col min-w-0 border-r border-white/5" style={{ flex: '1 1 0%' }}>
            <PaneHeader icon={Radio} label="Receiver · Antenna" active={rxActive} color="cyan" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {rxActive && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#22d3ee]/4 blur-[80px] rounded-full" />
                </div>
              )}
              {showFFT ? (
                <FftDisplay active={rxActive} fftData={fftDataAnt} paused={graphPaused} />
              ) : (
                <ReceiverDisplay active={rxActive} samples={rxSamplesAnt} paused={graphPaused} />
              )}
              {!rxActive && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No signal</span>
                </div>
              )}
            </div>
          </div>
          <div className="relative flex flex-col min-w-0" style={{ flex: '1 1 0%' }}>
            <PaneHeader icon={Radio} label="Receiver · Reference" active={rxActive} color="cyan" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {rxActive && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#22d3ee]/4 blur-[80px] rounded-full" />
                </div>
              )}
              {showFFT ? (
                <FftDisplay active={rxActive} fftData={fftDataRef} paused={graphPaused} />
              ) : (
                <ReceiverDisplay active={rxActive} samples={rxSamplesRef} paused={graphPaused} />
              )}
              {!rxActive && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No signal</span>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    );
  }

  if (activePanel === 'bgmodel') {
    const showLiveSweep = sfcwRunning || sfcwResult;
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        {showLiveSweep && (
          <div className="relative flex flex-col border-b border-white/5" style={{ flex: '0 0 40%' }}>
            <PaneHeader icon={Radar} label="Live Sweep" active={sfcwRunning} color="orange" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              <SfcwDisplay
                sfcwResult={sfcwResult}
                sfcwProgress={sfcwProgress}
                sfcwRunning={sfcwRunning}
                rangeScale={{ min: 0, max: 0.3 }}
                hideWaterfall
                defaultScaleMode="linear"
              />
            </div>
          </div>
        )}
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Brain} label="Background Model" active={bgModelCaptures && bgModelCaptures.length > 0} color="orange" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {bgModelCaptures && bgModelCaptures.length > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#a78bfa]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <BgModelDisplay captures={bgModelCaptures} capturing={bgModelCapturing} sfcwProgress={sfcwProgress} stopFreq={bgModelStopFreq} />
            {(!bgModelCaptures || bgModelCaptures.length === 0) && !showLiveSweep && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No captures yet</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'rover') {
    const linked = !!roverStatus?.arduino_connected;
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Move} label="Rover Position" active={linked} color="green" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {roverStatus?.moving && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#4aff8a]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <RoverDisplay status={roverStatus} trail={roverTrail} />
            {!roverStatus && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">Rover server not connected</span>
              </div>
            )}
          </div>
        </div>

        {/* Raw link traffic. The Arduino is a black box, so seeing exactly what
            went out and what came back is the only way to tell a dropped move
            from a silent one. */}
        <div className="relative flex flex-col border-t border-white/5" style={{ flex: '0 0 200px' }}>
          <PaneHeader icon={Radio} label="Rover Link Log" active={linked} color="green" />
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2 font-mono text-[11px] leading-relaxed">
            {roverLog && roverLog.length > 0 ? (
              roverLog.map((entry, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-[#333] shrink-0">
                    {new Date(entry.t * 1000).toLocaleTimeString('en-GB', { hour12: false })}
                  </span>
                  <span className={
                    entry.line.startsWith('pi -> uno') ? 'text-[#4aff8a]/70'
                      : entry.line.startsWith('arduino:') ? 'text-[#22d3ee]/70'
                        : entry.line.startsWith('error') ? 'text-red-400/80'
                          : 'text-[#777]'
                  }>{entry.line}</span>
                </div>
              ))
            ) : (
              <span className="text-[#333]">No traffic yet.</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'sfcw') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader
            icon={Radar}
            label="SFCW Radar"
            active={sfcwRunning || !!sfcwResult}
            color="orange"
            meta={sweepRate ? `${sweepRate.ms.toFixed(0)} ms / sweep · ${sweepRate.hz.toFixed(2)} Hz` : null}
          />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {(sfcwRunning || sfcwResult) && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <SfcwDisplay
              sfcwResult={sfcwResult}
              sfcwProgress={sfcwProgress}
              sfcwRunning={sfcwRunning}
              rangeScale={sfcwRangeScale}
              scaleRange={sfcwScaleRange}
              onScaleRangeChange={onSfcwScaleRangeChange}
              onDynamicScale={onSfcwDynamicScale}
            />
            {!sfcwResult && !sfcwRunning && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No sweep data</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'imaging') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={FlaskConical} label="Imaging Bench" active={!!imagingSnapshot} color="cyan" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {imagingSnapshot && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#22d3ee]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <ImagingDisplay
              snapshot={imagingSnapshot}
              effect={imagingEffect}
              params={imagingParams}
            />
            {!imagingSnapshot && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">
                  No snapshot — export a waterfall from the SFCW panel
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'cscan') {
    // The cell driving the B-scan pane. Only an explicit click opens it -- there
    // is deliberately no fall-back to the last capture, because the plan view is
    // the panel's main image and a row detail that opened itself would take a
    // third of it away unasked. A selection is dropped once the grid shrinks
    // past it, which closes the pane.
    const inGrid = selectedCell
      && selectedCell.ix < bscanParams.hCount && selectedCell.iy < bscanParams.vCount;
    const activeCell = inGrid ? selectedCell : null;
    const rowOpen = !!activeCell;

    // One row of the raster, laid out left-to-right regardless of which way the
    // snake swept it. Data with no grid indices (an imported linear scan) is
    // shown whole.
    const hasGrid = bscanData.some(p => p.grid_iy != null);
    const rowData = !rowOpen ? []
      : hasGrid
        ? bscanData.filter(p => p.grid_iy === activeCell.iy).sort((a, b) => a.grid_ix - b.grid_ix)
        : bscanData;
    const rowLabel = (hasGrid && activeCell)
      ? `B-Scan · Row ${activeCell.iy + 1}`
      : 'B-Scan';

    // Per-row scaling: this pane draws one grid row, so its limits are that
    // row's. Manual pinning still wins over both (the displays check
    // scaleRange.dynamic themselves), and a scan with no grid indices lands in
    // row 0, where per-row and global are the same population anyway.
    const bscanScale = (bscanScaleScope === 'row' && cscanRowScales)
      ? (cscanRowScales.get(activeCell ? activeCell.iy : 0) || cscanSharedScale)
      : cscanSharedScale;

    // Which population the PLAN VIEW is scaled from. Unlinked, it uses its own
    // gated cell values, so the two panes' colour bars stop agreeing -- both
    // say so on screen. The B-scan always keeps the bin-domain population; it
    // draws bins, and there is nothing gated about them to scale within.
    const planScales = planViewScales(bscanScaleLink, cscanGridScales, cscanSharedScale, cscanRowScales,
      bscanParams.focusEnabled);
    const cscanScaleGlobal = planScales.global;
    const cscanScaleRows = planScales.rows;
    // Focusing forces the plan view onto its own population, so both panes are
    // told the link that is actually in force rather than the one on the toggle.
    const effectiveLink = planScales.effectiveLink;

    return (
      <div ref={cscanRootRef} className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        {/* The plan view is the panel's image and holds the whole area until a
            cell is clicked; the row's B-scan then opens UNDER it, rotated 90
            degrees anticlockwise so its position axis runs the same way as the
            grid's and lands under the same columns. Stacked rather than
            side-by-side because a raster is usually much wider than it is tall:
            the detail view then costs a strip of height instead of a third of
            the width, and the grid keeps its scale. */}
        <div className="flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <div className="relative flex flex-col min-w-0" style={{ flex: '1 1 0%' }}>
            <PaneHeader icon={Grid3x3} label="C-Scan Grid" active={bscanData.length > 0} color="cyan" />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              {bscanData.length > 0 && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#22d3ee]/4 blur-[80px] rounded-full" />
                </div>
              )}
              {/* The gantry is moving on its own — say what it is doing, where,
                  and how far along it is, without making the operator look
                  away from the image. */}
              {roverScan?.active && (
                <div className="absolute top-2 left-2 z-10 flex flex-col gap-1 px-3 py-2 rounded-xl border border-[#4aff8a]/30 bg-black/80 backdrop-blur-sm pointer-events-none">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#4aff8a] animate-pulse" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[#4aff8a]">
                      {ROVER_PHASE_TEXT[roverScan.phase] || 'Rover scan'}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-white/60">
                    cell {roverScan.index + 1} / {roverScan.total}
                    {roverScan.target
                      ? ` · ${roverScan.target.x_mm.toFixed(0)}, ${roverScan.target.y_mm.toFixed(0)} mm`
                      : ''}
                  </span>
                </div>
              )}
              <CscanDisplay
                scanData={bscanData}
                params={cscanFocusParams}
                capturing={bscanCapturing}
                sfcwProgress={sfcwProgress}
                scaleMode={bscanScaleMode}
                scaleRange={bscanScaleRange}
                sharedScale={cscanScaleGlobal}
                rowScales={cscanScaleRows}
                scaleScope={bscanScaleScope}
                scaleLink={effectiveLink}
                subMode={bscanBgSubMode}
                nextIndex={roverScan?.active ? roverScan.index : bscanData.length}
                selectedCell={activeCell}
                onSelectCell={onCscanSelectCell}
                scanMode={bscanParams.scanMode}
                projection={cscanProjection}
                smooth={cscanSmooth}
                colormap={cscanColormap}
                detection={sarDetection}
                handleEnds={sarHandleEnds}
                onLayout={publishCscanLayout}
                rootRef={cscanRootRef}
              />
            </div>
          </div>

          {rowOpen && (
          <div className="relative flex flex-col min-w-0 border-t border-white/5" style={{ flex: '0 0 38%' }}>
            <PaneHeader
              icon={ScanLine}
              label={rowLabel}
              active={rowData.length > 0}
              color="cyan"
              action={{ icon: X, title: 'Close row — back to full-screen grid', onClick: onCscanCloseRow }}
            />
            <div className="flex-1 min-h-0 relative overflow-hidden">
              <BscanDisplay
                scanData={rowData}
                bgDisplay={bscanBgDisplay}
                params={bscanParams}
                capturing={bscanCapturing}
                sfcwProgress={sfcwProgress}
                scaleMode={bscanScaleMode}
                displayMode={bscanDisplayMode}
                scaleRange={bscanScaleRange}
                sharedScale={bscanScale}
                scaleScope={bscanScaleScope}
                scaleLink={effectiveLink}
                showGate={bscanShowGate}
                subMode={bscanBgSubMode}
                orientation="vertical"
                colormap={cscanColormap}
                alignRef={cscanLayoutRef}
              />
              {rowData.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">Row not captured yet</span>
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      </div>
    );
  }

  if (activePanel === 'sar') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader
            icon={Grid3x3}
            label={sar3d
              ? 'Wall Digital Twin'
              : (sarActiveRow !== null && sarRows.length > 1
                ? `SAR Reconstruction · Row ${sarActiveRow + 1}`
                : 'SAR Reconstruction')}
            active={!!sarResult}
            color="orange"
          />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {sarResult && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#D1855C]/4 blur-[80px] rounded-full" />
              </div>
            )}
            {sar3d ? (
              <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-xs text-white/40">Loading 3D view...</div>}>
                <SarWall3D
                  detection={sarDetection}
                  detectProgress={sarDetectProgress}
                  vStep={bscanParams.vStep}
                  handleEnds={sarHandleEnds}
                />
              </Suspense>
            ) : (
              <SarDisplay
                sarResult={sarResult}
                sarProgress={sarProgress}
                scaleMode={sarScaleMode}
                dynRange={sarDynRange}
                viewMode={sarViewMode}
                colormap={sarColormap}
                detection={sarDetection}
                activeRow={sarActiveRow}
                handleEnds={sarHandleEnds}
              />
            )}
            {!sar3d && !sarResult && sarProgress === null && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No SAR image — need ≥2 B-scan positions</span>
              </div>
            )}
          </div>
          {/* Row stepper for a multi-row C-scan. SAR reconstructs one row at a time
              (the one selected on the C-scan); these walk through the rows that hold
              data, ending at either end rather than wrapping. A footer strip rather
              than an overlay, so it never covers the axis labels or colour bar. */}
          {(sarRows.length > 1 || sarResult || sarDetection) && (() => {
            const idx = sarRows.indexOf(sarActiveRow);
            const atFirst = idx <= 0;
            const atLast = idx >= sarRows.length - 1;
            const btn = 'p-1 rounded-md transition-colors disabled:opacity-25 disabled:cursor-not-allowed text-white/60 enabled:hover:text-white enabled:hover:bg-white/10';
            return (
              <div className="flex items-center justify-end gap-2 px-4 py-1.5 border-t border-white/5 bg-[#050505]/80 shrink-0">
                {sarRows.length > 1 && (
                  <>
                    <span className="text-[10px] font-mono tabular-nums text-white/40">
                      Row {sarActiveRow + 1} · {idx + 1} of {sarRows.length}
                    </span>
                    <button type="button" className={btn} disabled={atFirst || sar3d} title="Previous row"
                      onClick={() => onSarRowStep(-1)}>
                      <ChevronLeft size={14} strokeWidth={2} />
                    </button>
                    <button type="button" className={btn} disabled={atLast || sar3d} title="Next row"
                      onClick={() => onSarRowStep(1)}>
                      <ChevronRight size={14} strokeWidth={2} />
                    </button>
                  </>
                )}
                {/* The 3D digital twin places every CONFIRMED detection as a cylinder in a
                    to-scale cuboid of the scanned patch; it uses all rows at once, so the
                    row arrows are disabled while it is shown. */}
                <button type="button" onClick={() => setSar3d((v) => !v)}
                  title={sar3d ? 'Back to the SAR image' : '3D view of the wall and detected pipes'}
                  className={cn('flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors',
                    sar3d ? 'bg-[#4ade80]/10 border-[#4ade80]/30 text-[#4ade80]' : 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10')}>
                  <Box size={12} strokeWidth={2} />
                  3D view
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  if (activePanel === 'projdemo' && projectorDemo) {
    const d = projectorDemo;
    const drawing = d.mode === 'draw';
    const grid = d.activeGrid;
    const modeLabel = drawing ? 'Draw' : d.mode === 'rover' ? 'Rover' : 'Handheld';
    const rover = d.mode === 'rover';
    const handheld = d.mode === 'handheld';
    const run = rover ? d.roverRun : handheld ? d.handheldRun : null;
    const total = grid ? grid.hCount * grid.vCount : 0;
    return (
      <div ref={projDemoRootRef} className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Projector} label={`Projector Demo · ${modeLabel}`} active={!!grid} color="cyan" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <ProjectorDemoDisplay
              grid={grid}
              // Every mode follows the projection calibration, so the monitor shows what the
              // projector does -- in Draw, a stroke lands where the projector shows it.
              projection={d.projection}
              editable={drawing}
              tool={d.tool}
              // Hover outline in the brush's own colour: pipe yellow, seepage green.
              color={d.tool === 'seepage' ? '#5ec962' : '#fde725'}
              lattice={!drawing}
              onPaint={d.paintDraw}
              rootRef={projDemoRootRef}
              // Rover and handheld: cells not reached yet are dimmed; the one in front of the
              // rover or module is outlined.
              dullUncovered={!drawing}
              covered={run ? run.covered : null}
              currentCell={run ? run.currentCell : null}
              title={drawing ? `DRAW · ${String(d.tool).toUpperCase()} BRUSH · RIGHT-DRAG ERASES`
                : rover ? `ROVER · ${run ? run.coveredCount : 0} / ${total} COVERED${run && run.active ? ' · RUNNING' : ''}`
                  : `HANDHELD · ${run ? run.coveredCount : 0} / ${total} REACHED${run && run.active ? (run.playing ? ' · PLAYING' : ' · PAUSED') : ''}`}
            />
            {!grid && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No grid loaded — import one</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'hhcapture' && handheldCapture) {
    const c = handheldCapture;
    const rv = handheldRough;
    const roughView = rv?.view === 'rough';
    const total = c.grid.hCount * c.grid.vCount;
    const state = !c.session.active ? '' : c.session.playing ? ' · SCANNING' : ' · PAUSED';
    const pct = total ? Math.round((100 * c.stats.captured) / total) : 0;
    const name = (c.session.active ? c.session.name : c.lastSession?.name || c.name) || 'PATCH';
    const segBtn = (on) => cn('px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors',
      on ? 'bg-[#22d3ee]/10 border-[#22d3ee]/30 text-[#22d3ee]' : 'bg-white/5 border-white/10 text-white/50 hover:text-white');
    // Status: coverage. Rough output: a BG-subtracted plan view of the first sweep in each cell.
    const viewSwitch = rv && (
      <span className="flex items-center gap-1">
        <button type="button" className={segBtn(!roughView)} onClick={() => rv.setView('status')}>Status</button>
        <button type="button" className={segBtn(roughView)} onClick={() => rv.setView('rough')}>Rough output</button>
      </span>
    );
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={HardDriveDownload} label="Handheld Capture" active={c.session.active} color="cyan" meta={viewSwitch} />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {!roughView && (
              <HandheldCaptureDisplay
                grid={c.grid}
                countsRef={c.countsRef}
                version={c.version}
                minSweeps={c.minSweeps}
                livePosRef={c.livePosRef}
                active={c.session.active}
                playing={c.session.playing}
                title={`${name} · ${c.stats.captured} / ${total} CELLS (${pct}%) · ${c.stats.sweeps} SWEEPS RECORDED`
                  + `${c.stats.thin ? ` · ${c.stats.thin} THIN` : ''}${state}`}
              />
            )}
            {roughView && rv.grid && rv.params && (
              <CscanDisplay
                scanData={rv.processed}
                params={rv.params}
                capturing={false}
                scaleMode={rv.settings.scaleMode}
                scaleRange={rv.settings.scaleRange}
                sharedScale={rv.plan.global}
                rowScales={rv.plan.rows}
                scaleScope="global"
                scaleLink={rv.plan.effectiveLink}
                subMode={rv.bgModel && rv.settings.bgApplied ? rv.settings.subMode : 'complex'}
                nextIndex={null}
                scanMode="manual"
                smooth={rv.settings.smooth}
                colormap={rv.settings.colormap}
              />
            )}
            {roughView && (!rv.grid || rv.cells === 0) && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">
                  {rv.grid ? 'No cells scanned yet' : 'Start a session and scan to see rough output'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activePanel === 'map') {
    return (
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-black">
        <div className="relative flex flex-col min-h-0" style={{ flex: '1 1 0%' }}>
          <PaneHeader icon={Map} label="2D Map" active={mapBscanData && mapBscanData.length > 0} color="green" />
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {mapBscanData && mapBscanData.length > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] bg-[#4aff8a]/4 blur-[80px] rounded-full" />
              </div>
            )}
            <MapDisplay
              bscanData={mapBscanData}
              gateStart={mapGateStart}
              gateEnd={mapGateEnd}
              dynRange={mapDynRange}
              metric={mapMetric}
              stepSize={mapStepSize}
              focusEnabled={mapFocusEnabled}
              focusAperture={mapFocusAperture}
            />
            {(!mapBscanData || mapBscanData.length === 0) && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs text-[#333333] uppercase tracking-widest font-medium">No B-scan data — capture or load a scan</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// Live sweep cadence, measured from the Pi's own timestamps rather than from render
// timing, so it reports what the radar is actually doing and not how fast React redrew.
// Median of the adjacent differences, so one dropped or stalled frame does not move it.
function PaneHeader({ icon: Icon, label, active, color, meta, action }) {
  const colorMap = {
    orange: { accent: '#D1855C', to: '#E5A986' },
    cyan:   { accent: '#22d3ee', to: '#67e8f9' },
    green:  { accent: '#4aff8a', to: '#86efac' },
  };
  const { accent, to } = colorMap[color] || colorMap.orange;

  return (
    <div className="relative flex items-center gap-2.5 px-5 py-2 border-b border-white/5 bg-[#050505]/80 backdrop-blur-sm shrink-0">
      <div
        className="w-px h-3 rounded-full transition-all duration-500"
        style={active
          ? { background: `linear-gradient(to bottom, ${accent}, ${to})` }
          : { background: '#333333' }
        }
      />
      <Icon
        size={13}
        strokeWidth={2}
        className="transition-colors duration-500"
        style={{ color: active ? accent : '#555555' }}
      />
      <span
        className="text-xs font-bold uppercase tracking-widest transition-colors duration-500"
        style={{ color: active ? accent : '#666666' }}
      >
        {label}
      </span>
      <div className="ml-auto flex items-center gap-3">
        {meta && (
          <span className="text-[10px] font-mono tabular-nums text-white/40">{meta}</span>
        )}
        {active && (
          <div className="flex items-center gap-1.5">
            <div className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: `${accent}b3` }}>
              Active
            </span>
          </div>
        )}
        {action && (
          <button
            type="button"
            title={action.title}
            onClick={action.onClick}
            className="p-1 -mr-1 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <action.icon size={13} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
