import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildWallTwin } from '@/lib/wallTwin';

// 3D digital twin of the scanned wall. Everything is in CENTIMETRES and drawn to scale:
// the cuboid is the scanned patch (scan width x scanned height x wall thickness), and
// each confirmed detection is a cylinder along its fitted line (lib/wallTwin.js). The
// camera orbits the cuboid's centre (left-drag), the wheel zooms, panning is off so the
// centre stays put.
//
// World frame: X = lateral position, Y = height, Z = out of the wall towards the
// operator. The FRONT face (operator side) is at Z = +thickness/2; a pipe at depth d
// sits at Z = thickness/2 - d, so one behind the back face is drawn behind the cuboid.
//
// Renderer, controls and the animation loop live for the component's lifetime; the
// scene content is rebuilt on its own whenever the twin changes, so a new detection does
// not recreate the WebGL context.

const PIPE_COLORS = { confirmed: 0x4ade80, probable: 0xfbbf24 };

function textSprite(text, color = '#e5e7eb') {
  const pad = 6, fontPx = 28;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `bold ${fontPx}px monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.width = w; c.height = fontPx + pad * 2;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, c.width, c.height);
  g.font = `bold ${fontPx}px monospace`;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.renderOrder = 10;
  s.userData.aspect = c.width / c.height;
  return s;
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
  group.clear();
}

export default function SarWall3D({ detection, detectProgress, vStep, wallThicknessCm, handleEnds }) {
  const hostRef = useRef(null);
  const threeRef = useRef(null);
  const [showProbable, setShowProbable] = useState(false);

  const twin = useMemo(
    () => buildWallTwin(detection, { vStep, wallThicknessCm, handleEnds, includeProbable: showProbable }),
    [detection, vStep, wallThicknessCm, handleEnds, showProbable],
  );

  // renderer / camera / controls / loop -- once
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(host.ownerDocument.defaultView.devicePixelRatio || 1);
    renderer.setClearColor(0x050505, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 1.0;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(60, 80, 120);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-80, -40, -60);
    scene.add(fill);

    const content = new THREE.Group();
    scene.add(content);

    const resize = () => {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    const win = host.ownerDocument.defaultView;
    const loop = () => {
      controls.update();
      // keep label sprites a constant size on screen regardless of zoom
      const dist = camera.position.distanceTo(controls.target);
      content.traverse((o) => {
        if (o.isSprite) { const hgt = dist * (o.userData.small ? 0.011 : 0.014); o.scale.set(hgt * (o.userData.aspect || 4), hgt, 1); }
      });
      renderer.render(scene, camera);
      raf = win.requestAnimationFrame(loop);
    };
    raf = win.requestAnimationFrame(loop);

    threeRef.current = { renderer, scene, camera, controls, content, fitted: false };
    return () => {
      win.cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(content);
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      threeRef.current = null;
    };
  }, []);

  // scene content -- whenever the twin changes
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    disposeGroup(t.content);
    if (!twin) return;
    const { wall, pipes } = twin;
    const W = wall.x1 - wall.x0, H = wall.y1 - wall.y0, T = wall.thickness;
    const cx = (wall.x0 + wall.x1) / 2, cy = (wall.y0 + wall.y1) / 2;
    const toWorld = (x, y, depth) => new THREE.Vector3(x - cx, y - cy, T / 2 - depth);

    // the wall: translucent concrete with crisp edges, front face tinted so it reads as the operator side
    const box = new THREE.BoxGeometry(W, H, T);
    const faceMats = [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({
      color: i === 4 ? 0x8a8f98 : 0x6b7280, transparent: true, opacity: i === 4 ? 0.22 : 0.14,
      roughness: 0.95, metalness: 0, depthWrite: false, side: THREE.DoubleSide,
    }));
    const wallMesh = new THREE.Mesh(box, faceMats);
    wallMesh.renderOrder = 1;
    t.content.add(wallMesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xd1d5db, transparent: true, opacity: 0.8 }));
    t.content.add(edges);

    // scanned rows as faint lines on the front face
    const rowMat = new THREE.LineBasicMaterial({ color: 0xD1855C, transparent: true, opacity: 0.35 });
    for (const y of twin.rowYs) {
      const g = new THREE.BufferGeometry().setFromPoints([toWorld(wall.x0, y, 0), toWorld(wall.x1, y, 0)]);
      t.content.add(new THREE.Line(g, rowMat.clone()));
    }

    // centimetre ticks along the bottom front edge, every 10 cm
    const tickMat = new THREE.LineBasicMaterial({ color: 0x9ca3af });
    for (let x = Math.ceil(wall.x0 / 10) * 10; x <= wall.x1 + 1e-6; x += 10) {
      const a = toWorld(x, wall.y0, 0), b = toWorld(x, wall.y0 - Math.max(0.8, H * 0.08), 0);
      t.content.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), tickMat.clone()));
      const s = textSprite(`${x.toFixed(0)}`, '#9ca3af');
      s.userData.small = true;
      s.position.copy(toWorld(x, wall.y0 - Math.max(2.2, H * 0.22), 0));
      t.content.add(s);
    }
    // Dimensions are in the overlay, not the scene: a label at the patch centre sat on
    // top of whichever pipe happened to be near the middle.
    const front = textSprite('front face', '#D1855C');
    front.userData.small = true;
    front.position.copy(toWorld(wall.x0 - 6, cy, 0));
    t.content.add(front);

    // pipes
    for (const p of pipes) {
      const a = toWorld(p.p0.x, p.p0.y, p.p0.depth), b = toWorld(p.p1.x, p.p1.y, p.p1.depth);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const geo = new THREE.CylinderGeometry(p.diameter / 2, p.diameter / 2, len, 32, 1, false);
      const mat = new THREE.MeshStandardMaterial({ color: PIPE_COLORS[p.rating] || 0x4ade80, roughness: 0.45, metalness: 0.1,
        transparent: p.rating !== 'confirmed', opacity: p.rating === 'confirmed' ? 1 : 0.7 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      mesh.renderOrder = 2;
      t.content.add(mesh);
      const lbl = textSprite(`${p.xMid.toFixed(1)} cm · ${p.depthMid.toFixed(1)} deep`, p.rating === 'confirmed' ? '#4ade80' : '#fbbf24');
      lbl.userData.small = true;
      lbl.position.copy(b).add(new THREE.Vector3(0, Math.max(2.5, H * 0.35), 0));
      t.content.add(lbl);
    }

    // seepage-mode patches: translucent boxes over their columns, rows and depths
    for (const m of twin.moisture || []) {
      const bw = Math.max(0.5, m.x1 - m.x0), bh = Math.max(0.5, m.y1 - m.y0), bd = Math.max(0.5, m.z1 - m.z0);
      const color = m.rating === 'moisture' ? 0x38bdf8 : 0xfbbf24;
      const geo = new THREE.BoxGeometry(bw, bh, bd);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35, roughness: 0.9, metalness: 0, depthWrite: false }));
      const centre = toWorld((m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, (m.z0 + m.z1) / 2);
      mesh.position.copy(centre);
      mesh.renderOrder = 2;
      t.content.add(mesh);
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color }));
      outline.position.copy(centre);
      t.content.add(outline);
      const lbl = textSprite(`${m.rating === 'moisture' ? 'moisture?' : 'unverified'} · ${m.x0.toFixed(0)}-${m.x1.toFixed(0)} cm · ~${m.depth.toFixed(1)} deep`,
        m.rating === 'moisture' ? '#38bdf8' : '#fbbf24');
      lbl.userData.small = true;
      lbl.position.copy(toWorld((m.x0 + m.x1) / 2, m.y1, m.z0)).add(new THREE.Vector3(0, Math.max(2.5, H * 0.35), 0));
      t.content.add(lbl);
    }

    // frame the model once per mount, then leave the operator's view alone
    if (!t.fitted) {
      const radius = 0.5 * Math.sqrt(W * W + H * H + (T + 10) * (T + 10));
      const dist = radius / Math.sin((t.camera.fov * Math.PI / 180) / 2) * 0.9;
      t.camera.position.set(-0.35 * dist, 0.45 * dist, 0.82 * dist);
      t.controls.minDistance = radius * 0.3;
      t.controls.maxDistance = dist * 6;
      t.controls.target.set(0, 0, 0);
      t.controls.update();
      t.fitted = true;
    }
  }, [twin]);

  const pipes = twin ? twin.pipes : [];
  const moisture = twin ? twin.moisture : [];
  const seepageMode = !!(detection && detection.mode === 'seepage');
  return (
    <div className="relative w-full h-full">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="absolute top-2 left-3 flex flex-col gap-1 pointer-events-none">
        <span className="text-[10px] font-bold font-mono text-[#4ade80]">WALL DIGITAL TWIN (to scale, cm)</span>
        {twin && (
          <span className="text-[9px] font-mono text-white/50">
            {(twin.wall.x1 - twin.wall.x0).toFixed(1)} wide x {(twin.wall.y1 - twin.wall.y0).toFixed(1)} tall x {twin.wall.thickness.toFixed(1)} thick
            {' · '}{twin.rowYs.length} row{twin.rowYs.length === 1 ? '' : 's'}{twin.usedReference ? ' · empty reference applied' : ''}
            {twin.minLeanDeg < 89 ? ` · leans under ${twin.minLeanDeg.toFixed(0)}° are not measurable at this height` : ''}
          </span>
        )}
        {detectProgress !== null && detectProgress !== undefined && (
          <span className="text-[9px] font-mono text-emerald-400">Detecting... {Math.round(detectProgress * 100)}%</span>
        )}
        {!detection && (detectProgress === null || detectProgress === undefined) && (
          <span className="text-[9px] font-mono text-white/40">No detection yet.</span>
        )}
        {detection && !seepageMode && pipes.length === 0 && (
          <span className="text-[9px] font-mono text-white/40">No {showProbable ? 'confirmed or probable' : 'confirmed'} targets to place.</span>
        )}
        {seepageMode && moisture.length === 0 && (
          <span className="text-[9px] font-mono text-white/40">No in-wall patches to place.</span>
        )}
      </div>
      {moisture.length > 0 && (
        <div className="absolute top-2 right-3 flex flex-col gap-1 px-2 py-1.5 rounded-lg bg-black/60 border border-white/10 pointer-events-none max-w-[320px]">
          {moisture.map((m) => (
            <div key={`${m.x0}-${m.y0}`} className={m.rating === 'moisture' ? 'text-sky-300' : 'text-amber-400'}>
              <div className="text-[10px] font-mono font-bold">
                {m.rating === 'moisture' ? 'possible moisture' : 'unverified patch'}: {m.x0.toFixed(1)}-{m.x1.toFixed(1)} cm, ~{m.depth.toFixed(1)} cm deep
              </div>
              <div className="text-[9px] font-mono opacity-75">
                depth {m.z0.toFixed(1)}-{m.z1.toFixed(1)} cm · {m.rowsSeen}/{m.rowsTotal} rows · {m.meanDb >= 0 ? '+' : ''}{m.meanDb.toFixed(1)} dB
              </div>
            </div>
          ))}
        </div>
      )}
      {pipes.length > 0 && (
        <div className="absolute top-2 right-3 flex flex-col gap-1 px-2 py-1.5 rounded-lg bg-black/60 border border-white/10 pointer-events-none max-w-[320px]">
          {pipes.map((p) => (
            <div key={`${p.xMid}-${p.depthMid}`} className={p.rating === 'confirmed' ? 'text-[#4ade80]' : 'text-amber-400'}>
              <div className="text-[10px] font-mono font-bold">{p.xMid.toFixed(1)} cm, {p.depthMid.toFixed(1)} cm deep{p.behindWall ? ' (behind wall)' : ''}</div>
              <div className="text-[9px] font-mono opacity-75">
                dia ~{p.diameter.toFixed(1)} cm · lean {p.tiltKept ? `${p.tiltDeg.toFixed(1)}°` : 'none'} · seen in {p.rowsSeen}/{p.rowsTotal} rows
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="absolute bottom-2 left-3 flex items-center gap-3">
        <span className="text-[9px] font-mono text-white/35 pointer-events-none">drag to rotate · scroll to zoom</span>
        {!seepageMode && <button
          type="button"
          onClick={() => setShowProbable((v) => !v)}
          className={showProbable
            ? 'px-2 py-0.5 rounded-md text-[9px] font-medium border bg-amber-400/10 border-amber-400/30 text-amber-400'
            : 'px-2 py-0.5 rounded-md text-[9px] font-medium border bg-white/5 border-white/10 text-white/50 hover:text-white'}
        >
          {showProbable ? 'showing probable too' : 'confirmed only'}
        </button>}
      </div>
    </div>
  );
}
