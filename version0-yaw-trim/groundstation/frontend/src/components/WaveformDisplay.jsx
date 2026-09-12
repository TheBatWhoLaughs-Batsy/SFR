import { useRef, useEffect } from 'react';

export default function WaveformDisplay({ active }) {
  const canvasRef = useRef(null);
  const phaseRef = useRef(0);
  const frameRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

      // Center line (brighter)
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.stroke();

      if (!active) {
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

      phaseRef.current += 0.04;
      const cycles = 4;
      const n = 200;
      const yMid = h / 2;
      const amp = h * 0.38;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        pts.push([t * w, yMid - Math.sin(t * cycles * Math.PI * 2 + phaseRef.current) * amp]);
      }

      // Glow
      ctx.save();
      ctx.shadowColor = '#D1855C';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = '#D1855C';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.restore();

      // Main
      ctx.strokeStyle = '#D1855C';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();

      // Highlight
      ctx.strokeStyle = '#E5A986';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [active]);

  return <canvas ref={canvasRef} className="absolute inset-0" />;
}
