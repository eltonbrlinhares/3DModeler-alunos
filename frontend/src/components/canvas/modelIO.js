/**
 * canvas/modelIO.js
 *
 * Fábrica para exportModel e importModel.
 * Serializa/restaura curvas e superfícies para um objeto JSON.
 */

import * as THREE from "three";

const SURFACE_COLOR = 0x7dd3fc;
const COLOR_NORMAL  = 0xff2222;

/**
 * Cria as funções exportModel e importModel injetando dependências.
 *
 * @param {{
 *   scene: THREE.Scene,
 *   committedLines: THREE.Line[],
 *   surfaceMeshes: THREE.Mesh[],
 *   buildNURBS: function,
 *   refreshSubdivPoints: function,
 *   clearSelection: function,
 *   removeLineFull: function,
 *   removeSurfaceMesh: function,
 *   syncSelectionCount: function,
 *   syncSurfaceSelect: function,
 * }} deps
 * @returns {{ exportModel: function, importModel: function }}
 */
export function createModelIO({
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
}) {
  function exportModel() {
    const curves = committedLines.map((line, i) => ({
      id: i,
      tool: line.userData.tool,
      pts: line.userData.pts.map((p) => [p.x, p.y, p.z]),
      subdivisions: line.userData.subdivisions ?? null,
      ratio: line.userData.ratio ?? null,
    }));

    const surfaces = surfaceMeshes.map((mesh, i) => {
      const posAttr = mesh.geometry.getAttribute('position');
      const positions = Array.from(posAttr.array);
      const idxAttr = mesh.geometry.index;
      const index = idxAttr ? Array.from(idxAttr.array) : null;

      const src = mesh.userData.sourceCurves;
      let sourceCurveIds = null;
      let sourceCurvesReversed = null;
      if (src?.curves) {
        const ids = src.curves.map((c) => committedLines.indexOf(c.line ?? null));
        if (ids.every((id) => id !== -1)) {
          sourceCurveIds = ids;
          sourceCurvesReversed = src.curves.map((c) => c.reversed ?? false);
        }
      }

      let femMesh = null;
      if (mesh.userData.femMesh) {
        const fg = mesh.userData.femMesh.geometry;
        femMesh = {
          positions: Array.from(fg.getAttribute('position').array),
          index: fg.index ? Array.from(fg.index.array) : null,
        };
      }

      return {
        id: i,
        positions,
        index,
        sourceCurvesType: src?.type ?? null,
        sourceCurveIds,
        sourceCurvesReversed,
        femMesh,
      };
    });

    return { version: 1, curves, surfaces };
  }

  function importModel(data) {
    if (!data || data.version !== 1) return false;

    clearSelection();
    committedLines.forEach((l) => removeLineFull(l));
    committedLines.length = 0;
    surfaceMeshes.forEach(removeSurfaceMesh);
    surfaceMeshes.length = 0;

    // Importa curvas
    const importedLines = [];
    for (const cd of (data.curves ?? [])) {
      const pts = cd.pts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const nurbs = buildNURBS(pts, cd.tool);
      if (!nurbs) { importedLines.push(null); continue; }
      const geo = new THREE.BufferGeometry().setFromPoints(nurbs.getPoints(64));
      const mat = new THREE.LineBasicMaterial({ color: COLOR_NORMAL });
      const line = new THREE.Line(geo, mat);
      line.userData = {
        pts,
        tool: cd.tool,
        ...(cd.subdivisions != null && { subdivisions: cd.subdivisions }),
        ...(cd.ratio != null && { ratio: cd.ratio }),
      };
      scene.add(line);
      committedLines.push(line);
      importedLines.push(line);
      if (line.userData.subdivisions) refreshSubdivPoints(line);
    }

    // Importa superfícies
    for (const sd of (data.surfaces ?? [])) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sd.positions), 3));
      if (sd.index) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(sd.index), 1));
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: SURFACE_COLOR,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
        roughness: 0.45,
        metalness: 0.08,
      }));

      // Reconstrói sourceCurves para permitir geração de malha FEM
      if (sd.sourceCurveIds && (sd.sourceCurvesType === 'loop' || sd.sourceCurvesType === 'planar')) {
        const curvesArr = sd.sourceCurveIds.map((id, i) => {
          const srcLine = importedLines[id];
          if (!srcLine) return null;
          const nurbs = buildNURBS(srcLine.userData.pts, srcLine.userData.tool);
          if (!nurbs) return null;
          return {
            nurbs,
            reversed: sd.sourceCurvesReversed?.[i] ?? false,
            subdivisions: srcLine.userData.subdivisions ?? 10,
            ratio: srcLine.userData.ratio ?? 1.0,
            line: srcLine,
          };
        });
        if (curvesArr.every(Boolean)) {
          mesh.userData.sourceCurves = { type: sd.sourceCurvesType, curves: curvesArr };
        }
      }

      // Restaura malha FEM
      if (sd.femMesh) {
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sd.femMesh.positions), 3));
        if (sd.femMesh.index) fg.setIndex(new THREE.BufferAttribute(new Uint32Array(sd.femMesh.index), 1));
        fg.computeVertexNormals();
        const femMeshObj = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({
          color: 0x22c55e, side: THREE.DoubleSide, transparent: true, opacity: 0.2, depthWrite: false,
        }));
        scene.add(femMeshObj);
        mesh.userData.femMesh = femMeshObj;

        const wireGeo = new THREE.WireframeGeometry(fg);
        const wireframe = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x4ade80 }));
        scene.add(wireframe);
        mesh.userData.femWireframe = wireframe;
      }

      scene.add(mesh);
      surfaceMeshes.push(mesh);
    }

    syncSelectionCount();
    syncSurfaceSelect();
    return true;
  }

  return { exportModel, importModel };
}
