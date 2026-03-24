/**
 * src/occt/CurveEditor.js
 *
 * OCCT-based curve constructors and utilities.
 *
 * Provides:
 *   nurbsCurveToOCCT  — Convert Three.js NURBSCurve → Geom_BSplineCurve
 *   makeOCCTSegment    — Line edge from two points (GC_MakeSegment)
 *   makeOCCTArc        — Arc edge from 3 points (GC_MakeArcOfCircle)
 *   curveToEdge        — Handle<Geom_Curve> → TopoDS_Edge
 *   sampleGeomCurve    — Sample a Geom_Curve to THREE.Vector3[]
 *
 * Constructor numbering (opencascade.js / OCCT 7.7+):
 *   GC_MakeSegment_1(gp_Pnt, gp_Pnt)
 *   GC_MakeArcOfCircle_4(gp_Pnt, gp_Pnt, gp_Pnt)          — 3 points
 *   Geom_BSplineCurve_1(poles, knots, mults, degree, periodic)  — non-rational
 *   Geom_BSplineCurve_2(poles, weights, knots, mults, degree, periodic) — rational
 *   TColgp_Array1OfPnt_2(lower, upper)
 *   TColStd_Array1OfReal_2(lower, upper)
 *   TColStd_Array1OfInteger_2(lower, upper)
 *   Handle_Geom_BSplineCurve_2(rawPtr)                      — wrap in handle
 *   BRepBuilderAPI_MakeEdge_24(Handle(Geom_Curve))           — edge from curve
 */

import * as THREE from "three";
import { cleanupOCCT } from "./VolumeEditor.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a flat knot vector with repetitions to separated knots + multiplicities.
 *
 * Example: [0,0,0,0.5,1,1,1] → { knots: [0, 0.5, 1], mults: [3, 1, 3] }
 *
 * @param {number[]} flatKnots
 * @returns {{ knots: number[], mults: number[] }}
 */
function separateKnots(flatKnots) {
  const knots = [];
  const mults = [];
  let i = 0;
  while (i < flatKnots.length) {
    const val = flatKnots[i];
    let count = 0;
    while (i < flatKnots.length && Math.abs(flatKnots[i] - val) < 1e-10) {
      count++;
      i++;
    }
    knots.push(val);
    mults.push(count);
  }
  return { knots, mults };
}

/**
 * Extracts unweighted pole positions and weights from Three.js NURBSCurve
 * control points. Three.js stores (x*w, y*w, z*w, w); OCCT stores
 * separate poles (x, y, z) and weights (w).
 *
 * @param {THREE.Vector4[]} controlPoints
 * @returns {{ poles: {x:number,y:number,z:number}[], weights: number[], isRational: boolean }}
 */
function extractPolesAndWeights(controlPoints) {
  const poles = [];
  const weights = [];
  let isRational = false;
  for (const cp of controlPoints) {
    const w = cp.w || 1;
    weights.push(w);
    if (Math.abs(w - 1) > 1e-10) isRational = true;
    poles.push({ x: cp.x / w, y: cp.y / w, z: cp.z / w });
  }
  return { poles, weights, isRational };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: NURBSCurve → Geom_BSplineCurve
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a Three.js NURBSCurve to an OCCT Geom_BSplineCurve wrapped in a Handle.
 *
 * The conversion is exact — no re-interpolation or sampling, just format translation.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {import('three/examples/jsm/curves/NURBSCurve.js').NURBSCurve} nurbsCurve
 * @returns {{ handle: object, dispose: () => void } | null}
 *   handle — Handle_Geom_BSplineCurve ready for GeomFill / BRepBuilderAPI_MakeEdge
 *   dispose — frees all OCCT objects from WASM heap
 */
export function nurbsCurveToOCCT(oc, nurbsCurve) {
  const degree = nurbsCurve.degree;
  const { knots, mults } = separateKnots(Array.from(nurbsCurve.knots));
  const { poles, weights, isRational } = extractPolesAndWeights(
    nurbsCurve.controlPoints,
  );
  const toFree = [];

  try {
    // TColgp_Array1OfPnt(Lower, Upper) — 1-based
    const poleArr = new oc.TColgp_Array1OfPnt_2(1, poles.length);
    toFree.push(poleArr);
    for (let i = 0; i < poles.length; i++) {
      const p = new oc.gp_Pnt_3(poles[i].x, poles[i].y, poles[i].z);
      poleArr.SetValue(i + 1, p);
      p.delete();
    }

    // TColStd_Array1OfReal for knots
    const knotArr = new oc.TColStd_Array1OfReal_2(1, knots.length);
    toFree.push(knotArr);
    for (let i = 0; i < knots.length; i++) {
      knotArr.SetValue(i + 1, knots[i]);
    }

    // TColStd_Array1OfInteger for multiplicities
    const multArr = new oc.TColStd_Array1OfInteger_2(1, mults.length);
    toFree.push(multArr);
    for (let i = 0; i < mults.length; i++) {
      multArr.SetValue(i + 1, mults[i]);
    }

    let bspline;
    if (isRational) {
      // TColStd_Array1OfReal for weights
      const weightArr = new oc.TColStd_Array1OfReal_2(1, weights.length);
      toFree.push(weightArr);
      for (let i = 0; i < weights.length; i++) {
        weightArr.SetValue(i + 1, weights[i]);
      }
      // Geom_BSplineCurve_2(poles, weights, knots, mults, degree, periodic)
      bspline = new oc.Geom_BSplineCurve_2(
        poleArr,
        weightArr,
        knotArr,
        multArr,
        degree,
        false,
      );
    } else {
      // Geom_BSplineCurve_1(poles, knots, mults, degree, periodic)
      bspline = new oc.Geom_BSplineCurve_1(
        poleArr,
        knotArr,
        multArr,
        degree,
        false,
      );
    }

    // Wrap in Handle for use with GeomFill, MakeEdge, etc.
    const handle = new oc.Handle_Geom_BSplineCurve_2(bspline);

    // Free the arrays (data was copied into the BSplineCurve by OCCT)
    cleanupOCCT(...toFree);

    return {
      handle,
      dispose() {
        handle.delete();
        // bspline is owned by the handle — deleting the handle releases it
      },
    };
  } catch (err) {
    cleanupOCCT(...toFree);
    console.error("[CurveEditor] nurbsCurveToOCCT falhou:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Line segment edge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a line edge (TopoDS_Edge) from two points using GC_MakeSegment.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {THREE.Vector3} p0
 * @param {THREE.Vector3} p1
 * @returns {{ edge: object, dispose: () => void } | null}
 */
export function makeOCCTSegment(oc, p0, p1) {
  const pnt0 = new oc.gp_Pnt_3(p0.x, p0.y, p0.z);
  const pnt1 = new oc.gp_Pnt_3(p1.x, p1.y, p1.z);
  try {
    // GC_MakeSegment_1(gp_Pnt, gp_Pnt)
    const maker = new oc.GC_MakeSegment_1(pnt0, pnt1);
    cleanupOCCT(pnt0, pnt1);
    if (!maker.IsDone()) {
      maker.delete();
      return null;
    }
    const curveHandle = maker.Value();
    maker.delete();
    // Create edge from Handle<Geom_TrimmedCurve> (which IS a Handle<Geom_Curve>)
    const edgeBuilder = new oc.BRepBuilderAPI_MakeEdge_24(curveHandle);
    if (!edgeBuilder.IsDone()) {
      cleanupOCCT(edgeBuilder);
      return null;
    }
    const edge = edgeBuilder.Edge();
    edgeBuilder.delete();
    return { edge, dispose: () => cleanupOCCT(edge) };
  } catch (err) {
    cleanupOCCT(pnt0, pnt1);
    console.error("[CurveEditor] makeOCCTSegment falhou:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Arc edge from 3 points
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates an arc edge from 3 points using GC_MakeArcOfCircle.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {THREE.Vector3} p0 - Start
 * @param {THREE.Vector3} pm - Mid-point on arc
 * @param {THREE.Vector3} p2 - End
 * @returns {{ edge: object, dispose: () => void } | null}
 */
export function makeOCCTArc(oc, p0, pm, p2) {
  const pnt0 = new oc.gp_Pnt_3(p0.x, p0.y, p0.z);
  const pntM = new oc.gp_Pnt_3(pm.x, pm.y, pm.z);
  const pnt2 = new oc.gp_Pnt_3(p2.x, p2.y, p2.z);
  try {
    // GC_MakeArcOfCircle_4(gp_Pnt P1, gp_Pnt P2, gp_Pnt P3) — arc through 3 points
    const maker = new oc.GC_MakeArcOfCircle_4(pnt0, pntM, pnt2);
    cleanupOCCT(pnt0, pntM, pnt2);
    if (!maker.IsDone()) {
      maker.delete();
      return null;
    }
    const curveHandle = maker.Value();
    maker.delete();
    const edgeBuilder = new oc.BRepBuilderAPI_MakeEdge_24(curveHandle);
    if (!edgeBuilder.IsDone()) {
      cleanupOCCT(edgeBuilder);
      return null;
    }
    const edge = edgeBuilder.Edge();
    edgeBuilder.delete();
    return { edge, dispose: () => cleanupOCCT(edge) };
  } catch (err) {
    cleanupOCCT(pnt0, pntM, pnt2);
    console.error("[CurveEditor] makeOCCTArc falhou:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Handle<Geom_Curve> → TopoDS_Edge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a TopoDS_Edge from any Handle<Geom_Curve>.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object} curveHandle  Handle_Geom_Curve or derived handle
 * @returns {{ edge: object, dispose: () => void } | null}
 */
export function curveToEdge(oc, curveHandle) {
  try {
    const edgeBuilder = new oc.BRepBuilderAPI_MakeEdge_24(curveHandle);
    if (!edgeBuilder.IsDone()) {
      edgeBuilder.delete();
      return null;
    }
    const edge = edgeBuilder.Edge();
    edgeBuilder.delete();
    return { edge, dispose: () => cleanupOCCT(edge) };
  } catch (err) {
    console.error("[CurveEditor] curveToEdge falhou:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Sample Geom_Curve to THREE.Vector3[]
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Samples a Geom_BSplineCurve uniformly and returns THREE.Vector3 points.
 *
 * Uses the curve's D0(u) evaluator at uniform parameter steps.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object} curveHandle  Handle_Geom_BSplineCurve (or any Geom_Curve handle)
 * @param {number} nPoints      Number of sample points
 * @returns {THREE.Vector3[]}
 */
export function sampleGeomCurve(oc, curveHandle, nPoints = 50) {
  const curve = curveHandle.get();
  const uFirst = curve.FirstParameter();
  const uLast = curve.LastParameter();
  const points = [];
  const pnt = new oc.gp_Pnt_1();
  for (let i = 0; i < nPoints; i++) {
    const u = uFirst + (uLast - uFirst) * (i / (nPoints - 1));
    curve.D0(u, pnt);
    points.push(new THREE.Vector3(pnt.X(), pnt.Y(), pnt.Z()));
  }
  pnt.delete();
  return points;
}
