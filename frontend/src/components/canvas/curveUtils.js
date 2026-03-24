/**
 * canvas/curveUtils.js
 *
 * Utilitários puros para construção de curvas NURBS e subdivisão paramétrica.
 * Nenhuma dependência de estado React ou Three.js mutável.
 */

import {
  makeLine,
  makePolyline,
  makeArcFromCenterStartEnd,
  makeSpline,
} from "../../curves/NURBSBuilders.js";

/**
 * Constrói a curva NURBS correspondente à ferramenta ativa.
 * Retorna null se não houver pontos suficientes.
 *
 * @param {THREE.Vector3[]} pts
 * @param {string} tool - "line" | "polyline" | "arc" | "spline"
 * @returns {NURBSCurve | null}
 */
export function buildNURBS(pts, tool) {
  if (pts.length < 2) return null;
  if (tool === "line") return makeLine(pts[0], pts[pts.length - 1]);
  if (tool === "polyline") return makePolyline(pts);
  if (tool === "arc") {
    if (pts.length < 2) return null;
    if (pts.length === 2) return makeLine(pts[0], pts[1]);
    return makeArcFromCenterStartEnd(pts[0], pts[1], pts[2]);
  }
  if (tool === "spline") return makeSpline(pts);
  return null;
}

/**
 * Calcula os valores t ∈ [0,1] para n segmentos com razão geométrica.
 *   ratio = 1.0  → espaçamento uniforme
 *   ratio > 1.0  → segmentos crescem
 *   ratio < 1.0  → segmentos diminuem
 *
 * @param {number} n
 * @param {number} ratio
 * @returns {number[]}
 */
export function computeSubdivTs(n, ratio) {
  const ts = [0];
  if (n <= 1) { ts.push(1); return ts; }
  if (Math.abs(ratio - 1.0) < 1e-6) {
    for (let i = 1; i < n; i++) ts.push(i / n);
  } else {
    const q = Math.pow(ratio, 1 / (n - 1));
    const sum = Math.abs(q - 1) < 1e-10 ? n : (Math.pow(q, n) - 1) / (q - 1);
    const d = 1 / sum;
    let t = 0;
    let interval = d;
    for (let i = 1; i < n; i++) {
      t += interval;
      ts.push(Math.min(1, Math.max(0, t)));
      interval *= q;
    }
  }
  ts.push(1);
  return ts;
}

/**
 * Retorna os pontos de extremidade conectáveis de uma curva comprometida.
 *
 * @param {THREE.Line} line
 * @returns {THREE.Vector3[]}
 */
export function getLineEndpoints(line) {
  const pts = line?.userData?.pts;
  const tool = line?.userData?.tool;
  if (!pts || pts.length < 2) return [];
  if (tool === "arc") {
    return pts.length >= 3 ? [pts[1], pts[2]] : [];
  }
  return [pts[0], pts[pts.length - 1]];
}

/**
 * Indica se um ponto de controle representa uma extremidade da curva.
 *
 * @param {THREE.Line} line
 * @param {number} ptIndex
 * @returns {boolean}
 */
export function isEndpointHandle(line, ptIndex) {
  const pts = line?.userData?.pts;
  const tool = line?.userData?.tool;
  if (!pts || pts.length < 2) return false;
  if (tool === "arc") return ptIndex === 1 || ptIndex === 2;
  return ptIndex === 0 || ptIndex === pts.length - 1;
}
