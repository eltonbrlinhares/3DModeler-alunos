/**
 * src/curves/NURBSBuilders.js
 *
 * Construtores de curvas NURBS (Non-Uniform Rational B-Splines) para Three.js.
 * Retornam instâncias de `NURBSCurve` que podem ser amostradas via `.getPoints(n)`.
 *
 * Funções exportadas:
 *   makeLine(p0, p1)          — segmento de reta (grau 1, 2 pontos de controle)
 *   makePolyline(pts)         — polilinha aberta (grau 1, N pontos de controle)
 *   makeArc(p0, pm, p2)       — arco 3D por circuncentro (grau 2, NURBS racional)
 *   makeSpline(pts)           — spline interpolante grau 3 (passa por todos os pontos)
 *
 * Referências matemáticas:
 *   - "The NURBS Book" (Piegl & Tiller, 1997) — §9.2 para spline interpolante
 *   - Algoritmo de Cox-de Boor para bases B-spline
 */

import * as THREE from "three";
import { NURBSCurve } from "three/examples/jsm/curves/NURBSCurve.js";

// ── Auxiliares geométricos (não exportados) ────────────────────────────────────

/**
 * Calcula o circuncentro de um triângulo 3D (ponto equidistante dos 3 vértices).
 *
 * O circuncentro é o centro do círculo que passa pelos 3 pontos — base para
 * construir o arco NURBS correto em `makeArc`.
 *
 * Derivação: resolve o sistema linear usando produto vetorial implícito.
 * Retorna null se os pontos forem colineares (triângulo degenerado).
 *
 * @param {THREE.Vector3} p0
 * @param {THREE.Vector3} p1
 * @param {THREE.Vector3} p2
 * @returns {THREE.Vector3 | null}
 */
function circumcenter3D(p0, p1, p2) {
  const a  = new THREE.Vector3().subVectors(p1, p0); // vetor p0→p1
  const b  = new THREE.Vector3().subVectors(p2, p0); // vetor p0→p2
  const aa = a.dot(a); // |a|²
  const ab = a.dot(b);
  const bb = b.dot(b); // |b|²
  const D  = aa * bb - ab * ab; // = |a × b|² (é zero se colineares)
  if (Math.abs(D) < 1e-12) return null; // pontos colineares — sem circuncentro

  // Coordenadas baricêntricas do circuncentro no triângulo
  const s = (bb * (aa - ab)) / (2 * D);
  const t = (aa * (bb - ab)) / (2 * D);

  return p0.clone().addScaledVector(a, s).addScaledVector(b, t);
}

/**
 * Calcula o ponto de controle intermediário e o peso racional de um segmento
 * de arco NURBS grau 2 entre dois pontos A e B sobre um círculo (C, R²).
 *
 * Um arco NURBS grau 2 precisa de 3 pontos de controle: [A, P1, B].
 * P1 é a interseção das tangentes ao círculo em A e B (ponto de controle "fora" do arco).
 * O peso w1 < 1 "puxa" a curva para dentro, produzindo a curvatura correta.
 *
 * @param {THREE.Vector3} A     - Ponto inicial do segmento
 * @param {THREE.Vector3} B     - Ponto final do segmento
 * @param {THREE.Vector3} C     - Centro do círculo
 * @param {number}        R_sq  - Raio² do círculo
 * @returns {{ P1: THREE.Vector3, w1: number } | null}
 */
function arcSegmentCtrl(A, B, C, R_sq) {
  // M = ponto médio de AB
  const M    = A.clone().add(B).multiplyScalar(0.5);
  const MC   = M.clone().sub(C);           // vetor do centro ao ponto médio
  const MC_sq = MC.lengthSq();
  if (MC_sq < 1e-14) return null; // A e B são antípodas — ponto médio = centro

  // P1 = ponto na reta (C→M) à distância R²/|CM| do centro
  // (é a interseção das tangentes em A e B)
  const P1 = C.clone().addScaledVector(MC, R_sq / MC_sq);
  // w1 = cos(metade do ângulo do arco) → produz a curvatura certa no NURBS
  const w1 = Math.sqrt(MC_sq / R_sq);

  return { P1, w1 };
}

// ── Construtores de curvas (exportados) ───────────────────────────────────────

/**
 * Cria um segmento de reta NURBS grau 1 entre dois pontos.
 *
 * Vetor de nós clamped para grau 1 com 2 pontos: [0, 0, 1, 1].
 *
 * @param {THREE.Vector3} p0 - Ponto inicial
 * @param {THREE.Vector3} p1 - Ponto final
 * @returns {NURBSCurve}
 */
export function makeLine(p0, p1) {
  const cps = [
    new THREE.Vector4(p0.x, p0.y, p0.z, 1), // peso 1 = ponto não-racional
    new THREE.Vector4(p1.x, p1.y, p1.z, 1),
  ];
  return new NURBSCurve(1, [0, 0, 1, 1], cps);
}

/**
 * Cria uma polilinha NURBS grau 1 passando por todos os pontos.
 *
 * Vetor de nós clamped para grau 1 com N pontos:
 *   [0, 0,  1, 2, ..., N-2,  N-1, N-1]
 * (duplicação nas extremidades para fixar os pontos de início e fim)
 *
 * @param {THREE.Vector3[]} pts - Array de pontos (mínimo 2)
 * @returns {NURBSCurve | null}
 */
export function makePolyline(pts) {
  const n = pts.length;
  if (n < 2) return null;

  // Nós internos: 1, 2, ..., N-2  (sem repetição nas extremidades ainda)
  const inner = Array.from({ length: n - 2 }, (_, i) => i + 1);
  const knots = [0, 0, ...inner, n - 1, n - 1];
  const cps   = pts.map((p) => new THREE.Vector4(p.x, p.y, p.z, 1));

  return new NURBSCurve(1, knots, cps);
}

// ── Auxiliares para a spline interpolante ──────────────────────────────────────

/**
 * Calcula a função de base B-spline N_{i,p}(u) via recursão de Cox-de Boor.
 *
 * Define qual ponto de controle influencia a curva em u:
 *   - Grau 0: N_{i,0}(u) = 1 se knots[i] ≤ u < knots[i+1], senão 0
 *   - Grau p: combinação linear das bases de grau (p-1) (triângulo de de Boor)
 *
 * @param {number}   i      - Índice do ponto de controle
 * @param {number}   p      - Grau da curva
 * @param {number[]} knots  - Vetor de nós
 * @param {number}   u      - Parâmetro [0, 1]
 * @returns {number} Valor da função de base (entre 0 e 1)
 */
function bsplineBasis(i, p, knots, u) {
  if (p === 0) return (knots[i] <= u && u < knots[i + 1]) ? 1.0 : 0.0;

  let result = 0.0;
  const d1 = knots[i + p]     - knots[i];      // denominador esquerdo
  const d2 = knots[i + p + 1] - knots[i + 1];  // denominador direito

  // Evita divisão por zero (nós repetidos → contribuição zero)
  if (d1 > 1e-10) result += ((u - knots[i]) / d1)             * bsplineBasis(i,     p - 1, knots, u);
  if (d2 > 1e-10) result += ((knots[i + p + 1] - u) / d2)     * bsplineBasis(i + 1, p - 1, knots, u);

  return result;
}

/**
 * Resolve um sistema linear n×n: A * x = b, onde b tem 3 colunas (X, Y, Z).
 * Usa eliminação gaussiana com pivô parcial para estabilidade numérica.
 *
 * Usado em `makeSpline` para encontrar os pontos de controle a partir dos
 * pontos de dados e da matriz de bases B-spline.
 *
 * @param {number[][]} A  - Matriz n×n dos coeficientes
 * @param {number[][]} b  - Vetor n×3 do lado direito [[x0,y0,z0], ...]
 * @param {number}     n  - Número de equações/incógnitas
 * @returns {number[][] | null} Solução n×3, ou null se a matriz for singular
 */
function solveLinear3D(A, b, n) {
  // Monta a matriz aumentada [A | b] com as 3 colunas de b concatenadas
  const M = A.map((row, i) => [...row, b[i][0], b[i][1], b[i][2]]);

  // Eliminação gaussiana com pivô parcial
  for (let col = 0; col < n; col++) {
    // Encontra a linha com maior valor absoluto na coluna atual (pivô)
    let maxRow = col, maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-12) return null; // matriz singular

    // Troca a linha atual com a do pivô
    if (maxRow !== col) [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    // Elimina os elementos abaixo do pivô
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / pivot;
      for (let k = col; k < n + 3; k++) M[row][k] -= f * M[col][k];
    }
  }

  // Substituição retroativa para encontrar a solução
  const x = Array.from({ length: n }, () => [0, 0, 0]);
  for (let row = n - 1; row >= 0; row--) {
    for (let d = 0; d < 3; d++) {
      let val = M[row][n + d];
      for (let col = row + 1; col < n; col++) val -= M[row][col] * x[col][d];
      x[row][d] = val / M[row][row];
    }
  }

  return x;
}

/**
 * Cria uma spline interpolante B-spline grau 3 que passa por todos os pontos.
 *
 * Algoritmo (The NURBS Book §9.2):
 *   1. Parametrização por comprimento de corda (distribuição proporcional à distância)
 *   2. Vetor de nós clamped com nós interiores pela média dos parâmetros
 *   3. Monta a matriz de bases N e resolve N * controlPts = dataPoints
 *   4. Retorna uma NURBSCurve com os pontos de controle calculados
 *
 * Com 2 pontos: retorna uma linha (grau mínimo = 1).
 * Se o sistema for singular: fallback para polilinha.
 *
 * @param {THREE.Vector3[]} pts - Pontos de dados (mínimo 2)
 * @returns {NURBSCurve | null}
 */
export function makeSpline(pts) {
  const n = pts.length;
  if (n < 2) return null;
  if (n === 2) return makeLine(pts[0], pts[1]); // linha quando há só 2 pontos

  const p = Math.min(3, n - 1); // grau efetivo (máximo 3, limitado pelo nº de pontos)

  // ── Etapa 1: parametrização por comprimento de corda ─────────────────────
  // params[i] ∈ [0, 1] — proporcional à distância acumulada ao longo dos pontos
  const params = [0];
  for (let i = 1; i < n; i++) params.push(params[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = params[n - 1];
  if (total < 1e-10) return null; // todos os pontos no mesmo lugar
  for (let i = 1; i < n; i++) params[i] /= total; // normaliza para [0, 1]

  // ── Etapa 2: vetor de nós clamped ────────────────────────────────────────
  // Nós das extremidades repetidos p+1 vezes; nós interiores por média
  const nKnots = n + p + 1;
  const knots  = new Array(nKnots).fill(0);
  for (let i = nKnots - p - 1; i < nKnots; i++) knots[i] = 1; // extremidade direita
  for (let j = 1; j <= n - p - 1; j++) {
    let sum = 0;
    for (let i = j; i < j + p; i++) sum += params[i];
    knots[j + p] = sum / p; // média de p parâmetros consecutivos
  }

  // ── Etapa 3: matriz de bases N (n×n) ─────────────────────────────────────
  // N[row][col] = N_{col,p}(params[row])
  // As linhas 0 e n-1 são fixadas em N[0][0]=1 e N[n-1][n-1]=1 (pontos de borda)
  const N = Array.from({ length: n }, () => new Array(n).fill(0));
  N[0][0]         = 1;
  N[n - 1][n - 1] = 1;
  for (let row = 1; row < n - 1; row++) {
    const u = params[row];
    for (let col = 0; col < n; col++) N[row][col] = bsplineBasis(col, p, knots, u);
  }

  // ── Etapa 4: resolve N * controlPts = dataPoints ─────────────────────────
  const Q    = pts.map((pt) => [pt.x, pt.y, pt.z]); // pontos de dados como n×3
  const ctrl = solveLinear3D(N, Q, n);
  if (!ctrl) return makePolyline(pts); // fallback se sistema singular

  const cps = ctrl.map((c) => new THREE.Vector4(c[0], c[1], c[2], 1));
  return new NURBSCurve(p, knots, cps);
}

/**
 * Cria um arco NURBS grau 2 a partir do centro, ponto inicial e ponto final (ou cursor).
 *
 * O raio é fixado por `dist(center, startPt)`. O ponto final é a projeção de `cursorPt`
 * sobre o círculo. O arco sempre percorre o caminho mais curto (< 180°) entre
 * startPt e o ponto projetado.
 *
 * @param {THREE.Vector3} center   - Centro do círculo
 * @param {THREE.Vector3} startPt  - Ponto inicial do arco (define o raio)
 * @param {THREE.Vector3} cursorPt - Posição do cursor (projetada no círculo como ponto final)
 * @returns {NURBSCurve | null}
 */
export function makeArcFromCenterStartEnd(center, startPt, cursorPt) {
  const R = center.distanceTo(startPt);
  if (R < 1e-10) return null;

  const dirEnd = cursorPt.clone().sub(center);
  if (dirEnd.lengthSq() < 1e-10) return null;
  dirEnd.normalize();

  const endPt = center.clone().addScaledVector(dirEnd, R);
  const R_sq  = R * R;

  // Usa o centro CONHECIDO diretamente em arcSegmentCtrl — evita recomputar via
  // circumcenter3D (numericamente instável quando os três pontos estão muito próximos).
  const seg = arcSegmentCtrl(startPt, endPt, center, R_sq);

  if (!seg) {
    // Caso antipodal (180°): divide em dois segmentos de 90° pelo ponto perpendicular
    const dirStart = startPt.clone().sub(center).normalize();
    const normal   = new THREE.Vector3().crossVectors(dirStart, dirEnd);
    if (normal.lengthSq() < 1e-10) return makeLine(startPt, endPt); // colineares
    const perp  = new THREE.Vector3().crossVectors(normal.normalize(), dirStart).normalize();
    const midPt = center.clone().addScaledVector(perp, R);
    const s1 = arcSegmentCtrl(startPt, midPt, center, R_sq);
    const s2 = arcSegmentCtrl(midPt, endPt, center, R_sq);
    if (!s1 || !s2) return makeLine(startPt, endPt);
    const cps = [
      new THREE.Vector4(startPt.x, startPt.y, startPt.z, 1),
      new THREE.Vector4(s1.P1.x * s1.w1, s1.P1.y * s1.w1, s1.P1.z * s1.w1, s1.w1),
      new THREE.Vector4(midPt.x, midPt.y, midPt.z, 1),
      new THREE.Vector4(s2.P1.x * s2.w1, s2.P1.y * s2.w1, s2.P1.z * s2.w1, s2.w1),
      new THREE.Vector4(endPt.x, endPt.y, endPt.z, 1),
    ];
    return new NURBSCurve(2, [0, 0, 0, 1, 1, 2, 2, 2], cps);
  }

  const { P1, w1 } = seg;
  return new NURBSCurve(2, [0, 0, 0, 1, 1, 1], [
    new THREE.Vector4(startPt.x, startPt.y, startPt.z, 1),
    new THREE.Vector4(P1.x * w1, P1.y * w1, P1.z * w1, w1),
    new THREE.Vector4(endPt.x, endPt.y, endPt.z, 1),
  ]);
}

/**
 * Cria um arco NURBS grau 2 passando por 3 pontos: início (p0), ponto no arco (pm), fim (p2).
 *
 * O circuncentro define o círculo; pm determina qual arco (menor ou maior).
 *
 * Casos:
 *   - Arco menor (< 180°): 1 segmento grau 2 com 3 pontos de controle
 *   - Arco maior (> 180°): 2 segmentos grau 2 com 5 pontos de controle, dividido em pm
 *   - Pontos colineares: fallback para linha reta (p0 → p2)
 *
 * @param {THREE.Vector3} p0 - Ponto inicial do arco
 * @param {THREE.Vector3} pm - Ponto no meio do arco (define a curvatura)
 * @param {THREE.Vector3} p2 - Ponto final do arco
 * @returns {NURBSCurve}
 */
export function makeArc(p0, pm, p2) {
  // Circuncentro = centro do círculo que passa pelos 3 pontos
  const C = circumcenter3D(p0, pm, p2);
  if (!C) return makeLine(p0, p2); // colineares → linha reta

  const R_sq = p0.distanceToSquared(C);

  // Calcula o ponto de controle do arco inteiro (p0 → p2)
  const seg = arcSegmentCtrl(p0, p2, C, R_sq);
  if (!seg) return makeLine(p0, p2);

  const { P1, w1 } = seg;

  // Determina se pm está do mesmo lado que P1 em relação ao centro
  // (produto escalar dos vetores normalizados C→pm e C→P1)
  const pmC = pm.clone().sub(C).normalize();
  const P1C = P1.clone().sub(C).normalize();

  if (pmC.dot(P1C) > 0) {
    // ── Arco menor (< 180°): segmento único grau 2 ───────────────────────
    // Vetor de nós: [0,0,0, 1,1,1] (grau 2, clamped, sem nós internos)
    const cps = [
      new THREE.Vector4(p0.x, p0.y, p0.z, 1),
      // Ponto de controle racional: coordenadas multiplicadas pelo peso
      new THREE.Vector4(P1.x * w1, P1.y * w1, P1.z * w1, w1),
      new THREE.Vector4(p2.x, p2.y, p2.z, 1),
    ];
    return new NURBSCurve(2, [0, 0, 0, 1, 1, 1], cps);
  }

  // ── Arco maior (> 180°): dois segmentos grau 2, divididos em pm ──────────
  // Calcula os pontos de controle de cada metade independentemente
  const s1 = arcSegmentCtrl(p0, pm, C, R_sq);
  const s2 = arcSegmentCtrl(pm, p2, C, R_sq);
  if (!s1 || !s2) return makeLine(p0, p2);

  // Vetor de nós: [0,0,0, 1,1, 2,2,2] — dois segmentos grau 2 concatenados
  // O nó "1" é o ponto de junção em pm (ponto de controle compartilhado)
  const cps = [
    new THREE.Vector4(p0.x,  p0.y,  p0.z,  1),
    new THREE.Vector4(s1.P1.x * s1.w1, s1.P1.y * s1.w1, s1.P1.z * s1.w1, s1.w1),
    new THREE.Vector4(pm.x,  pm.y,  pm.z,  1), // ponto de junção
    new THREE.Vector4(s2.P1.x * s2.w1, s2.P1.y * s2.w1, s2.P1.z * s2.w1, s2.w1),
    new THREE.Vector4(p2.x,  p2.y,  p2.z,  1),
  ];
  return new NURBSCurve(2, [0, 0, 0, 1, 1, 2, 2, 2], cps);
}
