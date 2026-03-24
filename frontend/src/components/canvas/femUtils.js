/**
 * canvas/femUtils.js
 *
 * Utilitários para geração de geometria de wireframe de malha FEM.
 */

import * as THREE from "three";

/**
 * Cria geometria de arestas da malha FEM sem duplicar arestas internas.
 * Suporta elementos triangulares (elem_size=3) e quadrilaterais (elem_size=4).
 *
 * @param {{ positions: Float32Array, index: Int32Array, n_elements: number, elem_size: number }} result
 * @returns {THREE.BufferGeometry}
 */
export function femWireframeGeometry(result) {
  const { positions, index, n_elements, elem_size } = result;
  const edgeSet = new Set();
  const addEdge = (a, b) => edgeSet.add(a < b ? `${a},${b}` : `${b},${a}`);

  if (elem_size === 4) {
    for (let i = 0; i < n_elements; i++) {
      const a = index[i * 4], b = index[i * 4 + 1],
            c = index[i * 4 + 2], d = index[i * 4 + 3];
      addEdge(a, b); addEdge(b, c); addEdge(c, d); addEdge(d, a);
    }
  } else {
    for (let i = 0; i < n_elements; i++) {
      const a = index[i * elem_size], b = index[i * elem_size + 1],
            c = index[i * elem_size + 2];
      addEdge(a, b); addEdge(b, c); addEdge(c, a);
    }
  }

  const pts = [];
  for (const key of edgeSet) {
    const [a, b] = key.split(',').map(Number);
    pts.push(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
    pts.push(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  return geo;
}
