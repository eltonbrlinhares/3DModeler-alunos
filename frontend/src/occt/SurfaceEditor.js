/**
 * src/occt/SurfaceEditor.js
 *
 * OCCT-based surface generation from B-spline curves.
 *
 * Provides:
 *   loftSections(nurbsCurves, options) — lofted surface through N section curves
 *   fillBoundary(nurbsCurves, options) — Coons-like patch from 2–4 boundary curves
 *
 * Strategy:
 *   1. Convert each Three.js NURBSCurve → Geom_BSplineCurve (via CurveEditor)
 *   2. Create surface patches with GeomFill_BSplineCurves
 *   3. Create TopoDS_Face via BRepBuilderAPI_MakeFace
 *   4. Triangulate via BRepMesh_IncrementalMesh → shapeToThreeMesh
 *   5. Merge patch geometries into one BufferGeometry
 *
 * Verified OCCT constructor numbering (opencascade.js / WASM binary):
 *   GeomFill_BSplineCurves_4(C1, C2, style)           — 2 curves
 *   GeomFill_BSplineCurves_3(C1, C2, C3, style)       — 3 curves
 *   GeomFill_BSplineCurves_2(C1, C2, C3, C4, style)   — 4 curves (Coons)
 *   BRepBuilderAPI_MakeFace_8(Handle<Geom_Surface>, tolerance)
 *   Handle_Geom_Surface_2(rawPtr)                      — upcast from derived
 */

import * as THREE from "three";
import { initOCCT, cleanupOCCT, shapeToThreeMesh } from "./VolumeEditor.js";
import { nurbsCurveToOCCT } from "./CurveEditor.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a surface face between two Geom_BSplineCurve handles.
 *
 * @param {object} oc          OpenCascade instance
 * @param {object} h1          Handle_Geom_BSplineCurve
 * @param {object} h2          Handle_Geom_BSplineCurve
 * @param {object} fillStyle   GeomFill_FillingStyle enum value
 * @param {number} tolerance   Face tolerance
 * @returns {{ face: object, dispose: () => void } | null}
 */
function createPatchFace(oc, h1, h2, fillStyle, tolerance) {
  let filler, bsSurfHandle, surfHandle, maker;
  try {
    // GeomFill_BSplineCurves_4(C1, C2, FillingStyle) — 2-curve constructor
    filler = new oc.GeomFill_BSplineCurves_4(h1, h2, fillStyle);

    // .Surface() → Handle<Geom_BSplineSurface>
    bsSurfHandle = filler.Surface();

    // Upcast to Handle<Geom_Surface> for BRepBuilderAPI_MakeFace
    surfHandle = new oc.Handle_Geom_Surface_2(bsSurfHandle.get());

    // BRepBuilderAPI_MakeFace_8(Handle<Geom_Surface>, tolerance)
    maker = new oc.BRepBuilderAPI_MakeFace_8(surfHandle, tolerance);

    if (!maker.IsDone()) {
      console.warn("[SurfaceEditor] MakeFace falhou para patch.");
      cleanupOCCT(maker, surfHandle, bsSurfHandle, filler);
      return null;
    }

    const face = maker.Face();
    cleanupOCCT(maker, surfHandle, bsSurfHandle, filler);

    return {
      face,
      dispose() {
        cleanupOCCT(face);
      },
    };
  } catch (err) {
    cleanupOCCT(maker, surfHandle, bsSurfHandle, filler);
    console.error("[SurfaceEditor] createPatchFace falhou:", err.message);
    return null;
  }
}

/**
 * Merges multiple BufferGeometries (position + normal) into one.
 *
 * @param {THREE.BufferGeometry[]} geometries
 * @returns {THREE.BufferGeometry | null}
 */
function mergeGeometries(geometries) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];

  let totalVerts = 0;
  for (const geo of geometries) {
    totalVerts += geo.getAttribute("position").count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  let offset = 0;

  for (const geo of geometries) {
    const pos = geo.getAttribute("position");
    const nrm = geo.getAttribute("normal");
    positions.set(pos.array, offset * 3);
    if (nrm) normals.set(nrm.array, offset * 3);
    offset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );
  merged.setAttribute(
    "normal",
    new THREE.BufferAttribute(normals, 3),
  );
  return merged;
}

/**
 * Snaps boundary B-spline curve endpoints so that shared corners coincide
 * exactly.  GeomFill_BSplineCurves requires geometric C0 continuity at
 * corners (tolerance ~1e-7).  User-drawn curves typically meet within a
 * much looser visual tolerance, so this step is essential.
 *
 * Works by averaging the two endpoint positions that should meet and
 * moving both first/last poles to that average.
 */
function snapBoundaryCorners(oc, handles) {
  const count = handles.length;
  if (count < 3) return;          // 2-curve patch has no shared corners

  const curves = handles.map((h) => h.get());
  const toFree = [];

  const startPt = (c) => {
    const p = c.Value(c.FirstParameter());
    toFree.push(p);
    return p;
  };
  const endPt = (c) => {
    const p = c.Value(c.LastParameter());
    toFree.push(p);
    return p;
  };

  const snap = (cA, poleA, cB, poleB, pA, pB) => {
    const mid = new oc.gp_Pnt_3(
      (pA.X() + pB.X()) / 2,
      (pA.Y() + pB.Y()) / 2,
      (pA.Z() + pB.Z()) / 2,
    );
    cA.SetPole_1(poleA, mid);
    cB.SetPole_1(poleB, mid);
    mid.delete();
  };

  // Sequential closed contour: end(C[i]) = start(C[(i+1) % N])
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    snap(
      curves[i], curves[i].NbPoles(),   // last pole of C[i]
      curves[j], 1,                      // first pole of C[j]
      endPt(curves[i]),
      startPt(curves[j]),
    );
  }

  cleanupOCCT(...toFree);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: loftSections — lofted surface through N cross-section curves
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a lofted surface by patching consecutive pairs of B-spline curves.
 *
 * Each consecutive pair (curves[i], curves[i+1]) produces one surface patch
 * via GeomFill_BSplineCurves. The patches are triangulated and merged into
 * a single BufferGeometry.
 *
 * @param {import('three/examples/jsm/curves/NURBSCurve.js').NURBSCurve[]} nurbsCurves
 *   Array of Three.js NURBSCurve objects (minimum 2).
 *   Must already be ordered; use ordering/orientation from ThreeCanvas.
 *
 * @param {{
 *   quality?: number,
 *   reversed?: boolean[],
 *   fillStyle?: 'stretch' | 'coons' | 'curved'
 * }} [options]
 *   - quality   — linear deflection for triangulation (default 0.05)
 *   - reversed  — per-curve flags: true = reverse curve direction in OCCT
 *   - fillStyle — GeomFill style: 'stretch'|'coons'|'curved' (default 'curved')
 *
 * @returns {Promise<{ geometry: THREE.BufferGeometry, dispose: () => void } | null>}
 */
export async function loftSections(nurbsCurves, options = {}) {
  const {
    quality = 0.05,
    reversed = [],
    fillStyle = "curved",
  } = options;

  if (!nurbsCurves || nurbsCurves.length < 2) {
    console.warn("[SurfaceEditor] loftSections requer pelo menos 2 curvas.");
    return null;
  }

  const oc = await initOCCT();

  // Resolve fill style enum
  const styleMap = {
    stretch: oc.GeomFill_FillingStyle.GeomFill_StretchStyle,
    coons: oc.GeomFill_FillingStyle.GeomFill_CoonsStyle,
    curved: oc.GeomFill_FillingStyle.GeomFill_CurvedStyle,
  };
  const ocFillStyle = styleMap[fillStyle] ?? styleMap.curved;
  const tolerance = 1e-6;

  // ── 1. Convert all NURBSCurves to OCCT Geom_BSplineCurve handles ─────────
  const curveResults = [];
  for (let i = 0; i < nurbsCurves.length; i++) {
    const result = nurbsCurveToOCCT(oc, nurbsCurves[i]);
    if (!result) {
      console.warn(
        `[SurfaceEditor] Falha ao converter curva ${i} para OCCT.`,
      );
      curveResults.forEach((r) => r?.dispose());
      return null;
    }
    // Apply reversal if flagged by the orientation pipeline
    if (reversed[i]) {
      result.handle.get().Reverse();
    }
    curveResults.push(result);
  }

  // ── 2. Create patches between consecutive curve pairs ─────────────────────
  const patchGeometries = [];
  const patchFaces = [];

  for (let i = 0; i < curveResults.length - 1; i++) {
    const patch = createPatchFace(
      oc,
      curveResults[i].handle,
      curveResults[i + 1].handle,
      ocFillStyle,
      tolerance,
    );

    if (!patch) {
      console.warn(
        `[SurfaceEditor] Patch entre curvas ${i} e ${i + 1} falhou. Pulando.`,
      );
      continue;
    }

    patchFaces.push(patch);

    const geo = shapeToThreeMesh(oc, patch.face, quality);
    if (geo) {
      patchGeometries.push(geo);
    } else {
      console.warn(
        `[SurfaceEditor] Triangulação do patch ${i}-${i + 1} falhou.`,
      );
    }
  }

  if (patchGeometries.length === 0) {
    console.warn(
      "[SurfaceEditor] Nenhum patch foi gerado com sucesso.",
    );
    patchFaces.forEach((p) => p.dispose());
    curveResults.forEach((r) => r.dispose());
    return null;
  }

  // ── 3. Merge patch geometries ─────────────────────────────────────────────
  const geometry = mergeGeometries(patchGeometries);

  // Clean up individual patch geometries (merged data was copied)
  if (patchGeometries.length > 1) {
    patchGeometries.forEach((g) => g.dispose());
  }

  return {
    geometry,
    dispose() {
      patchFaces.forEach((p) => p.dispose());
      curveResults.forEach((r) => r.dispose());
      geometry?.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: fillBoundary — Coons patch from 3–4 boundary curves (pure Three.js)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a surface patch bounded by 3–4 curves using bilinear Coons
 * interpolation — pure Three.js, no OCCT/WASM.
 *
 * Coons patch formula (4 curves):
 *   S(u,v) = (1-v)·bottom(u) + v·top(u)       ← ruled along u
 *          + (1-u)·left(v)   + u·right(v)      ← ruled along v
 *          − bilinear(corners, u, v)            ← corner correction
 *
 * The 4 curves must be in sequential loop order:
 *   e0(A→B), e1(B→C), e2(C→D), e3(D→A)
 *
 * @param {import('three/examples/jsm/curves/NURBSCurve.js').NURBSCurve[]} nurbsCurves
 * @param {{ reversed?: boolean[], resolution?: number }} [options]
 * @returns {Promise<{ geometry: THREE.BufferGeometry, dispose: () => void } | null>}
 */
export async function fillBoundary(nurbsCurves, options = {}) {
  const { reversed = [], resolution = 24 } = options;
  const N = nurbsCurves?.length;

  if (!N || N < 3 || N > 4) {
    console.warn("[SurfaceEditor] fillBoundary requer 3–4 curvas, recebeu:", N);
    return null;
  }

  const res = resolution;

  // Sample a NURBS curve into (res+1) points, optionally reversed
  const sample = (nurbs, rev) => {
    const pts = nurbs.getPoints(res);          // res intervals → res+1 points
    return rev ? pts.reverse() : pts;
  };

  let geometry;

  if (N === 4) {
    // Sequential loop: e0(A→B), e1(B→C), e2(C→D), e3(D→A)
    // Coons convention:
    //   bottom(u) = A→B  (v=0)    top(u)  = D→C  (v=1, same u-sense)
    //   left(v)   = A→D  (u=0)    right(v)= B→C  (u=1)
    const bottom = sample(nurbsCurves[0], reversed[0]);    // A→B
    const right  = sample(nurbsCurves[1], reversed[1]);    // B→C
    const topRev = sample(nurbsCurves[2], reversed[2]);    // C→D
    const leftRev = sample(nurbsCurves[3], reversed[3]);   // D→A

    const top  = [...topRev].reverse();  // D→C (same u-sense as bottom)
    const left = [...leftRev].reverse(); // A→D (same v-sense as right)

    // Corners
    const P00 = bottom[0];      // A
    const P10 = bottom[res];    // B
    const P01 = top[0];         // D
    const P11 = top[res];       // C

    geometry = buildCoonsPatch(bottom, top, left, right, P00, P10, P01, P11, res);
  } else {
    // 3-curve degenerate: e0(A→B), e1(B→C), e2(C→A)
    // Collapse corner: left edge degenerates to point A
    const bottom = sample(nurbsCurves[0], reversed[0]);    // A→B
    const right  = sample(nurbsCurves[1], reversed[1]);    // B→C
    const c2Rev  = sample(nurbsCurves[2], reversed[2]);    // C→A

    const top  = [...c2Rev].reverse();   // A→C
    const A = bottom[0];
    const left = Array.from({ length: res + 1 }, () => A.clone());

    const P00 = A;
    const P10 = bottom[res];    // B
    const P01 = A;               // degenerate
    const P11 = top[res];       // C

    geometry = buildCoonsPatch(bottom, top, left, right, P00, P10, P01, P11, res);
  }

  if (!geometry) return null;

  console.info("[SurfaceEditor] fillBoundary: Coons patch gerado com %d curvas, res=%d.", N, res);

  return {
    geometry,
    dispose() { geometry?.dispose(); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: fillPlanar — flat surface from N ≥ 2 closed boundary curves
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a flat triangulated surface from a closed contour of 2 or more
 * NURBS curves — pure Three.js, no OCCT/WASM.
 *
 * Algorithm:
 *   1. Sample all curves sequentially into a closed polyline.
 *   2. Fit a best-fit plane via Newell's method (works for non-planar inputs too).
 *   3. Project the polyline onto the plane (2-D u/v coordinates).
 *   4. Triangulate with THREE.ShapeUtils.triangulateShape.
 *   5. Reconstruct 3-D positions and build BufferGeometry.
 *
 * The curves must form a single closed contour in sequential order:
 *   end(curves[i]) ≈ start(curves[(i+1) % N])
 *
 * @param {import('three/examples/jsm/curves/NURBSCurve.js').NURBSCurve[]} nurbsCurves
 * @param {{ reversed?: boolean[], resolution?: number }} [options]
 * @returns {Promise<{ geometry: THREE.BufferGeometry, dispose: () => void } | null>}
 */
export async function fillPlanar(nurbsCurves, options = {}) {
  const { reversed = [], resolution = 32 } = options;
  const N = nurbsCurves?.length;

  if (!N || N < 2) {
    console.warn("[SurfaceEditor] fillPlanar requer pelo menos 2 curvas.");
    return null;
  }

  // ── 1. Sample each curve into (resolution+1) pts; concatenate, drop shared endpoints ──
  const allPts = [];
  for (let i = 0; i < N; i++) {
    const pts = nurbsCurves[i].getPoints(resolution);
    const oriented = reversed[i] ? [...pts].reverse() : pts;
    // Drop the last point — it coincides with the start of the next curve
    for (let j = 0; j < oriented.length - 1; j++) {
      allPts.push(oriented[j]);
    }
  }

  const M = allPts.length;
  if (M < 3) {
    console.warn("[SurfaceEditor] fillPlanar: pontos insuficientes após amostragem.");
    return null;
  }

  // ── 2. Best-fit plane via Newell's method ──────────────────────────────────
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < M; i++) {
    const c = allPts[i];
    const n = allPts[(i + 1) % M];
    nx += (c.y - n.y) * (c.z + n.z);
    ny += (c.z - n.z) * (c.x + n.x);
    nz += (c.x - n.x) * (c.y + n.y);
  }
  const normal = new THREE.Vector3(nx, ny, nz).normalize();

  const centroid = new THREE.Vector3();
  for (const p of allPts) centroid.add(p);
  centroid.divideScalar(M);

  // Build orthonormal UV basis on the plane
  const up = Math.abs(normal.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const uAxis = new THREE.Vector3().crossVectors(up, normal).normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

  // ── 3. Project 3-D polyline onto 2-D (u, v) ──────────────────────────────
  const pts2d = allPts.map((p) => {
    const d = new THREE.Vector3().subVectors(p, centroid);
    return new THREE.Vector2(d.dot(uAxis), d.dot(vAxis));
  });

  // ── 4. Triangulate the 2-D contour ───────────────────────────────────────
  const triIndices = THREE.ShapeUtils.triangulateShape(pts2d, []);
  if (!triIndices || triIndices.length === 0) {
    console.warn("[SurfaceEditor] fillPlanar: triangulação falhou.");
    return null;
  }

  // ── 5. Build BufferGeometry from original 3-D points + triangle indices ──
  const positions = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    positions[i * 3]     = allPts[i].x;
    positions[i * 3 + 1] = allPts[i].y;
    positions[i * 3 + 2] = allPts[i].z;
  }

  const flatIndices = triIndices.flat();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(flatIndices);
  geo.computeVertexNormals();

  console.info(
    "[SurfaceEditor] fillPlanar: %d curvas, %d pontos de contorno, %d triângulos.",
    N, M, triIndices.length,
  );

  return {
    geometry: geo,
    dispose() { geo.dispose(); },
  };
}

/**
 * Bilinear Coons patch: builds a triangulated BufferGeometry from 4 boundary
 * sample arrays and 4 corner points.
 *
 * @param {THREE.Vector3[]} bottom  (res+1) points, u=0→1 at v=0
 * @param {THREE.Vector3[]} top     (res+1) points, u=0→1 at v=1
 * @param {THREE.Vector3[]} left    (res+1) points, v=0→1 at u=0
 * @param {THREE.Vector3[]} right   (res+1) points, v=0→1 at u=1
 * @param {THREE.Vector3} P00  corner (u=0,v=0)
 * @param {THREE.Vector3} P10  corner (u=1,v=0)
 * @param {THREE.Vector3} P01  corner (u=0,v=1)
 * @param {THREE.Vector3} P11  corner (u=1,v=1)
 * @param {number} res  number of subdivisions per direction
 * @returns {THREE.BufferGeometry}
 */
function buildCoonsPatch(bottom, top, left, right, P00, P10, P01, P11, res) {
  const positions = [];
  const indices = [];
  const cols = res + 1;

  for (let iv = 0; iv <= res; iv++) {
    const v = iv / res;
    for (let iu = 0; iu <= res; iu++) {
      const u = iu / res;

      // Ruled surface along u (bottom/top boundaries)
      const Lc_x = (1 - v) * bottom[iu].x + v * top[iu].x;
      const Lc_y = (1 - v) * bottom[iu].y + v * top[iu].y;
      const Lc_z = (1 - v) * bottom[iu].z + v * top[iu].z;

      // Ruled surface along v (left/right boundaries)
      const Ld_x = (1 - u) * left[iv].x + u * right[iv].x;
      const Ld_y = (1 - u) * left[iv].y + u * right[iv].y;
      const Ld_z = (1 - u) * left[iv].z + u * right[iv].z;

      // Bilinear corner correction
      const B_x = (1-u)*(1-v)*P00.x + u*(1-v)*P10.x + (1-u)*v*P01.x + u*v*P11.x;
      const B_y = (1-u)*(1-v)*P00.y + u*(1-v)*P10.y + (1-u)*v*P01.y + u*v*P11.y;
      const B_z = (1-u)*(1-v)*P00.z + u*(1-v)*P10.z + (1-u)*v*P01.z + u*v*P11.z;

      // S(u,v) = Lc + Ld − B
      positions.push(Lc_x + Ld_x - B_x, Lc_y + Ld_y - B_y, Lc_z + Ld_z - B_z);
    }
  }

  // Triangulate: two triangles per quad cell
  for (let iv = 0; iv < res; iv++) {
    for (let iu = 0; iu < res; iu++) {
      const i00 = iv * cols + iu;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      indices.push(i00, i10, i11);
      indices.push(i00, i11, i01);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
