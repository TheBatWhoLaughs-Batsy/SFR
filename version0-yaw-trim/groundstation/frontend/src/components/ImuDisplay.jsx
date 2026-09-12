import { useRef, useEffect } from 'react';
import * as THREE from 'three';

export default function ImuDisplay({ imuData }) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const qRef = useRef([1, 0, 0, 0]);
  const lastTimeRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(3, 2, 3);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    container.appendChild(renderer.domElement);

    const boardGeo = new THREE.BoxGeometry(2, 0.15, 1.4);
    const boardMat = new THREE.MeshPhongMaterial({ color: 0x1a5c2a });
    const board = new THREE.Mesh(boardGeo, boardMat);

    const chipGeo = new THREE.BoxGeometry(0.4, 0.1, 0.4);
    const chipMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
    const chip = new THREE.Mesh(chipGeo, chipMat);
    chip.position.y = 0.125;

    const group = new THREE.Group();
    group.add(board);
    group.add(chip);
    scene.add(group);

    const axes = new THREE.AxesHelper(1.5);
    scene.add(axes);

    const grid = new THREE.GridHelper(6, 12, 0x1a1a1a, 0x0f0f0f);
    grid.position.y = -1.5;
    scene.add(grid);

    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 5, 5);
    scene.add(dir);

    sceneRef.current = { scene, camera, renderer, group };

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(container);

    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      obs.disconnect();
      cancelAnimationFrame(frame);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    if (!imuData || !imuData.accel || !imuData.gyro || !sceneRef.current) return;

    const { group } = sceneRef.current;
    const [aFwd, aLeft, aUp] = imuData.accel;
    const [gRoll, gPitch, gYaw] = imuData.gyro;
    const now = imuData.timestamp;

    if (lastTimeRef.current === null) {
      lastTimeRef.current = now;
      return;
    }

    const dt = now - lastTimeRef.current;
    lastTimeRef.current = now;
    if (dt <= 0 || dt > 1) return;

    const q = qRef.current;
    const BETA = 0.04;
    const DEG = Math.PI / 180;

    let [qw, qx, qy, qz] = q;
    let ax = aFwd, ay = aLeft, az = aUp;

    let norm = Math.sqrt(ax * ax + ay * ay + az * az);
    if (norm < 0.01) return;
    const recipNorm = 1.0 / norm;
    ax *= recipNorm; ay *= recipNorm; az *= recipNorm;

    const _2qw = 2*qw, _2qx = 2*qx, _2qy = 2*qy, _2qz = 2*qz;
    const _4qw = 4*qw, _4qx = 4*qx, _4qy = 4*qy;
    const _8qx = 8*qx, _8qy = 8*qy;
    const qwqw = qw*qw, qxqx = qx*qx, qyqy = qy*qy, qzqz = qz*qz;

    let s0 = _4qw*qyqy + _2qy*ax + _4qw*qxqx - _2qx*ay;
    let s1 = _4qx*qzqz - _2qz*ax + 4*qwqw*qx - _2qw*ay - _4qx + _8qx*qxqx + _8qx*qyqy + _4qx*az;
    let s2 = 4*qwqw*qy + _2qw*ax + _4qy*qzqz - _2qz*ay - _4qy + _8qy*qxqx + _8qy*qyqy + _4qy*az;
    let s3 = 4*qxqx*qz - _2qx*ax + 4*qyqy*qz - _2qy*ay;

    norm = Math.sqrt(s0*s0 + s1*s1 + s2*s2 + s3*s3);
    if (norm > 0) { const rn = 1/norm; s0 *= rn; s1 *= rn; s2 *= rn; s3 *= rn; }

    const gxr = gRoll*DEG, gyr = gPitch*DEG, gzr = gYaw*DEG;
    const qDot0 = 0.5*(-qx*gxr - qy*gyr - qz*gzr);
    const qDot1 = 0.5*(qw*gxr + qy*gzr - qz*gyr);
    const qDot2 = 0.5*(qw*gyr - qx*gzr + qz*gxr);
    const qDot3 = 0.5*(qw*gzr + qx*gyr - qy*gxr);

    qw += (qDot0 - BETA*s0)*dt;
    qx += (qDot1 - BETA*s1)*dt;
    qy += (qDot2 - BETA*s2)*dt;
    qz += (qDot3 - BETA*s3)*dt;

    norm = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
    qRef.current = [qw/norm, qx/norm, qy/norm, qz/norm];

    const [nqw, nqx, nqy, nqz] = qRef.current;
    group.quaternion.set(-nqy, nqz, -nqx, nqw);
  }, [imuData]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
