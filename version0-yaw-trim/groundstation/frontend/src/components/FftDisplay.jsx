import { useRef, useEffect } from 'react';

export default function FftDisplay({ active, fftData, paused }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const dataRef = useRef(fftData);
  const frozenRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mouseRef = useRef(null);

  if (!paused) {
    dataRef.current = fftData;
    frozenRef.current = null;
  } else if (!frozenRef.current && fftData) {
    frozenRef.current = fftData;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const handleMouseLeave = () => { mouseRef.current = null; };

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    const draw = () => {
      const container = canvas.parentElement;
      const dpr = devicePixelRatio;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let i = 1; i < 6; i++) { const y = h / 6 * i; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      for (let i = 1; i < 12; i++) { const x = w / 12 * i; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();

      const d = activeRef.current ? (frozenRef.current || dataRef.current) : null;
      if (!d || !d.magnitudes || d.magnitudes.length === 0) {
        ctx.strokeStyle = 'rgba(85,85,85,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      const mags = d.magnitudes;
      const freqSpan = d.freq_span;
      const len = mags.length;
      const dbMin = -80, dbMax = 0;
      const margin = h * 0.05;
      const plotH = h - margin * 2;

      const toY = (db) => {
        const clamped = Math.max(dbMin, Math.min(dbMax, db));
        return margin + plotH * (1 - (clamped - dbMin) / (dbMax - dbMin));
      };

      // Fill gradient
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(139,92,246,0.3)');
      grad.addColorStop(1, 'rgba(139,92,246,0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < len; i++) ctx.lineTo(i / (len - 1) * w, toY(mags[i]));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // Trace with glow
      const pts = [];
      for (let i = 0; i < len; i++) pts.push([i / (len - 1) * w, toY(mags[i])]);

      ctx.save();
      ctx.shadowColor = '#8b5cf6';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();

      // Peak
      let pk = 0;
      for (let i = 1; i < len; i++) if (mags[i] > mags[pk]) pk = i;
      const px = pk / (len - 1) * w;
      const py = toY(mags[pk]);
      ctx.save();
      ctx.shadowColor = '#ff4a6a'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#ff4a6a';
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      const peakFreq = ((pk / len) - 0.5) * freqSpan / 1000;
      ctx.fillStyle = '#ccc';
      ctx.font = '10px Inter, monospace';
      ctx.textAlign = pk > len * 0.7 ? 'right' : 'left';
      const lx = pk > len * 0.7 ? px - 8 : px + 8;
      ctx.fillText(mags[pk].toFixed(1) + ' dB', lx, py - 12);
      ctx.fillStyle = '#8b5cf6';
      ctx.fillText(peakFreq.toFixed(0) + ' kHz', lx, py - 1);

      // Cursor crosshair
      const mouse = mouseRef.current;
      if (mouse) {
        const mx = mouse.x;
        const my = mouse.y;

        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(mx, 0); ctx.lineTo(mx, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, my); ctx.lineTo(w, my);
        ctx.stroke();
        ctx.setLineDash([]);

        const binIdx = Math.round((mx / w) * (len - 1));
        const freq = ((binIdx / len) - 0.5) * freqSpan / 1000;
        const db = (binIdx >= 0 && binIdx < len) ? mags[binIdx] : -80;

        // Dot on trace
        if (binIdx >= 0 && binIdx < len) {
          const dotY = pts[binIdx][1];
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(mx, dotY, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#8b5cf6';
          ctx.beginPath();
          ctx.arc(mx, dotY, 2, 0, Math.PI * 2);
          ctx.fill();
        }

        // Tooltip
        ctx.fillStyle = 'rgba(5,5,5,0.85)';
        ctx.strokeStyle = 'rgba(139,92,246,0.3)';
        ctx.lineWidth = 1;
        const tw = 120, th = 36;
        const tx = mx + 14 + tw > w ? mx - tw - 10 : mx + 14;
        const ty = my - th - 8 < 0 ? my + 12 : my - th - 8;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, th, 4);
        ctx.fill();
        ctx.stroke();

        ctx.font = '10px Inter, monospace';
        ctx.fillStyle = '#8b5cf6';
        ctx.textAlign = 'left';
        ctx.fillText(`f: ${freq.toFixed(1)} kHz`, tx + 8, ty + 14);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${db.toFixed(1)} dB`, tx + 8, ty + 28);
      }

      // Axis labels
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.font = '9px Inter, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('0 dB', 4, margin + 4);
      ctx.fillText('-80', 4, h - margin);
      ctx.textAlign = 'center';
      const hs = (freqSpan / 2000).toFixed(0);
      ctx.fillText('-' + hs + 'k', w * 0.05, h - 2);
      ctx.fillText('0', w / 2, h - 2);
      ctx.fillText('+' + hs + 'k', w * 0.95, h - 2);

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="absolute inset-0" />;
}
