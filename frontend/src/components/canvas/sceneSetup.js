/**
 * canvas/sceneSetup.js
 *
 * Inicializa os objetos Three.js fixos: cena, câmera, renderers, iluminação,
 * pivot, grid inicial, eixos globais e labels de eixo CSS2D.
 *
 * Retorna todos os objetos criados para que o chamador possa registrar refs
 * e fazer cleanup no unmount.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";

// Sinais de posição dos 4 cantos do grid: [±1 em X, ±1 em Z]
export const CORNER_SIGNS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Cria e configura a cena, câmera e os dois renderers (WebGL + CSS2D).
 *
 * @param {HTMLElement} container
 * @returns {{ scene, camera, renderer, labelRenderer, bgTexture }}
 */
export function setupRenderers(container) {
  const scene = new THREE.Scene();

  // Fundo gradiente (céu azul → bege quente)
  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = 2;
  bgCanvas.height = 512;
  const bgCtx = bgCanvas.getContext("2d");
  const grad = bgCtx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#9ebfdeff");
  grad.addColorStop(0.5, "#d9dfe5");
  grad.addColorStop(1, "#e3d5c8");
  bgCtx.fillStyle = grad;
  bgCtx.fillRect(0, 0, 2, 512);
  const bgTexture = new THREE.CanvasTexture(bgCanvas);
  bgTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTexture;

  const width = container.clientWidth;
  const height = container.clientHeight;

  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(8, -8, 8);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.top = "0";
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(width, height);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  // Iluminação
  scene.add(new THREE.AmbientLight(0x404040, 1.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  return { scene, camera, renderer, labelRenderer, bgTexture };
}

/**
 * Cria o pivot (plano de trabalho), o grid inicial e os handles de canto.
 *
 * @param {THREE.Scene} scene
 * @param {number} halfSize - semi-extensão inicial do grid
 * @returns {{ pivot, gridVisual, corners }}
 */
export function setupPivotAndGrid(scene, halfSize = 5) {
  const pivot = new THREE.Group();
  pivot.rotation.set(Math.PI / 2, 0, 0);
  scene.add(pivot);

  const gridVisual = new THREE.GridHelper(10, 10, 0x888888, 0x444444);
  pivot.add(gridVisual);

  // AxesHelper global
  scene.add(new THREE.AxesHelper(3));

  // Labels CSS2D para os eixos globais
  const axisColors = ["#ff4444", "#44ff44", "#4488ff"];
  ["X", "Y", "Z"].forEach((axis, idx) => {
    const div = document.createElement("div");
    div.textContent = axis;
    div.style.fontFamily = "sans-serif";
    div.style.padding = "2px 4px";
    div.style.background = "rgba(0,0,0,0.5)";
    div.style.color = axisColors[idx];
    div.style.fontWeight = "bold";
    div.style.userSelect = "none";
    const label = new CSS2DObject(div);
    const positions = [[3.2, 0, 0], [0, 3.2, 0], [0, 0, 3.2]];
    label.position.set(...positions[idx]);
    scene.add(label);
  });

  // Handles de canto (cubos brancos nos 4 cantos do grid)
  const handleGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const corners = CORNER_SIGNS.map(([sx, sz]) => {
    const h = new THREE.Mesh(handleGeo, handleMat);
    h.position.set(sx * halfSize, 0, sz * halfSize);
    pivot.add(h);
    return h;
  });

  return { pivot, gridVisual, corners };
}

/**
 * Cria OrbitControls e os dois TransformControls (translação + rotação do pivot).
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {HTMLElement} domElement
 * @param {THREE.Group} pivot
 * @param {function} onCenterChange - chamado quando o pivot se move
 * @returns {{ orbitControls, translateControls, rotateControls }}
 */
export function setupControls(scene, camera, domElement, pivot, onCenterChange) {
  const orbitControls = new OrbitControls(camera, domElement);
  orbitControls.enableDamping = true;

  const translateControls = new TransformControls(camera, domElement);
  translateControls.setMode("translate");
  translateControls.setSpace("local");
  translateControls.attach(pivot);
  scene.add(translateControls.getHelper());

  translateControls.addEventListener("dragging-changed", (e) => {
    orbitControls.enabled = !e.value;
    // rotateControls pode não existir ainda — referenciado via closure abaixo
  });
  translateControls.addEventListener("change", () => {
    const p = pivot.position;
    onCenterChange({ x: p.x, y: p.y, z: p.z });
  });

  const rotateControls = new TransformControls(camera, domElement);
  rotateControls.setMode("rotate");
  rotateControls.setSpace("local");
  rotateControls.attach(pivot);
  scene.add(rotateControls.getHelper());

  rotateControls.addEventListener("dragging-changed", (e) => {
    orbitControls.enabled = !e.value;
    translateControls.enabled = !e.value;
  });

  // Agora que rotateControls existe, conecta o listener de translateControls
  translateControls.addEventListener("dragging-changed", (e) => {
    rotateControls.enabled = !e.value;
  });

  return { orbitControls, translateControls, rotateControls };
}
