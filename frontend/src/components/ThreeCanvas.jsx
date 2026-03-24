/**
 * src/components/ThreeCanvas.jsx
 *
 * Viewport 3D principal da aplicação. Inicializa e gerencia toda a cena Three.js:
 *   - Renderizadores WebGL (geometrias 3D) e CSS2D (labels de eixo)
 *   - Câmera perspectiva e OrbitControls (rotacionar/pan/zoom com mouse)
 *   - TransformControls duplos: um para Translação, outro para Rotação do pivot
 *   - Grid redimensionável com handles de canto arrastáveis
 *   - Sistema de desenho de curvas 2D no plano de trabalho (linha, polilinha, arco, spline)
 *
 * API Imperativa (via `forwardRef` + `useImperativeHandle`):
 *   O componente pai (ThreeGrid) acessa os métodos abaixo via `canvasRef.current`:
 *     setCenter(x, y, z)          — move o pivot
 *     setTranslationSnap(value)   — passo de snap de translação (0 = livre)
 *     setRotationSnap(degrees)    — passo de snap de rotação (0 = livre)
 *     setGridVisible(bool)        — mostra/oculta o GridHelper
 *     setGridSize(spacing)        — reconstrói o grid com novo espaçamento
 *     setPlane(planeName)         — reorienta o pivot para XZ / XY / YZ
 *     setActiveTool(tool)         — muda ferramenta ativa, cancela desenho em curso
 *     getScene()                  — retorna a THREE.Scene
 *     getPivot()                  — retorna o THREE.Group pivot
 *
 * Props:
 *   onCoordsChange(str)       — chamado a cada mousemove com "X: n, Y: n, Z: n"
 *   onCenterChange({x,y,z})   — chamado quando o usuário arrasta o TransformControl
 *   onSketchCommit(pts, cfg)  — chamado ao finalizar um desenho (Enter / duplo-clique)
 */

import {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import * as THREE from "three";

import {
  setupRenderers,
  setupPivotAndGrid,
  setupControls,
  CORNER_SIGNS,
} from "./canvas/sceneSetup.js";
import {
  buildNURBS,
  computeSubdivTs,
  getLineEndpoints,
  isEndpointHandle,
} from "./canvas/curveUtils.js";
import { createGenerateSurface } from "./canvas/generateSurface.js";
import { createMeshSurface }     from "./canvas/meshSurface.js";
import { createModelIO }         from "./canvas/modelIO.js";

// ── Constantes de cor ──────────────────────────────────────────────────────
const COLOR_NORMAL   = 0xff2222;
const COLOR_HOVER    = 0xffcc00;
const COLOR_SELECTED = 0x0088ff;
const SURFACE_COLOR          = 0x7dd3fc;
const SURFACE_HOVER_COLOR    = 0xfbbf24;
const SURFACE_SELECTED_COLOR = 0x2563eb;

const ENDPOINT_SNAP_PX             = 14;
const ENDPOINT_FIRST_POINT_SNAP_PX = 24;

/**
 * ThreeCanvas — componente de viewport 3D com ref encaminhado.
 */
const ThreeCanvas = forwardRef(function ThreeCanvas(
  {
    onCoordsChange,
    onCenterChange,
    onSketchCommit,
    onToolChange,
    onSelectionCountChange,
    onSurfaceSelectChange,
  },
  ref,
) {
  // ── Refs internas ──────────────────────────────────────────────────────────
  const mountRef              = useRef();
  const isResizingRef         = useRef(false);
  const transformControlsRef  = useRef();
  const pivotRef              = useRef();
  const sceneInternalRef      = useRef(null);
  const gridVisualRef         = useRef();
  const cornerHandlesRef      = useRef([]);
  const gridHalfSizeRef       = useRef(5);
  const spacingRef            = useRef(1);
  const gridSnapRef           = useRef(false);
  const rebuildGridRef        = useRef();
  const cameraRef             = useRef(null);
  const orbitControlsRef      = useRef(null);
  const workPlaneVisibleRef   = useRef(true);
  const activeToolRef         = useRef("select");
  const cancelDrawingRef      = useRef();
  const clearSelectionRef     = useRef();
  const generateSurfaceRef    = useRef(() => false);
  const applySubdivRef        = useRef(null);
  const getSubdivParamsRef    = useRef(null);
  const onSketchCommitRef     = useRef(onSketchCommit);
  const meshSurfaceRef        = useRef(null);
  const getBoundarySubdivsRef = useRef(null);
  const hasSurfaceSelectedRef = useRef(false);
  const onSurfaceSelectChangeRef    = useRef(onSurfaceSelectChange);
  const onToolChangeRef             = useRef(onToolChange);
  const onSelectionCountChangeRef   = useRef(onSelectionCountChange);
  const exportModelRef  = useRef(null);
  const importModelRef  = useRef(null);

  // Mantém callbacks sempre atualizados sem re-executar o useEffect pesado
  useEffect(() => { onSketchCommitRef.current = onSketchCommit; }, [onSketchCommit]);
  useEffect(() => { onToolChangeRef.current = onToolChange; }, [onToolChange]);
  useEffect(() => { onSelectionCountChangeRef.current = onSelectionCountChange; }, [onSelectionCountChange]);

  // ── API Imperativa ─────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    setCenter(x, y, z) {
      if (pivotRef.current) pivotRef.current.position.set(x, y, z);
    },
    setTranslationSnap(value) {
      const tc = transformControlsRef.current?.translate;
      if (tc) tc.setTranslationSnap(value > 0 ? value : null);
    },
    setRotationSnap(degrees) {
      const tc = transformControlsRef.current?.rotate;
      if (tc) tc.setRotationSnap(degrees > 0 ? THREE.MathUtils.degToRad(degrees) : null);
    },
    setGridVisible(visible) {
      if (gridVisualRef.current) gridVisualRef.current.visible = visible;
      cornerHandlesRef.current.forEach((h) => { h.visible = visible; });
    },
    setGridSize(spacing) {
      spacingRef.current = Math.max(0.01, spacing);
      rebuildGridRef.current?.(gridHalfSizeRef.current, spacingRef.current);
    },
    setGridSnap(enabled) {
      gridSnapRef.current = enabled;
    },
    setPlane(planeName) {
      if (!pivotRef.current) return;
      const r = {
        XZ: [0, 0, 0],
        XY: [Math.PI / 2, 0, 0],
        YZ: [0, 0, Math.PI / 2],
      }[planeName] ?? [0, 0, 0];
      pivotRef.current.rotation.set(...r);
    },
    setActiveTool(tool) {
      cancelDrawingRef.current?.();
      clearSelectionRef.current?.();
      activeToolRef.current = tool;
      const isDrawing = tool !== "select";
      const tc = transformControlsRef.current;
      if (tc) {
        const allow = !isDrawing && workPlaneVisibleRef.current;
        tc.translate.enabled = allow;
        tc.rotate.enabled = allow;
      }
    },
    generateSurfaceFromSelection() {
      return generateSurfaceRef.current?.() ?? false;
    },
    setWorkPlaneControls(visible) {
      workPlaneVisibleRef.current = visible;
      const tc = transformControlsRef.current;
      if (!tc) return;
      const isDrawing = activeToolRef.current !== "select";
      const allow = visible && !isDrawing;
      tc.translate.enabled = allow;
      tc.rotate.enabled = allow;
      tc.translate.getHelper().visible = visible;
      tc.rotate.getHelper().visible = visible;
    },
    applySubdivisions(n, ratio) {
      applySubdivRef.current?.(n, ratio);
    },
    getSelectedSubdivParams() {
      return getSubdivParamsRef.current?.() ?? null;
    },
    meshSurface(algo, params) {
      return meshSurfaceRef.current?.(algo, params)
        ?? Promise.resolve({ error: 'Não inicializado.' });
    },
    hasSurfaceSelected() {
      return hasSurfaceSelectedRef.current;
    },
    getSurfaceBoundarySubdivs() {
      return getBoundarySubdivsRef.current?.() ?? null;
    },
    getScene:          () => sceneInternalRef.current,
    getPivot:          () => pivotRef.current,
    getCamera:         () => cameraRef.current,
    getOrbitControls:  () => orbitControlsRef.current,
    exportModel()       { return exportModelRef.current?.() ?? null; },
    importModel(data)   { return importModelRef.current?.(data) ?? false; },
  }));

  // ── Setup principal (executa uma vez ao montar) ────────────────────────────
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    container.style.position = "relative";

    // ── Cena, câmera e renderers ─────────────────────────────────────────────
    const { scene, camera, renderer, labelRenderer, bgTexture } =
      setupRenderers(container);
    sceneInternalRef.current = scene;
    cameraRef.current = camera;

    // ── Pivot, grid e handles de canto ───────────────────────────────────────
    const { pivot, gridVisual, corners } =
      setupPivotAndGrid(scene, gridHalfSizeRef.current);
    pivotRef.current   = pivot;
    gridVisualRef.current  = gridVisual;
    cornerHandlesRef.current = corners;

    // ── Função rebuildGrid ────────────────────────────────────────────────────
    const rebuildGrid = (halfSize, spacing) => {
      const old = gridVisualRef.current;
      const wasVisible = old?.visible ?? true;
      if (old) { pivot.remove(old); old.geometry.dispose(); }

      const n         = Math.max(1, Math.round(halfSize / spacing));
      const divisions = 2 * n;
      const totalSize = divisions * spacing;

      const newGrid = new THREE.GridHelper(totalSize, divisions, 0x888888, 0x444444);
      newGrid.visible = wasVisible;
      pivot.add(newGrid);
      gridVisualRef.current = newGrid;

      const hs = totalSize / 2;
      gridHalfSizeRef.current = hs;
      CORNER_SIGNS.forEach(([sx, sz], i) => {
        corners[i].position.set(sx * hs, 0, sz * hs);
      });
    };
    rebuildGridRef.current = rebuildGrid;

    // ── OrbitControls + TransformControls ────────────────────────────────────
    const { orbitControls, translateControls, rotateControls } =
      setupControls(scene, camera, renderer.domElement, pivot, onCenterChange);
    orbitControlsRef.current = orbitControls;
    transformControlsRef.current = { translate: translateControls, rotate: rotateControls };

    // ── Helpers de raycasting ─────────────────────────────────────────────────
    const getNDC = (clientX, clientY) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const getPlanePoint = (clientX, clientY) => {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(getNDC(clientX, clientY), camera);
      const normal = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(pivot.quaternion)
        .normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pivot.position);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
    };

    const snapPoint = (worldPt) => {
      if (!gridSnapRef.current) return worldPt;
      const s = spacingRef.current;
      const local = pivot.worldToLocal(worldPt.clone());
      local.x = Math.round(local.x / s) * s;
      local.z = Math.round(local.z / s) * s;
      return pivot.localToWorld(local);
    };

    const findEndpointSnapTarget = (
      clientX, clientY, worldPt,
      {
        excludeLine = null,
        pixelTolerance = ENDPOINT_SNAP_PX,
        worldTolerance = Math.max(0.1, spacingRef.current * 0.35),
      } = {},
    ) => {
      let closestPoint = null;
      let closestDistSq = pixelTolerance * pixelTolerance;
      let closestWorldDist = worldTolerance;
      const rect = renderer.domElement.getBoundingClientRect();

      for (const line of committedLines) {
        if (line === excludeLine) continue;
        for (const endpoint of getLineEndpoints(line)) {
          const projected = endpoint.clone().project(camera);
          if (projected.z < -1 || projected.z > 1) continue;

          const screenX = rect.left + (projected.x + 1) * 0.5 * rect.width;
          const screenY = rect.top  + (1 - projected.y) * 0.5 * rect.height;
          const dx = screenX - clientX;
          const dy = screenY - clientY;
          const distSq = dx * dx + dy * dy;
          const worldDist = worldPt
            ? endpoint.distanceTo(worldPt)
            : Number.POSITIVE_INFINITY;

          if (distSq <= closestDistSq) {
            closestDistSq = distSq;
            closestWorldDist = worldDist;
            closestPoint = endpoint;
            continue;
          }
          if (worldDist <= closestWorldDist) {
            closestDistSq = distSq;
            closestWorldDist = worldDist;
            closestPoint = endpoint;
          }
        }
      }
      return closestPoint?.clone() ?? null;
    };

    const resolveSnapPoint = (worldPt, clientX, clientY, options = {}) => {
      if (!worldPt) return null;
      const snappedGridPoint = snapPoint(worldPt);
      const endpointPoint = findEndpointSnapTarget(clientX, clientY, snappedGridPoint, options);
      return endpointPoint ?? snappedGridPoint;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // ESTADO DE DESENHO E SELEÇÃO
    // ═══════════════════════════════════════════════════════════════════════════

    const drawPts      = [];
    const previewDots  = [];
    let   previewCurve = null;
    const committedLines = [];
    const surfaceMeshes  = [];

    const previewMat = new THREE.LineBasicMaterial({ color: 0xff8000 });
    const dotGeo     = new THREE.SphereGeometry(0.05, 8, 8);
    const dotMat     = new THREE.MeshBasicMaterial({ color: 0x2266ff });

    let hoveredLine    = null;
    const selectedLines = [];
    let hoveredSurface  = null;
    let selectedSurface = null;

    const isLineSelected   = (line) => selectedLines.includes(line);
    const getEditableLine  = ()     => selectedLines.length === 1 ? selectedLines[0] : null;

    const syncSelectionCount = () => {
      onSelectionCountChangeRef.current?.(selectedLines.length);
    };

    const syncSurfaceSelect = () => {
      const has = !!selectedSurface;
      if (hasSurfaceSelectedRef.current !== has) {
        hasSurfaceSelectedRef.current = has;
        onSurfaceSelectChangeRef.current?.(has);
      }
    };

    const updateLineColor = (line) => {
      if (!line) return;
      if (isLineSelected(line)) {
        line.material.color.setHex(COLOR_SELECTED);
        return;
      }
      line.material.color.setHex(line === hoveredLine ? COLOR_HOVER : COLOR_NORMAL);
    };

    const updateSurfaceVisual = (surface) => {
      if (!surface) return;
      const material = Array.isArray(surface.material)
        ? surface.material[0]
        : surface.material;
      if (!material) return;

      const isSelected = surface === selectedSurface;
      const isHovered  = surface === hoveredSurface;
      material.color.setHex(
        isSelected ? SURFACE_SELECTED_COLOR
          : isHovered ? SURFACE_HOVER_COLOR
          : SURFACE_COLOR,
      );
      material.opacity = isSelected ? 0.9 : 0.7;
      material.emissive?.setHex(
        isSelected ? 0x1d4ed8 : isHovered ? 0x7c2d12 : 0x000000,
      );
      surface.children.forEach((child) => {
        if (!child.material) return;
        const childMat = Array.isArray(child.material)
          ? child.material[0] : child.material;
        childMat.color.setHex(isSelected ? 0xffffff : 0x111827);
        childMat.opacity = isSelected ? 1 : 0.85;
      });
    };

    const removeSurfaceMesh = (mesh) => {
      if (hoveredSurface === mesh) hoveredSurface = null;
      if (selectedSurface === mesh) selectedSurface = null;
      mesh.children.forEach((child) => {
        scene.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else if (child.material) child.material.dispose();
      });
      scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
      if (mesh.userData.femMesh) {
        scene.remove(mesh.userData.femMesh);
        mesh.userData.femMesh.geometry.dispose();
        mesh.userData.femMesh.material.dispose();
        mesh.userData.femMesh = null;
      }
      if (mesh.userData.femWireframe) {
        scene.remove(mesh.userData.femWireframe);
        mesh.userData.femWireframe.geometry.dispose();
        mesh.userData.femWireframe.material.dispose();
        mesh.userData.femWireframe = null;
      }
      if (typeof mesh.userData.occtDispose === "function")
        mesh.userData.occtDispose();
    };

    // ── Handles de edição de curva ────────────────────────────────────────────
    const editHandles    = [];
    let   draggingHandle = null;
    const editHandleGeo  = new THREE.SphereGeometry(0.08, 8, 8);

    const hideEditHandles = () => {
      editHandles.forEach((m) => { scene.remove(m); m.material.dispose(); });
      editHandles.length = 0;
    };

    const showEditHandles = (line) => {
      hideEditHandles();
      line.userData.pts.forEach((pt, i) => {
        const mat  = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const mesh = new THREE.Mesh(editHandleGeo, mat);
        mesh.position.copy(pt);
        mesh.userData = { ptIndex: i, parentLine: line };
        scene.add(mesh);
        editHandles.push(mesh);
      });
    };

    const rebuildLine = (line) => {
      const nurbs = buildNURBS(line.userData.pts, line.userData.tool);
      if (!nurbs) return;
      const newGeo = new THREE.BufferGeometry().setFromPoints(nurbs.getPoints(64));
      line.geometry.dispose();
      line.geometry = newGeo;
      refreshSubdivPoints(line);
    };

    // ── Subdivisão de curvas ──────────────────────────────────────────────────
    const subdivMat = new THREE.PointsMaterial({
      color: 0x00ffaa, size: 6, sizeAttenuation: false,
    });

    const removeSubdivPoints = (line) => {
      if (line.userData.subdivPts) {
        scene.remove(line.userData.subdivPts);
        line.userData.subdivPts.geometry.dispose();
        line.userData.subdivPts = null;
      }
    };

    const refreshSubdivPoints = (line) => {
      removeSubdivPoints(line);
      const { pts, tool, subdivisions, ratio } = line.userData;
      if (!subdivisions || subdivisions < 1) return;
      const nurbs = buildNURBS(pts, tool);
      if (!nurbs) return;
      const ts        = computeSubdivTs(subdivisions, ratio ?? 1.0);
      const positions = ts.map((t) => nurbs.getPoint(t));
      const geo       = new THREE.BufferGeometry().setFromPoints(positions);
      const points    = new THREE.Points(geo, subdivMat.clone());
      scene.add(points);
      line.userData.subdivPts = points;
    };

    const removeLineFull = (l) => {
      removeSubdivPoints(l);
      scene.remove(l);
      l.geometry.dispose();
      l.material.dispose();
    };

    // Expõe subdivisão ao imperativeHandle
    applySubdivRef.current = (n, ratio) => {
      selectedLines.forEach((line) => {
        line.userData.subdivisions = n;
        line.userData.ratio = ratio;
        refreshSubdivPoints(line);
      });
    };
    getSubdivParamsRef.current = () => {
      const line = selectedLines[0];
      if (!line) return null;
      return {
        subdivisions: line.userData.subdivisions ?? 10,
        ratio: line.userData.ratio ?? 1.0,
      };
    };

    const clearSelection = () => {
      selectedLines.forEach((line) => line.material.color.setHex(COLOR_NORMAL));
      selectedLines.length = 0;
      hoveredLine    = null;
      hoveredSurface = null;
      if (selectedSurface) {
        const prev = selectedSurface;
        selectedSurface = null;
        updateSurfaceVisual(prev);
      }
      draggingHandle = null;
      hideEditHandles();
      renderer.domElement.style.cursor = "default";
      syncSelectionCount();
      syncSurfaceSelect();
    };
    clearSelectionRef.current = clearSelection;

    const syncSelectionVisuals = () => {
      committedLines.forEach(updateLineColor);
      surfaceMeshes.forEach(updateSurfaceVisual);
      const editableLine = getEditableLine();
      if (editableLine) showEditHandles(editableLine);
      else hideEditHandles();
      syncSelectionCount();
      syncSurfaceSelect();
    };

    // ── Sistema de desenho ────────────────────────────────────────────────────
    const removePrevCurve = () => {
      if (previewCurve) {
        scene.remove(previewCurve);
        previewCurve.geometry.dispose();
        previewCurve = null;
      }
    };

    const updatePreview = (cursorPt) => {
      removePrevCurve();
      const tool   = activeToolRef.current;
      const allPts = cursorPt ? [...drawPts, cursorPt] : [...drawPts];
      const nurbs  = buildNURBS(allPts, tool);
      if (!nurbs) return;
      const geo = new THREE.BufferGeometry().setFromPoints(nurbs.getPoints(50));
      previewCurve = new THREE.Line(geo, previewMat);
      scene.add(previewCurve);
    };

    const cancelDrawing = () => {
      drawPts.length = 0;
      previewDots.forEach((m) => scene.remove(m));
      previewDots.length = 0;
      removePrevCurve();
    };
    cancelDrawingRef.current = cancelDrawing;

    const commitDrawing = () => {
      const tool = activeToolRef.current;
      if (drawPts.length >= 2) {
        const capturedPts = drawPts.map((p) => p.clone());
        const nurbs       = buildNURBS(drawPts, tool);
        if (nurbs) {
          const geo  = new THREE.BufferGeometry().setFromPoints(nurbs.getPoints(64));
          const mat  = new THREE.LineBasicMaterial({ color: COLOR_NORMAL });
          const line = new THREE.Line(geo, mat);
          line.userData = { pts: capturedPts, tool };
          scene.add(line);
          committedLines.push(line);
        }
        if (onSketchCommitRef.current) {
          const normal = new THREE.Vector3(0, 1, 0)
            .applyQuaternion(pivot.quaternion)
            .normalize();
          onSketchCommitRef.current(capturedPts, {
            origin: pivot.position.clone(),
            normal,
          });
        }
      }
      cancelDrawing();
    };

    // ── Geração de superfície ─────────────────────────────────────────────────
    generateSurfaceRef.current = createGenerateSurface({
      scene,
      selectedLines,
      surfaceMeshes,
      spacingRef,
      buildNURBS,
      getLineEndpoints,
    });

    // ── Malha FEM ─────────────────────────────────────────────────────────────
    meshSurfaceRef.current = createMeshSurface({
      scene,
      getSelectedSurface: () => selectedSurface,
      computeSubdivTs,
    });

    getBoundarySubdivsRef.current = () => {
      const src = selectedSurface?.userData?.sourceCurves;
      if (!src || src.type !== 'loop' || src.curves.length < 3) return null;
      const c0 = src.curves[0], c1 = src.curves[1];
      return {
        u:      c0.line?.userData?.subdivisions ?? c0.subdivisions ?? 10,
        v:      c1.line?.userData?.subdivisions ?? c1.subdivisions ?? 10,
        ratioU: c0.line?.userData?.ratio        ?? c0.ratio        ?? 1.0,
        ratioV: c1.line?.userData?.ratio        ?? c1.ratio        ?? 1.0,
      };
    };

    // ── Exportação / Importação ───────────────────────────────────────────────
    const { exportModel, importModel } = createModelIO({
      scene,
      committedLines,
      surfaceMeshes,
      buildNURBS,
      refreshSubdivPoints,
      clearSelection,
      removeLineFull,
      removeSurfaceMesh,
      syncSelectionCount,
      syncSurfaceSelect,
    });
    exportModelRef.current = exportModel;
    importModelRef.current = importModel;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTOS DE PONTEIRO E TECLADO
    // ═══════════════════════════════════════════════════════════════════════════

    let frameId;

    const onPointerMove = (e) => {
      // Arrastar handle de edição
      if (draggingHandle) {
        const pt = getPlanePoint(e.clientX, e.clientY);
        if (pt) {
          const { ptIndex, parentLine } = draggingHandle.userData;
          const nextPoint = isEndpointHandle(parentLine, ptIndex)
            ? resolveSnapPoint(pt, e.clientX, e.clientY, {
                excludeLine: parentLine,
                pixelTolerance: 18,
                worldTolerance: Math.max(0.2, spacingRef.current * 0.5),
              })
            : pt;
          parentLine.userData.pts[ptIndex].copy(nextPoint);
          draggingHandle.position.copy(nextPoint);
          rebuildLine(parentLine);
        }
        return;
      }

      // Redimensionamento do grid
      if (isResizingRef.current) {
        const worldPt = getPlanePoint(e.clientX, e.clientY);
        if (worldPt) {
          const local   = pivot.worldToLocal(worldPt.clone());
          const newHalf = Math.max(0.5, Math.max(Math.abs(local.x), Math.abs(local.z)));
          rebuildGrid(newHalf, spacingRef.current);
        }
        return;
      }

      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        const raw = getPlanePoint(e.clientX, e.clientY);
        const p   = resolveSnapPoint(
          raw, e.clientX, e.clientY,
          drawPts.length === 0
            ? {
                pixelTolerance: ENDPOINT_FIRST_POINT_SNAP_PX,
                worldTolerance: Math.max(0.3, spacingRef.current * 0.8),
              }
            : undefined,
        );
        onCoordsChange(
          p
            ? `X: ${p.x.toFixed(2)}, Y: ${p.y.toFixed(2)}, Z: ${p.z.toFixed(2)}`
            : "X: –, Y: –, Z: –",
        );
        const tool = activeToolRef.current;
        if (tool !== "select" && drawPts.length > 0 && p) {
          updatePreview(p);
        }

        if (tool === "select") {
          const ndc = getNDC(e.clientX, e.clientY);

          if (editHandles.length > 0) {
            const handleRay = new THREE.Raycaster();
            handleRay.setFromCamera(ndc, camera);
            if (handleRay.intersectObjects(editHandles).length > 0) {
              renderer.domElement.style.cursor = "grab";
              if (hoveredLine && !isLineSelected(hoveredLine)) {
                hoveredLine.material.color.setHex(COLOR_NORMAL);
                hoveredLine = null;
              }
              return;
            }
          }

          if (committedLines.length > 0) {
            const hoverRay = new THREE.Raycaster();
            hoverRay.params.Line = { threshold: 0.1 };
            hoverRay.setFromCamera(ndc, camera);
            const hits = hoverRay.intersectObjects(committedLines);
            if (hoveredLine && !isLineSelected(hoveredLine)) {
              hoveredLine.material.color.setHex(COLOR_NORMAL);
            }
            hoveredLine = hits.length > 0 ? hits[0].object : null;
            if (hoveredLine && !isLineSelected(hoveredLine)) {
              hoveredLine.material.color.setHex(COLOR_HOVER);
            }
          }

          if (hoveredSurface && hoveredSurface !== selectedSurface) {
            updateSurfaceVisual(hoveredSurface);
          }

          if (!hoveredLine && surfaceMeshes.length > 0) {
            const surfaceRay = new THREE.Raycaster();
            surfaceRay.setFromCamera(ndc, camera);
            const surfaceHits = surfaceRay.intersectObjects(surfaceMeshes, false);
            hoveredSurface = surfaceHits.length > 0 ? surfaceHits[0].object : null;
            if (hoveredSurface && hoveredSurface !== selectedSurface) {
              updateSurfaceVisual(hoveredSurface);
            }
          } else {
            hoveredSurface = null;
          }

          renderer.domElement.style.cursor =
            hoveredLine || hoveredSurface ? "pointer" : "default";
        } else {
          renderer.domElement.style.cursor = "crosshair";
        }
      });
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      if (e.target !== renderer.domElement) return;

      const ndc = getNDC(e.clientX, e.clientY);

      if (activeToolRef.current === "select" && editHandles.length > 0) {
        const handleRay = new THREE.Raycaster();
        handleRay.setFromCamera(ndc, camera);
        const handleHits = handleRay.intersectObjects(editHandles);
        if (handleHits.length > 0) {
          draggingHandle = handleHits[0].object;
          orbitControls.enabled = false;
          renderer.domElement.style.cursor = "grabbing";
          return;
        }
      }

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(cornerHandlesRef.current);
      if (hits.length > 0) {
        isResizingRef.current = true;
        orbitControls.enabled = false;
        translateControls.enabled = false;
        rotateControls.enabled = false;
        return;
      }

      const tool = activeToolRef.current;

      if (tool === "select" || !tool) {
        if (tool === "select" && committedLines.length > 0) {
          const pickRay = new THREE.Raycaster();
          pickRay.params.Line = { threshold: 0.1 };
          pickRay.setFromCamera(getNDC(e.clientX, e.clientY), camera);
          const lineHits = pickRay.intersectObjects(committedLines);

          if (lineHits.length > 0) {
            if (selectedSurface) {
              const prev = selectedSurface;
              selectedSurface = null;
              updateSurfaceVisual(prev);
            }
            const line          = lineHits[0].object;
            const selectedIndex = selectedLines.indexOf(line);
            if (selectedIndex >= 0) selectedLines.splice(selectedIndex, 1);
            else selectedLines.push(line);
            syncSelectionVisuals();
            return;
          }

          if (surfaceMeshes.length > 0) {
            const surfaceRay = new THREE.Raycaster();
            surfaceRay.setFromCamera(getNDC(e.clientX, e.clientY), camera);
            const surfaceHits = surfaceRay.intersectObjects(surfaceMeshes, false);

            if (surfaceHits.length > 0) {
              selectedLines.length = 0;
              hoveredLine = null;
              const nextSurface = surfaceHits[0].object;
              if (selectedSurface === nextSurface) {
                const prev = selectedSurface;
                selectedSurface = null;
                updateSurfaceVisual(prev);
              } else {
                if (selectedSurface) updateSurfaceVisual(selectedSurface);
                selectedSurface = nextSurface;
                updateSurfaceVisual(selectedSurface);
              }
              hideEditHandles();
              syncSelectionVisuals();
              return;
            }
          }

          clearSelection();
        }
        return;
      }

      const p = resolveSnapPoint(
        getPlanePoint(e.clientX, e.clientY),
        e.clientX, e.clientY,
        drawPts.length === 0
          ? {
              pixelTolerance: ENDPOINT_FIRST_POINT_SNAP_PX,
              worldTolerance: Math.max(0.3, spacingRef.current * 0.8),
            }
          : undefined,
      );
      if (!p) return;

      drawPts.push(p.clone());
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      scene.add(dot);
      previewDots.push(dot);

      if (tool === "line" && drawPts.length === 2) commitDrawing();
      if (tool === "arc"  && drawPts.length === 3) commitDrawing();
    };

    const onPointerUp = () => {
      if (draggingHandle) {
        draggingHandle = null;
        orbitControls.enabled = true;
        renderer.domElement.style.cursor = "grab";
        return;
      }
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      orbitControls.enabled = true;
      const isDrawing = activeToolRef.current !== "select";
      if (!isDrawing) {
        translateControls.enabled = true;
        rotateControls.enabled = true;
      }
    };

    const onDblClick = () => {
      const tool = activeToolRef.current;
      if (tool === "polyline" || tool === "spline") {
        if (drawPts.length > 0) {
          drawPts.pop();
          const dot = previewDots.pop();
          if (dot) scene.remove(dot);
        }
        if (drawPts.length >= 2) commitDrawing();
        else cancelDrawing();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Enter") {
        const tool = activeToolRef.current;
        if (tool === "polyline" || tool === "spline") {
          if (drawPts.length >= 2) commitDrawing();
        }
        return;
      }
      if (e.key === "Escape") {
        cancelDrawing();
        clearSelection();
        activeToolRef.current = "select";
        const tc = transformControlsRef.current;
        if (tc) { tc.translate.enabled = true; tc.rotate.enabled = true; }
        onToolChangeRef.current?.("select");
        return;
      }
      if (e.key === "Delete") {
        if (selectedLines.length > 0) {
          selectedLines.forEach((l) => {
            removeLineFull(l);
            const idx = committedLines.indexOf(l);
            if (idx !== -1) committedLines.splice(idx, 1);
          });
          selectedLines.length = 0;
          hideEditHandles();
          syncSelectionCount();
        }
        if (selectedSurface) {
          const mesh = selectedSurface;
          selectedSurface = null;
          const idx = surfaceMeshes.indexOf(mesh);
          if (idx !== -1) surfaceMeshes.splice(idx, 1);
          removeSurfaceMesh(mesh);
          syncSelectionCount();
        }
        return;
      }
      if (e.key.toLowerCase() === "c") {
        clearSelection();
        committedLines.forEach((l) => removeLineFull(l));
        committedLines.length = 0;
        surfaceMeshes.forEach(removeSurfaceMesh);
        surfaceMeshes.length = 0;
        cancelDrawing();
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup",   onPointerUp);
    window.addEventListener("dblclick",    onDblClick);
    window.addEventListener("keydown",     onKeyDown);

    window.addEventListener("resize", () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    });

    // ── Loop de animação ─────────────────────────────────────────────────────
    const animate = () => {
      orbitControls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    // ── Cleanup ao desmontar ─────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup",   onPointerUp);
      window.removeEventListener("dblclick",    onDblClick);
      window.removeEventListener("keydown",     onKeyDown);

      cameraRef.current = null;
      orbitControlsRef.current = null;

      bgTexture.dispose();
      editHandleGeo.dispose();
      translateControls.dispose();
      rotateControls.dispose();
      orbitControls.dispose();
      renderer.dispose();

      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          Array.isArray(o.material)
            ? o.material.forEach((m) => m.dispose())
            : o.material.dispose();
        }
      });

      container.removeChild(renderer.domElement);
      container.removeChild(labelRenderer.domElement);
    };
  }, [onCoordsChange, onCenterChange]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
});

export default ThreeCanvas;
