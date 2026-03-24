/**
 * useMesh.js
 *
 * Hook React para geração de malhas via WebAssembly (mesh.wasm).
 *
 * Uso básico:
 *   import { useMesh } from '../mesh/useMesh.js';
 *   import * as THREE from 'three';
 *
 *   function MyComponent() {
 *     const { generateMesh, loading, error } = useMesh();
 *
 *     async function handleGenerate() {
 *       const result = await generateMesh('msh2d.bilinear', {
 *         boundary: [0,0, 1,0, 1,0, 1,1, 1,1, 0,1, 0,1, 0,0],
 *         m: 10, n: 10,
 *       });
 *       // result.positions → Float64Array [x,y,z por nó]
 *       // result.index     → Int32Array  [índices 0-based]
 *       // Converter para Three.js:
 *       const geo = meshResultToGeometry(result, THREE);
 *     }
 *   }
 *
 * Tipos de malha disponíveis:
 *   'msh2d.bilinear'       — mapeamento bilinear (Q4/T3/Q8/T6)
 *   'msh2d.collbilinear'   — bilinear colapsado (triangular)
 *   'msh2d.loft'           — lofting linear
 *   'msh2d.trilinear'      — trilinear (triangular equilateral)
 *   'msh2d.contraction'    — contração de fronteira (não-estruturada)
 *   'msh2d.quadbound'      — quadtree não-estruturada
 *   'msh2d.shape'          — advancing-front + quadtree
 *   'msh2d.seam'           — Q-Morph quadrilateral indireta
 *   'msh2d.template'       — template estruturada 2/3/4 lados
 *   'msh3d.extrusion'      — extrusão de malha 2D
 *   'msh3d.sweeping'       — sweeping source→target
 *   'msh3d.mapp'           — mapeamento transfinito entre superfícies
 *   'msh3d.curvesweep'     — sweep ao longo de curva 3D
 *   'msh3d.template'       — template hexaédrica
 *   'mshsurf.bilinear'     — bilinear de superfície 3D
 *   'mshsurf.collbilinear' — bilinear colapsado 3D
 *   'mshsurf.loft'         — lofting de superfície 3D
 *   'mshsurf.trilinear'    — trilinear de superfície 3D
 *   'mshsurf.template'     — template de superfície 3D
 *   'mshsurf.edge2d'       — advancing-front 2D com suavização 3D
 *   'mshsurf.edge'         — advancing-front 3D com malha de suporte
 */

import { useState, useCallback, useRef } from 'react';
import { meshModule, meshResultToGeometry } from './MeshModule.js';

/**
 * @typedef {{ positions: Float64Array, index: Int32Array,
 *             n_nodes: number, n_elements: number, elem_size: number }} MeshResult
 */

/**
 * Hook para geração de malhas via WASM.
 *
 * @returns {{
 *   generateMesh: (type: string, params: object) => Promise<MeshResult>,
 *   lastResult: MeshResult | null,
 *   loading: boolean,
 *   error: string | null,
 *   clearError: () => void,
 * }}
 */
export function useMesh() {
  const [lastResult, setLastResult] = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);

  // Cancelação: permite ignorar resultados de chamadas antigas se uma nova
  // for disparada antes da anterior completar.
  const callIdRef = useRef(0);

  /**
   * Gera uma malha assincronamente via WASM.
   *
   * @param {string} type  — ex.: 'msh2d.bilinear', 'msh3d.extrusion'
   * @param {object} params — parâmetros específicos do algoritmo
   * @returns {Promise<MeshResult>}
   */
  const generateMesh = useCallback(async (type, params) => {
    const callId = ++callIdRef.current;
    setLoading(true);
    setError(null);

    try {
      // Resolver lib e algoritmo a partir de 'lib.algo'
      const dotIdx = type.indexOf('.');
      if (dotIdx === -1) {
        throw new Error(`Tipo inválido: "${type}". Use o formato "lib.algoritmo".`);
      }
      const lib  = type.slice(0, dotIdx);
      const algo = type.slice(dotIdx + 1);

      if (!meshModule[lib]) {
        throw new Error(`Biblioteca desconhecida: "${lib}". Opções: msh2d, msh3d, mshsurf.`);
      }
      if (typeof meshModule[lib][algo] !== 'function') {
        throw new Error(`Algoritmo desconhecido: "${lib}.${algo}".`);
      }

      const result = await meshModule[lib][algo](params);

      // Ignorar resultado se uma chamada mais nova foi iniciada
      if (callId === callIdRef.current) {
        setLastResult(result);
      }

      return result;

    } catch (err) {
      if (callId === callIdRef.current) {
        const msg = err?.message ?? String(err);
        setError(msg);
        console.error('[useMesh]', msg);
      }
      throw err;
    } finally {
      if (callId === callIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { generateMesh, lastResult, loading, error, clearError };
}

/**
 * Converte um MeshResult em THREE.BufferGeometry.
 * Re-exportado aqui por conveniência para que os componentes só precisem
 * importar de um único lugar.
 *
 * @param {MeshResult} result
 * @param {object} THREE
 * @returns {THREE.BufferGeometry}
 */
export { meshResultToGeometry };
