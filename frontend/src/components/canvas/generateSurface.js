/**
 * canvas/generateSurface.js
 *
 * Fábrica para a função generateSurfaceFromSelection.
 * Recebe as dependências como parâmetros para evitar acoplamento de módulo.
 */

import * as THREE from "three";
import { loftSections, fillBoundary, fillPlanar } from "../../occt/SurfaceEditor.js";
import {
  orderSurfaceSections,
  orientSurfaceSections,
  fallbackOrderSurfaceSections,
  orderClosedBoundary,
} from "./surfaceOrderUtils.js";

// Constante de cor da superfície (deve coincidir com ThreeCanvas.jsx)
const SURFACE_COLOR = 0x7dd3fc;

/**
 * Cria a função generateSurfaceFromSelection injetando suas dependências.
 *
 * @param {{
 *   scene: THREE.Scene,
 *   selectedLines: THREE.Line[],
 *   surfaceMeshes: THREE.Mesh[],
 *   spacingRef: React.MutableRefObject<number>,
 *   buildNURBS: function,
 *   getLineEndpoints: function,
 * }} deps
 * @returns {() => Promise<boolean>}
 */
export function createGenerateSurface({
  scene,
  selectedLines,
  surfaceMeshes,
  spacingRef,
  buildNURBS,
  getLineEndpoints,
}) {
  return async function generateSurfaceFromSelection() {
    if (selectedLines.length < 2) {
      console.warn("[Surface] Selecione pelo menos 2 curvas.");
      return false;
    }

    const sampleCount = 50;
    const sections = selectedLines.map((line) => {
      const nurbs = buildNURBS(line.userData.pts, line.userData.tool);
      const samples = nurbs?.getPoints(sampleCount) ?? null;
      return samples && nurbs ? { line, samples, nurbs } : null;
    });

    if (sections.some((section) => !section || section.samples.length < 2)) {
      console.warn("[Surface] Uma ou mais curvas não puderam ser amostradas.");
      return false;
    }

    const spacing = spacingRef.current;
    const loopTolerance = Math.max(0.25, spacing * 0.8);

    // Tenta ordenar como loop fechado
    let closedLoop = null;
    if (sections.length >= 2) {
      closedLoop = orderClosedBoundary(sections, loopTolerance);
    }

    let result;
    let sourceCurvesInfo = null;

    if (closedLoop) {
      const N = closedLoop.length;
      const loopNurbs = closedLoop.map((s) => s.nurbs);
      const loopReversed = closedLoop.map((s) => {
        const nurbsPts = s.nurbs.getPoints(2);
        const nurbsStart = nurbsPts[0];
        const desiredStart = s.samples[0];
        const desiredEnd = s.samples[s.samples.length - 1];
        return nurbsStart.distanceTo(desiredStart) > nurbsStart.distanceTo(desiredEnd);
      });

      if (N >= 3 && N <= 4) {
        // Coons patch (3–4 curvas)
        console.info("[Surface] Loop fechado de %d curvas — Coons patch.", N);
        result = await fillBoundary(loopNurbs, {
          quality: 0.05,
          reversed: loopReversed,
        });
        sourceCurvesInfo = {
          type: 'loop',
          curves: closedLoop.map((s) => ({
            nurbs: s.nurbs,
            reversed: s.reversed || false,
            subdivisions: s.line?.userData?.subdivisions ?? 10,
            ratio: s.line?.userData?.ratio ?? 1.0,
            line: s.line,
          })),
        };
      } else {
        // Superfície plana triangulada (2 curvas ou 5+ curvas)
        console.info("[Surface] Loop fechado de %d curvas — superfície plana.", N);
        result = await fillPlanar(loopNurbs, {
          reversed: loopReversed,
          resolution: 32,
        });
        sourceCurvesInfo = {
          type: 'planar',
          curves: closedLoop.map((s) => ({
            nurbs: s.nurbs,
            reversed: s.reversed || false,
            subdivisions: s.line?.userData?.subdivisions ?? 10,
            ratio: s.line?.userData?.ratio ?? 1.0,
            line: s.line,
          })),
        };
      }
    } else {
      // Cadeia aberta → loft entre seções transversais
      let orderedSections = orderSurfaceSections(sections, spacing);
      if (!orderedSections) {
        console.warn("[Surface] Tentando ordenação por proximidade.");
        orderedSections = fallbackOrderSurfaceSections(sections);
      }
      if (!orderedSections) {
        console.warn("[Surface] Falha ao ordenar as curvas selecionadas.", {
          curveCount: sections.length,
          endpoints: sections.map((section) => {
            const endpoints = getLineEndpoints(section.line);
            return endpoints.map((pt) => [pt.x, pt.y, pt.z]);
          }),
        });
        return false;
      }
      const orientedSections = orientSurfaceSections(orderedSections);
      const nurbsCurves = orientedSections.map((section) => section.nurbs);
      const revFlags = orientedSections.map((section) => section.reversed || false);
      result = await loftSections(nurbsCurves, {
        quality: 0.05,
        reversed: revFlags,
      });
      sourceCurvesInfo = {
        type: 'loft',
        curves: orientedSections.map((s) => ({
          nurbs: s.nurbs,
          reversed: s.reversed || false,
          subdivisions: s.line?.userData?.subdivisions ?? 10,
          ratio: s.line?.userData?.ratio ?? 1.0,
        })),
      };
      console.info("[Surface] Usando loft entre seções.");
    }

    if (!result) {
      console.warn("[Surface] Geração de superfície falhou.");
      return false;
    }

    const positionAttr = result.geometry.getAttribute("position");
    const surfaceBox = new THREE.Box3().setFromBufferAttribute(positionAttr);
    const triangleCount = Math.floor(positionAttr.count / 3);

    const mesh = new THREE.Mesh(
      result.geometry,
      new THREE.MeshStandardMaterial({
        color: SURFACE_COLOR,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
        roughness: 0.45,
        metalness: 0.08,
      }),
    );
    mesh.userData.occtDispose = result.dispose;
    mesh.userData.sourceCurves = sourceCurvesInfo;
    mesh.userData.surfaceDebug = {
      curveCount: selectedLines.length,
      isClosed: !!closedLoop,
      vertexCount: positionAttr.count,
      triangleCount,
      bounds: {
        min: surfaceBox.min.toArray(),
        max: surfaceBox.max.toArray(),
      },
    };
    scene.add(mesh);
    surfaceMeshes.push(mesh);
    console.info("[Surface] Debug da geometria gerada.", mesh.userData.surfaceDebug);
    return true;
  };
}
