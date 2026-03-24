/**
 * canvas/meshSurface.js
 *
 * Fábrica para a função meshSurface (geração de malha FEM estruturada).
 */

import * as THREE from "three";
import { meshModule } from "../../mesh/MeshModule.js";
import { femWireframeGeometry } from "./femUtils.js";

/**
 * Cria a função meshSurface injetando dependências.
 *
 * @param {{
 *   scene: THREE.Scene,
 *   getSelectedSurface: () => THREE.Mesh | null,
 *   computeSubdivTs: function,
 * }} deps
 * @returns {(algo: string, params: object) => Promise<{ok, n_nodes, n_elements} | {error}>}
 */
export function createMeshSurface({ scene, getSelectedSurface, computeSubdivTs }) {
  return async function meshSurface(algo, params) {
    const selectedSurface = getSelectedSurface();
    if (!selectedSurface) return { error: 'Nenhuma superfície selecionada.' };

    const src = selectedSurface.userData.sourceCurves;
    if (!src) return { error: 'Superfície não tem dados de curva (regere a superfície).' };
    if (src.type !== 'loop' || src.curves.length < 3) {
      return { error: 'Este algoritmo requer um loop fechado de 3 ou 4 curvas.' };
    }

    const N = src.curves.length;
    const { elem_type } = params;

    // Lê subdivisões e ratio ao vivo do userData das curvas originais
    const live = src.curves.map((c) => ({
      subdivisions: c.line?.userData?.subdivisions ?? c.subdivisions ?? 10,
      ratio:        c.line?.userData?.ratio        ?? c.ratio        ?? 1.0,
    }));

    let result;

    if (algo === 'template') {
      const subdivision = live.map(l => l.subdivisions);
      const boundary = [];
      src.curves.forEach((c, k) => {
        const d = subdivision[k];
        const ts = computeSubdivTs(d, live[k].ratio);
        if (c.reversed) {
          for (let i = d; i >= 1; i--) { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        } else {
          for (let i = 0; i < d; i++)  { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        }
      });
      console.log(`[FEMMesh] template n_sides=${N} subdivision:`, subdivision,
        '| boundary pts:', boundary.length / 3);
      try {
        result = await meshModule.mshsurf.template({ n_sides: N, subdivision, boundary });
      } catch (e) {
        console.error('[FEMMesh] template WASM falhou:', e);
        return { error: e.message };
      }
    } else if (N === 3) {
      const m = live[0].subdivisions + 1;
      const n = live[1].subdivisions + 1;
      const sideSegs = (algo === 'trilinear')
        ? [m - 1, m - 1, m - 1]
        : [m - 1, n - 1, m - 1];

      const boundary = [];
      src.curves.forEach((c, k) => {
        const d = sideSegs[k];
        const ts = computeSubdivTs(d, live[k].ratio);
        if (c.reversed) {
          for (let i = d; i >= 1; i--) { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        } else {
          for (let i = 0; i < d; i++)  { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        }
      });
      const effectiveAlgo = algo === 'bilinear' ? 'collbilinear' : algo;
      console.log(`[FEMMesh] ${effectiveAlgo} (3 curvas) m=${m} n=${n} elem_type=${elem_type}`
        + ` | boundary pts:`, boundary.length / 3,
        '| ratios:', live.map(l => l.ratio.toFixed(2)));
      try {
        if (effectiveAlgo === 'trilinear') {
          result = await meshModule.mshsurf.trilinear({ boundary, m, elem_type });
        } else {
          result = await meshModule.mshsurf[effectiveAlgo]({ boundary, m, n, elem_type });
        }
      } catch (e) {
        console.error(`[FEMMesh] ${effectiveAlgo} WASM falhou:`, e);
        return { error: e.message };
      }
    } else {
      const m = live[0].subdivisions + 1;
      const n = live[1].subdivisions + 1;
      const sideSegs = [m - 1, n - 1, m - 1, n - 1];

      const boundary = [];
      src.curves.forEach((c, k) => {
        const d = sideSegs[k];
        const ts = computeSubdivTs(d, live[k].ratio);
        if (c.reversed) {
          for (let i = d; i >= 1; i--) { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        } else {
          for (let i = 0; i < d; i++)  { const p = c.nurbs.getPoint(ts[i]); boundary.push(p.x, p.y, p.z); }
        }
      });
      console.log(`[FEMMesh] ${algo} m=${m} n=${n} elem_type=${elem_type}`
        + ` | boundary pts:`, boundary.length / 3,
        '| ratios:', live.map(l => l.ratio.toFixed(2)));
      try {
        if (algo === 'trilinear') {
          result = await meshModule.mshsurf.trilinear({ boundary, m, elem_type });
        } else {
          result = await meshModule.mshsurf[algo]({ boundary, m, n, elem_type });
        }
      } catch (e) {
        console.error(`[FEMMesh] ${algo} WASM falhou:`, e);
        return { error: e.message };
      }
    }

    console.log('[FEMMesh] resultado WASM:'
      + ` n_nodes=${result.n_nodes}`
      + ` n_elements=${result.n_elements}`
      + ` elem_size=${result.elem_size}`);
    console.log('[FEMMesh] positions[0..2]:', Array.from(result.positions.slice(0, 9)).map(v => v.toFixed(3)));
    console.log('[FEMMesh] index[0..11]:', Array.from(result.index.slice(0, 12)));

    // Remove malha FEM anterior
    if (selectedSurface.userData.femMesh) {
      scene.remove(selectedSurface.userData.femMesh);
      selectedSurface.userData.femMesh.geometry.dispose();
      selectedSurface.userData.femMesh.material.dispose();
    }
    if (selectedSurface.userData.femWireframe) {
      scene.remove(selectedSurface.userData.femWireframe);
      selectedSurface.userData.femWireframe.geometry.dispose();
      selectedSurface.userData.femWireframe.material.dispose();
    }

    // Cria o wireframe da malha FEM
    const wireGeo = femWireframeGeometry(result);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x4ade80 });
    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
    scene.add(wireframe);

    selectedSurface.userData.femMesh = null;
    selectedSurface.userData.femWireframe = wireframe;

    console.info(`[FEMMesh] ${algo} → ${result.n_nodes} nós, ${result.n_elements} elementos (elem_size=${result.elem_size})`);
    return { ok: true, n_nodes: result.n_nodes, n_elements: result.n_elements };
  };
}
