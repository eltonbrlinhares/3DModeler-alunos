/**
 * src/components/ViewCube.jsx
 *
 * Cubo de orientação no canto superior direito do canvas.
 * Sincroniza a rotação do cubo com a câmera principal e permite clicar
 * nas faces/arestas/cantos para fazer snap da câmera para essa vista.
 *
 * Props:
 *   canvasRef — ref do ThreeCanvas (expõe getCamera() e getOrbitControls())
 */

import { useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';

// Ordem das faces do BoxGeometry: +X, -X, +Y, -Y, +Z, -Z
// Convenção Z-up (padrão CAD): Z é o eixo vertical (topo/base)
const FACE_LABELS = [
  { text: 'DIREITA',  color: '#cbd5e1' }, // +X
  { text: 'ESQUERDA', color: '#cbd5e1' }, // -X
  { text: 'TRÁS',     color: '#e2e8f0' }, // +Y
  { text: 'FRENTE',   color: '#e2e8f0' }, // -Y
  { text: 'TOPO',     color: '#f8fafc' }, // +Z  ← Z é para cima
  { text: 'BASE',     color: '#f8fafc' }, // -Z
];

function createLabelTexture(text, faceColor) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = faceColor;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);

  ctx.fillStyle = '#334155';
  ctx.font = 'bold 36px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createCube() {
  const materials = FACE_LABELS.map(({ text, color }) =>
    new THREE.MeshBasicMaterial({ map: createLabelTexture(text, color) })
  );
  const geo  = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  return new THREE.Mesh(geo, materials);
}

// Easing suave para a animação de snap
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export default function ViewCube({ canvasRef }) {
  const vcCanvasRef = useRef(null);
  const stateRef    = useRef(null);
  const snapRef     = useRef(null); // { fromPos, toPos, fromTarget, toTarget, t }

  // ── Inicializa a mini-cena Three.js do cubo ──────────────────────────────
  useEffect(() => {
    const canvas = vcCanvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 4);

    const cube = createCube();
    scene.add(cube);

    // Highlight semi-transparente ao passar o mouse
    const hoverGeo  = new THREE.BoxGeometry(1.61, 1.61, 1.61);
    const hoverMat  = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    const hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    hoverMesh.visible = false;
    scene.add(hoverMesh);

    scene.add(new THREE.AmbientLight(0xffffff, 1));

    stateRef.current = { renderer, scene, camera, cube, hoverMesh };

    // ── Rastreamento do mouse para hover ──────────────────────────────────
    const mouse     = new THREE.Vector2(-100, -100);
    const raycaster = new THREE.Raycaster();

    const onMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    };
    const onMouseLeave = () => mouse.set(-100, -100);

    canvas.addEventListener('mousemove',  onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);

    // ── Loop de animação ──────────────────────────────────────────────────
    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);

      const mainCam  = canvasRef.current?.getCamera();
      const controls = canvasRef.current?.getOrbitControls();

      // Sincroniza rotação do cubo com a câmera principal
      if (mainCam) {
        cube.quaternion.copy(mainCam.quaternion).invert();
        hoverMesh.quaternion.copy(cube.quaternion);
      }

      // Animação de snap suave
      if (snapRef.current && mainCam && controls) {
        const snap = snapRef.current;
        snap.t = Math.min(snap.t + 0.07, 1);
        const t = easeInOut(snap.t);
        mainCam.position.lerpVectors(snap.fromPos, snap.toPos, t);
        controls.target.lerpVectors(snap.fromTarget, snap.toTarget, t);
        controls.update();
        if (snap.t >= 1) snapRef.current = null;
      }

      // Hover: destaca a face/aresta/canto sob o cursor
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(cube);

      if (hits.length > 0) {
        hoverMesh.visible = true;

        const localPt = hits[0].point.clone();
        cube.worldToLocal(localPt);

        const dir       = new THREE.Vector3();
        const threshold = 0.4;
        if (localPt.x >  threshold) dir.x =  1;
        else if (localPt.x < -threshold) dir.x = -1;
        if (localPt.y >  threshold) dir.y =  1;
        else if (localPt.y < -threshold) dir.y = -1;
        if (localPt.z >  threshold) dir.z =  1;
        else if (localPt.z < -threshold) dir.z = -1;
        if (dir.lengthSq() === 0) dir.copy(hits[0].face.normal);

        const s    = 1.61;
        const edgeW = 0.4;
        hoverMesh.scale.set(
          dir.x !== 0 ? edgeW / s : 1,
          dir.y !== 0 ? edgeW / s : 1,
          dir.z !== 0 ? edgeW / s : 1,
        );
        hoverMesh.position
          .set(dir.x * (s - edgeW) / 2, dir.y * (s - edgeW) / 2, dir.z * (s - edgeW) / 2)
          .applyQuaternion(cube.quaternion);
      } else {
        hoverMesh.visible = false;
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener('mousemove',  onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      hoverGeo.dispose();
      hoverMat.dispose();
      cube.geometry.dispose();
      cube.material.forEach((m) => { m.map?.dispose(); m.dispose(); });
      renderer.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clique para snap de câmera ────────────────────────────────────────────
  const handleClick = useCallback((e) => {
    const { camera, cube, renderer } = stateRef.current ?? {};
    const mainCam  = canvasRef.current?.getCamera();
    const controls = canvasRef.current?.getOrbitControls();
    if (!camera || !mainCam || !controls) return;

    const rect  = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
       ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(cube);
    if (hits.length === 0) return;

    const localPt = hits[0].point.clone();
    cube.worldToLocal(localPt);

    const dir       = new THREE.Vector3();
    const threshold = 0.4;
    if (localPt.x >  threshold) dir.x =  1;
    else if (localPt.x < -threshold) dir.x = -1;
    if (localPt.y >  threshold) dir.y =  1;
    else if (localPt.y < -threshold) dir.y = -1;
    if (localPt.z >  threshold) dir.z =  1;
    else if (localPt.z < -threshold) dir.z = -1;
    if (dir.lengthSq() === 0) dir.copy(hits[0].face.normal);
    dir.normalize();

    const currentTarget = controls.target.clone();
    const distance      = mainCam.position.distanceTo(controls.target);
    const toPos         = currentTarget.clone().add(dir.clone().multiplyScalar(distance));

    // Up vector: convenção Z-up — se olhar de cima/baixo (dir.z dominante), usa Y; senão usa Z
    let up = new THREE.Vector3(0, 0, 1);
    if (Math.abs(dir.z) > 0.9) {
      up.set(0, 1, 0);
    }
    // Orienta a câmera já na posição final para que o OrbitControls não perca o "up"
    const tmpCam = mainCam.clone();
    tmpCam.position.copy(toPos);
    tmpCam.up.copy(up);
    tmpCam.lookAt(currentTarget);
    mainCam.up.copy(up);

    snapRef.current = {
      fromPos:    mainCam.position.clone(),
      toPos,
      fromTarget: currentTarget.clone(),
      toTarget:   currentTarget.clone(),
      t: 0,
    };
  }, [canvasRef]);

  return (
    <canvas
      ref={vcCanvasRef}
      className="viewcube-canvas"
      onClick={handleClick}
      width={120}
      height={120}
    />
  );
}
