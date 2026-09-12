import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MC_RESOLUTION = 50;

const JET_STOPS = [
  [0.0, 0, 0, 0.5],
  [0.15, 0, 0, 1],
  [0.35, 0, 1, 1],
  [0.5, 0, 1, 0],
  [0.65, 1, 1, 0],
  [0.85, 1, 0, 0],
  [1.0, 0.5, 0, 0],
];

function jetColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < JET_STOPS.length - 1; i++) {
    const [t0, r0, g0, b0] = JET_STOPS[i];
    const [t1, r1, g1, b1] = JET_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  return [0.5, 0, 0];
}

export default function TomoDisplay({ tomoResult, isoLevel = 0.3 }) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const mcRef = useRef(null);
  const frameRef = useRef(null);
  const wireframeRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(2.0, 1.6, -2.2);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
    d1.position.set(5, 10, 7);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0x8888ff, 0.4);
    d2.position.set(-5, -3, -5);
    scene.add(d2);

    scene.add(new THREE.AxesHelper(1.2));

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      controls.dispose();
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  const normalizedVolume = useMemo(() => {
    if (!tomoResult || !tomoResult.volume) return null;
    const vol = tomoResult.volume;
    let vmax = 0;
    for (let i = 0; i < vol.length; i++) {
      if (vol[i] > vmax) vmax = vol[i];
    }
    if (vmax === 0) return null;
    const norm = new Float32Array(vol.length);
    for (let i = 0; i < vol.length; i++) norm[i] = vol[i] / vmax;
    return norm;
  }, [tomoResult]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (mcRef.current) {
      scene.remove(mcRef.current);
      mcRef.current.material.dispose();
      mcRef.current = null;
    }
    if (wireframeRef.current) {
      scene.remove(wireframeRef.current);
      wireframeRef.current.geometry.dispose();
      wireframeRef.current.material.dispose();
      wireframeRef.current = null;
    }

    if (!normalizedVolume || !tomoResult) return;

    const { pixelsX, pixelsY, pixelsZ, xMaxCm, yMaxCm, depthMaxCm } = tomoResult;

    const mat = new THREE.MeshPhongMaterial({
      color: 0x44aaff,
      vertexColors: true,
      shininess: 40,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });

    const mc = new MarchingCubes(MC_RESOLUTION, mat, true, true, 100000);
    mc.isolation = isoLevel * 255;

    const maxDim = Math.max(xMaxCm, yMaxCm, depthMaxCm) || 1;
    mc.scale.set(xMaxCm / maxDim, yMaxCm / maxDim, depthMaxCm / maxDim);

    mc.reset();

    for (let zi = 0; zi < pixelsZ; zi++) {
      const zn = pixelsZ > 1 ? zi / (pixelsZ - 1) : 0.5;
      for (let yi = 0; yi < pixelsY; yi++) {
        const yn = pixelsY > 1 ? yi / (pixelsY - 1) : 0.5;
        for (let xi = 0; xi < pixelsX; xi++) {
          const xn = pixelsX > 1 ? xi / (pixelsX - 1) : 0.5;
          const val = normalizedVolume[zi * pixelsY * pixelsX + yi * pixelsX + xi];
          if (val > 0.01) {
            const depthFrac = zn;
            const [r, g, b] = jetColor(depthFrac);
            mc.addBall(xn, yn, zn, val * 0.5, 12, new THREE.Color(r, g, b));
          }
        }
      }
    }
    mc.update();

    scene.add(mc);
    mcRef.current = mc;

    const boxGeo = new THREE.BoxGeometry(
      xMaxCm / maxDim,
      yMaxCm / maxDim,
      depthMaxCm / maxDim,
    );
    const boxEdges = new THREE.EdgesGeometry(boxGeo);
    const boxLine = new THREE.LineSegments(
      boxEdges,
      new THREE.LineBasicMaterial({ color: 0x333333 }),
    );
    boxLine.position.set(
      (xMaxCm / maxDim) / 2,
      (yMaxCm / maxDim) / 2,
      (depthMaxCm / maxDim) / 2,
    );
    scene.add(boxLine);
    wireframeRef.current = boxLine;
    boxGeo.dispose();

  }, [normalizedVolume, tomoResult, isoLevel]);

  return (
    <div ref={containerRef} className="w-full h-full" />
  );
}
