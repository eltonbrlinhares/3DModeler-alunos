/**
 * canvas/surfaceOrderUtils.js
 *
 * Funções puras para ordenação e orientação de seções de superfície.
 * Usadas por generateSurface.js para preparar curvas para loft/fillBoundary.
 */

/**
 * Determina a orientação relativa (direta ou invertida) entre duas seções
 * comparando as distâncias entre extremidades.
 *
 * @param {THREE.Vector3[]} samplesA
 * @param {THREE.Vector3[]} samplesB
 * @returns {{ reverse: boolean, maxDistance: number, totalDistance: number }}
 */
export function getSurfacePairing(samplesA, samplesB) {
  const aStart = samplesA[0];
  const aEnd = samplesA[samplesA.length - 1];
  const bStart = samplesB[0];
  const bEnd = samplesB[samplesB.length - 1];

  const directStart = aStart.distanceTo(bStart);
  const directEnd = aEnd.distanceTo(bEnd);
  const reverseStart = aStart.distanceTo(bEnd);
  const reverseEnd = aEnd.distanceTo(bStart);

  const direct = {
    reverse: false,
    maxDistance: Math.max(directStart, directEnd),
    totalDistance: directStart + directEnd,
  };
  const reverse = {
    reverse: true,
    maxDistance: Math.max(reverseStart, reverseEnd),
    totalDistance: reverseStart + reverseEnd,
  };

  if (reverse.maxDistance < direct.maxDistance) return reverse;
  if (
    reverse.maxDistance === direct.maxDistance &&
    reverse.totalDistance < direct.totalDistance
  ) {
    return reverse;
  }
  return direct;
}

/**
 * Ordena seções de superfície em cadeia linear por conectividade de extremidades.
 * Retorna null se as seções não formarem uma cadeia válida.
 *
 * @param {{ samples: THREE.Vector3[], nurbs: any, line: THREE.Line }[]} sections
 * @param {number} spacingRef - espaçamento do grid (para tolerância)
 * @returns {object[] | null}
 */
export function orderSurfaceSections(sections, spacing) {
  if (sections.length < 2) return null;

  const connectionTolerance = Math.max(0.25, spacing * 0.8);
  const adjacency = sections.map(() => []);

  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const pairing = getSurfacePairing(
        sections[i].samples,
        sections[j].samples,
      );
      if (pairing.maxDistance > connectionTolerance) continue;
      adjacency[i].push({ index: j, pairing });
      adjacency[j].push({ index: i, pairing });
    }
  }

  if (adjacency.some((neighbors) => neighbors.length === 0)) return null;

  const degreeOne = adjacency
    .map((neighbors, index) => ({ index, degree: neighbors.length }))
    .filter(({ degree }) => degree === 1)
    .map(({ index }) => index);

  if (degreeOne.length !== 0 && degreeOne.length !== 2) return null;
  if (adjacency.some((neighbors) => neighbors.length > 2)) return null;

  const ordered = [];
  const visited = new Set();
  let currentIndex = degreeOne[0] ?? 0;
  let previousIndex = null;

  while (currentIndex !== null && currentIndex !== undefined) {
    ordered.push(sections[currentIndex]);
    visited.add(currentIndex);

    const nextCandidates = adjacency[currentIndex]
      .filter(({ index }) => index !== previousIndex && !visited.has(index))
      .sort(
        (left, right) =>
          left.pairing.totalDistance - right.pairing.totalDistance,
      );

    previousIndex = currentIndex;
    currentIndex = nextCandidates[0]?.index ?? null;
  }

  return ordered.length === sections.length ? ordered : null;
}

/**
 * Orienta seções ordenadas para que extremidades consecutivas coincidam.
 *
 * @param {object[]} orderedSections
 * @returns {object[]}
 */
export function orientSurfaceSections(orderedSections) {
  if (orderedSections.length < 2) return orderedSections;

  const oriented = [
    { ...orderedSections[0], samples: [...orderedSections[0].samples],
      reversed: orderedSections[0].reversed || false },
  ];
  for (let index = 1; index < orderedSections.length; index++) {
    const previous = oriented[index - 1].samples;
    const current = [...orderedSections[index].samples];
    const pairing = getSurfacePairing(previous, current);
    if (pairing.reverse) current.reverse();
    const priorReversed = orderedSections[index].reversed || false;
    const combinedReversed = priorReversed !== pairing.reverse;
    oriented.push({ ...orderedSections[index], samples: current, reversed: combinedReversed });
  }

  return oriented;
}

/**
 * Ordena seções por proximidade greedy (fallback quando a conectividade falha).
 *
 * @param {object[]} sections
 * @returns {object[] | null}
 */
export function fallbackOrderSurfaceSections(sections) {
  if (sections.length < 2) return null;

  const remaining = sections.slice(1).map((section) => ({
    ...section,
    samples: [...section.samples],
  }));
  const ordered = [{ ...sections[0], samples: [...sections[0].samples] }];

  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1].samples;
    let bestIndex = -1;
    let bestPairing = null;

    for (let index = 0; index < remaining.length; index++) {
      const pairing = getSurfacePairing(previous, remaining[index].samples);
      if (
        !bestPairing ||
        pairing.totalDistance < bestPairing.totalDistance
      ) {
        bestPairing = pairing;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || !bestPairing) return null;
    const [next] = remaining.splice(bestIndex, 1);
    next.reversed = bestPairing.reverse;
    if (bestPairing.reverse) next.samples.reverse();
    ordered.push(next);
  }

  return ordered;
}

/**
 * Tenta ordenar N curvas como loop fechado usando clustering de extremidades.
 * Retorna null se as curvas não formarem um loop válido.
 *
 * @param {{ samples: THREE.Vector3[], nurbs: any, line: THREE.Line }[]} secs
 * @param {number} loopTolerance
 * @returns {object[] | null}
 */
export function orderClosedBoundary(secs, loopTolerance) {
  const N = secs.length;
  if (N < 2) return null;

  // Coleta todos os 2N endpoints
  const allPts = [];
  secs.forEach((s, i) => {
    allPts.push({ pt: s.samples[0],                    ci: i, isStart: true });
    allPts.push({ pt: s.samples[s.samples.length - 1], ci: i, isStart: false });
  });

  // Agrupa endpoints em cantos (dentro da tolerância)
  const cornerOf = new Array(allPts.length).fill(-1);
  const corners = [];
  for (let i = 0; i < allPts.length; i++) {
    if (cornerOf[i] >= 0) continue;
    cornerOf[i] = corners.length;
    for (let j = i + 1; j < allPts.length; j++) {
      if (cornerOf[j] >= 0) continue;
      if (allPts[i].pt.distanceTo(allPts[j].pt) < loopTolerance) {
        cornerOf[j] = corners.length;
      }
    }
    corners.push(corners.length);
  }

  // Para N curvas em loop fechado precisamos exatamente N cantos
  if (corners.length !== N) {
    console.warn("[Surface] Clustering encontrou %d cantos, esperado %d", corners.length, N);
    return null;
  }

  // Mapeia cada curva para seus 2 cantos: [startCorner, endCorner]
  const curveCorners = secs.map((_, i) => [
    cornerOf[i * 2],
    cornerOf[i * 2 + 1],
  ]);

  // Percorre o loop a partir da curva 0
  const ordered = [{ idx: 0, rev: false }];
  const used = new Set([0]);
  let currentCorner = curveCorners[0][1];

  for (let step = 1; step < N; step++) {
    let found = false;
    for (let c = 0; c < N; c++) {
      if (used.has(c)) continue;
      const [c0, c1] = curveCorners[c];
      if (c0 === currentCorner) {
        ordered.push({ idx: c, rev: false });
        used.add(c);
        currentCorner = c1;
        found = true;
        break;
      }
      if (c1 === currentCorner) {
        ordered.push({ idx: c, rev: true });
        used.add(c);
        currentCorner = c0;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }

  // Verifica se o loop fecha de volta ao canto inicial da curva 0
  if (currentCorner !== curveCorners[0][0]) return null;

  return ordered.map(({ idx, rev }) => ({
    ...secs[idx],
    samples: rev
      ? [...secs[idx].samples].reverse()
      : [...secs[idx].samples],
    reversed: rev,
  }));
}
