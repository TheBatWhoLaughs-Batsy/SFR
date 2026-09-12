import { useRef, useEffect } from 'react';

export default function ReceiverDisplay({ active, samples, paused }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const samplesRef = useRef(samples);
  const frozenRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  if (!paused) {
    samplesRef.current = samples;
    frozenRef.current = null;
  } else if (!frozenRef.current && samples?.length) {
    frozenRef.current = samples;
  }

  const zoomRef = useRef(512);
  const offsetRef = useRef(0);
  const mouseRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.3 : 0.77;
      const curr = zoomRef.current;
      zoomRef.current = Math.round(Math.max(8, Math.min(512, curr * factor)));
      const s = frozenRef.current || samplesRef.current;
      const len = s?.length || 512;
      offsetRef.current = Math.max(0, Math.min(len - zoomRef.current, offsetRef.current));
    };

    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const handleMouseLeave = () => { mouseRef.current = null; };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
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

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.stroke();

      const s = activeRef.current ? (frozenRef.current || samplesRef.current) : null;
      if (!s || s.length === 0) {
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

      const totalLen = s.length;
      const visibleCount = Math.min(zoomRef.current, totalLen);
      const off = Math.min(offsetRef.current, Math.max(0, totalLen - visibleCount));
      const yMid = h / 2;
      const yScale = h * 0.42;
      const pts = [];
      for (let i = 0; i < visibleCount; i++) {
        pts.push([i / (visibleCount - 1) * w, yMid - s[off + i] * yScale]);
      }

      const drawTrace = (ctx) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      };

      // Glow
      ctx.save();
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      drawTrace(ctx);
      ctx.stroke();
      ctx.restore();

      // Main
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      drawTrace(ctx);
      ctx.stroke();

      // Highlight
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      drawTrace(ctx);
      ctx.stroke();
      ctx.globalAlpha = 1;

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

        const sampleIdx = Math.round((mx / w) * (visibleCount - 1));
        const actualIdx = off + sampleIdx;
        const amplitude = (actualIdx >= 0 && actualIdx < totalLen) ? s[actualIdx] : 0;
        const timeUs = actualIdx * 0.5;

        if (sampleIdx >= 0 && sampleIdx < visibleCount) {
          const dotY = pts[sampleIdx][1];
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(mx, dotY, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#22d3ee';
          ctx.beginPath();
          ctx.arc(mx, dotY, 2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = 'rgba(5,5,5,0.85)';
        ctx.strokeStyle = 'rgba(34,211,238,0.3)';
        ctx.lineWidth = 1;
        const tw = 120, th = 36;
        const tx = mx + 14 + tw > w ? mx - tw - 10 : mx + 14;
        const ty = my - th - 8 < 0 ? my + 12 : my - th - 8;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, th, 4);
        ctx.fill();
        ctx.stroke();

        ctx.font = '10px Inter, monospace';
        ctx.fillStyle = '#22d3ee';
        ctx.textAlign = 'left';
        ctx.fillText(`t: ${timeUs.toFixed(1)} µs`, tx + 8, ty + 14);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`A: ${amplitude.toFixed(3)}`, tx + 8, ty + 28);
      }

      // Y labels
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.font = '9px Inter, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('+1.0', 4, 12);
      ctx.fillText('-1.0', 4, h - 4);

      // Zoom indicator
      if (zoomRef.current < 512) {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(34,211,238,0.4)';
        ctx.fillText(`${visibleCount}/${totalLen} samples`, w - 6, 12);
      }

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="absolute inset-0" />;
}
