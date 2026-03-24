/**
 * src/occt/VolumeEditor.js
 *
 * Módulo de edição volumétrica — Parte 1: Linhas → Face
 *                               Parte 2: Face  → Sólido (Prism / Revol)
 *
 * Pipeline Parte 1:
 *   THREE.Vector3[]  →  gp_Pnt[]
 *   gp_Pnt[]         →  BRepBuilderAPI_MakeEdge[]
 *   Edges            →  BRepBuilderAPI_MakeWire  →  TopoDS_Wire
 *   Wire + gp_Pln    →  BRepBuilderAPI_MakeFace  →  TopoDS_Face
 *   TopoDS_Face      →  BRepMesh_IncrementalMesh  →  THREE.BufferGeometry
 *
 * Pipeline Parte 2:
 *   TopoDS_Face + gp_Vec  →  BRepPrimAPI_MakePrism    →  TopoDS_Shape (solid)
 *   TopoDS_Face + gp_Ax1  →  BRepPrimAPI_MakeRevol    →  TopoDS_Shape (solid)
 *   TopoDS_Shape          →  BRepMesh_IncrementalMesh →  THREE.BufferGeometry
 *
 * Instalação:
 *   npm install opencascade.js
 *
 * Requisito no vite.config.js (ver arquivo adjacente):
 *   headers COOP/COEP para SharedArrayBuffer do WASM
 *
 * Numeração dos construtores overloaded no opencascade.js
 * ─────────────────────────────────────────────────────────
 * Cada construtor C++ sobrecarregado é exposto como ClassName_N, onde N
 * corresponde à sua posição na lista de construtores do header OCCT 7.7+.
 *
 * Parte 1:
 *   gp_Pnt_3(x, y, z)                         ← gp_Pnt(Real, Real, Real)
 *   gp_Dir_4(x, y, z)                         ← gp_Dir(Real, Real, Real)
 *   gp_Ax3_4(gp_Pnt, gp_Dir)                  ← gp_Ax3(P, V)
 *   gp_Pln_2(gp_Ax3)                          ← gp_Pln(Ax3)
 *   BRepBuilderAPI_MakeEdge_3(gp_Pnt, gp_Pnt)
 *   BRepBuilderAPI_MakeWire_1()                ← construtor padrão
 *   BRepBuilderAPI_MakeFace_16(pln, wire, bool) ← com plano explícito
 *   BRepBuilderAPI_MakeFace_15(wire, bool)      ← OCCT infere o plano
 *   BRepMesh_IncrementalMesh_2(shape, lin, rel, ang, par)
 *   TopExp_Explorer_2(shape, topAbsEnum)
 *   TopLoc_Location_1()                        ← construtor padrão
 *
 * Parte 2:
 *   gp_Vec_4(x, y, z)                         ← gp_Vec(Real, Real, Real)
 *   gp_Ax1_2(gp_Pnt, gp_Dir)                  ← eixo de revolução
 *   BRepPrimAPI_MakePrism_1(shape, vec, copy, canonize)
 *   BRepPrimAPI_MakeRevol_1(shape, ax1, angle, copy) ← parcial
 *   BRepPrimAPI_MakeRevol_2(shape, ax1, copy)        ← 360°
 */

import * as THREE from "three";
// Import the Emscripten glue directly, bypassing opencascade.js/index.js
// which has a static `import wasmFile from "*.wasm"` (ESM WASM proposal)
// that Vite 6 does not support. The glue itself uses locateFile() at runtime.
import initOpenCascade from "opencascade.js/dist/opencascade.wasm.js";

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON OCCT
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {import('opencascade.js').OpenCascadeInstance | null} */
let _oc = null;

/**
 * Inicializa o kernel OpenCascade (WebAssembly).
 * Chamada única; retorna o cache nas chamadas subsequentes.
 *
 * @returns {Promise<import('opencascade.js').OpenCascadeInstance>}
 */
export async function initOCCT() {
  if (!_oc) {
    _oc = await initOpenCascade({
      // Serve the WASM binary from public/ to avoid Vite's ESM-WASM transform
      locateFile: (path) => `/${path}`,
    });
    console.log("[VolumeEditor] OCCT inicializado (WASM).");
  }
  return _oc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GERENCIAMENTO DE MEMÓRIA WASM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Libera objetos OCCT do heap WASM para evitar memory leak.
 *
 * No WASM, cada `new oc.Algo()` aloca memória gerenciada pelo Emscripten.
 * Ao contrário do C++ RAII, o GC do JS não chama os destrutores OCCT.
 * Sempre chame `cleanupOCCT(obj)` quando o objeto não for mais necessário.
 *
 * @param {...object} objs  Qualquer objeto OCCT criado com `new oc.Algo()`.
 *
 * @example
 *   const pnt = new oc.gp_Pnt_3(1, 2, 3);
 *   // ... uso ...
 *   cleanupOCCT(pnt);  // equivale ao `delete pnt;` em C++
 */
export function cleanupOCCT(...objs) {
  for (const obj of objs) {
    try {
      if (obj != null && typeof obj.delete === "function") obj.delete();
    } catch (_) {
      // Ignora objetos já deletados ou valores primitivos
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUXILIAR: Three.Vector3 → gp_Pnt
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converte um THREE.Vector3 em um gp_Pnt OCCT.
 * O objeto retornado DEVE ser deletado via `cleanupOCCT(pnt)`.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {THREE.Vector3} v
 * @returns {object} gp_Pnt
 */
function vec3ToGpPnt(oc, v) {
  // gp_Pnt(Standard_Real Xp, Standard_Real Yp, Standard_Real Zp) → construtor #3
  return new oc.gp_Pnt_3(v.x, v.y, v.z);
}

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — BLOCO 1: CONSTRUÇÃO DO PLANO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Constrói um `gp_Pln` OCCT a partir da origem e da normal do plano de trabalho.
 *
 * O `gp_Pln` é usado pelo `BRepBuilderAPI_MakeFace` para garantir que
 * a face resultante seja exatamente coplanar com o plano de trabalho.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {THREE.Vector3} origin  Ponto de origem do plano (posição do pivot).
 * @param {THREE.Vector3} normal  Vetor normal unitário do plano.
 * @returns {{ pln: object, ax3: object }}
 *   Ambos devem ser deletados com `cleanupOCCT(pln, ax3)` após o uso.
 *
 * @example
 *   const { pln, ax3 } = buildGpPln(oc,
 *     new THREE.Vector3(0, 0, 0),   // origem do pivot
 *     new THREE.Vector3(0, 1, 0)    // normal Y-up (plano XZ)
 *   );
 *   // ... usa pln para MakeFace ...
 *   cleanupOCCT(pln, ax3);
 */
export function buildGpPln(oc, origin, normal) {
  // gp_Pnt(x, y, z) → construtor #3
  const o = new oc.gp_Pnt_3(origin.x, origin.y, origin.z);
  // gp_Dir(x, y, z) → construtor #4  (normaliza automaticamente)
  const n = new oc.gp_Dir_4(normal.x, normal.y, normal.z);

  // gp_Ax3(gp_Pnt P, gp_Dir V) → construtor #4
  // Define o sistema de eixos: P = origem, V = eixo Z local do sistema
  const ax3 = new oc.gp_Ax3_4(o, n);

  // gp_Pln(gp_Ax3) → construtor #2
  const pln = new oc.gp_Pln_2(ax3);

  // gp_Pnt e gp_Dir foram copiados internamente pelo gp_Ax3 — podem ser liberados
  cleanupOCCT(o, n);

  return { pln, ax3 };
}

/**
 * Extrai a configuração do plano diretamente de um `THREE.Object3D` pivot.
 * Integração direta com o `ThreeGrid.jsx` existente.
 *
 * A normal local do GridHelper é sempre (0,1,0) no espaço local do pivot.
 * A rotação do pivot codifica a orientação do plano ativo:
 *   XZ → pivot identidade  →  normal world = (0, 1, 0)
 *   XY → pivot Rx(+90°)    →  normal world = (0, 0, 1)
 *   YZ → pivot Rz(+90°)    →  normal world = (-1, 0, 0)
 *
 * Deve coincidir exatamente com o `getPlanePoint` do ThreeCanvas.jsx:
 *   `new THREE.Vector3(0,1,0).applyQuaternion(pivot.quaternion)`
 *
 * @param {THREE.Object3D} pivot  Objeto pivot do plano de trabalho.
 * @returns {{ origin: THREE.Vector3, normal: THREE.Vector3 }}
 */
export function planeConfigFromPivot(pivot) {
  // Normal local do grid → transforma pelo quaternion do pivot → normal global
  const worldNormal = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(pivot.quaternion)
    .normalize();

  return { origin: pivot.position.clone(), normal: worldNormal };
}

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — BLOCO 2: PONTOS → WIRE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converte `THREE.Vector3[]` em um `TopoDS_Wire` OCCT fechado.
 *
 * Pipeline interno:
 *   Vector3[i] + Vector3[i+1]  →  gp_Pnt pair
 *   gp_Pnt pair                →  BRepBuilderAPI_MakeEdge  →  TopoDS_Edge
 *   TopoDS_Edge[]              →  BRepBuilderAPI_MakeWire  →  TopoDS_Wire
 *
 * O contorno é fechado automaticamente se `points[0] ≠ points[last]`.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {THREE.Vector3[]} points  Pontos do contorno (mínimo 3).
 * @param {object}         _pln    gp_Pln do plano de trabalho (reservado para validações futuras).
 * @returns {object | null}  `TopoDS_Wire` — o caller DEVE deletar com `cleanupOCCT(wire)`.
 */
export function pointsToOCCTWire(oc, points, _pln) {
  if (points.length < 3) {
    console.warn(
      "[VolumeEditor] pointsToOCCTWire: mínimo de 3 pontos necessários.",
    );
    return null;
  }

  // Fecha o contorno: duplica o primeiro ponto no final se ainda não estiver fechado
  const pts = [...points];
  if (pts[0].distanceTo(pts[pts.length - 1]) > 1e-6) {
    pts.push(pts[0].clone());
  }

  // BRepBuilderAPI_MakeWire() → construtor padrão #1
  const wireBuilder = new oc.BRepBuilderAPI_MakeWire_1();
  const toFree = []; // acumula tudo que deve ser deletado ao final desta função

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = vec3ToGpPnt(oc, pts[i]);
    const p2 = vec3ToGpPnt(oc, pts[i + 1]);

    // BRepBuilderAPI_MakeEdge(gp_Pnt, gp_Pnt) → construtor #3
    const edgeBuilder = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
    toFree.push(p1, p2);

    if (!edgeBuilder.IsDone()) {
      console.warn(
        `[VolumeEditor] Edge ${i}→${i + 1} inválida (pontos coincidentes ou degenerados).`,
      );
      cleanupOCCT(edgeBuilder, wireBuilder, ...toFree);
      return null;
    }

    // Obtém a TopoDS_Edge e adiciona ao wire builder
    // BRepBuilderAPI_MakeWire::Add(TopoDS_Edge) → overload #1
    const edge = edgeBuilder.Edge();
    wireBuilder.Add_1(edge);

    toFree.push(edgeBuilder, edge);
  }

  // Verifica se o wire foi construído sem erros de topologia
  if (!wireBuilder.IsDone()) {
    console.warn("[VolumeEditor] Wire inválido. Error:", wireBuilder.Error());
    cleanupOCCT(wireBuilder, ...toFree);
    return null;
  }

  // Wire() retorna uma cópia por valor — é independente do builder
  const wire = wireBuilder.Wire();
  cleanupOCCT(wireBuilder, ...toFree);

  return wire; // ← caller é responsável por: cleanupOCCT(wire)
}

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — BLOCO 3: WIRE → FACE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cria uma `TopoDS_Face` a partir de um wire e um plano.
 *
 * Tentativa 1 — face planar com plano explícito:
 *   `BRepBuilderAPI_MakeFace(gp_Pln, TopoDS_Wire, Inside=true)` → construtor #16
 *
 * Tentativa 2 — fallback genérico (OCCT infere o plano por si):
 *   `BRepBuilderAPI_MakeFace(TopoDS_Wire, OnlyPlane=true)` → construtor #15
 *   Funciona apenas se o wire for exatamente planar.
 *
 * Futuro (não implementado aqui):
 *   Se o wire não for planar, usar `GeomAPI_PointsToBSplineSurface` para obter
 *   uma superfície NURBS e então `BRepBuilderAPI_MakeFace(Geom_Surface, wire)`.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object} wire  TopoDS_Wire fechado.
 * @param {object} pln   gp_Pln do plano de trabalho.
 * @returns {object | null}  `TopoDS_Face` — caller DEVE deletar com `cleanupOCCT(face)`.
 */
export function wireToFace(oc, wire, pln) {
  // ── Tentativa 1: face planar com plano explícito ──────────────────────────
  // BRepBuilderAPI_MakeFace(gp_Pln, TopoDS_Wire, Standard_Boolean Inside) → #16
  const fb1 = new oc.BRepBuilderAPI_MakeFace_16(pln, wire, true);
  if (fb1.IsDone()) {
    const face = fb1.Face(); // cópia por valor — independente do builder
    fb1.delete();
    return face; // ← caller é responsável por: cleanupOCCT(face)
  }

  const err1 = fb1.Error();
  fb1.delete();
  console.warn(
    `[VolumeEditor] MakeFace com gp_Pln falhou (código ${err1}). Tentando fallback…`,
  );

  // ── Tentativa 2: fallback — OCCT infere o plano ───────────────────────────
  // BRepBuilderAPI_MakeFace(TopoDS_Wire, Standard_Boolean OnlyPlane) → #15
  // OnlyPlane=true: lança erro se o wire não for planar (não cria superfície NURBS)
  const fb2 = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  if (fb2.IsDone()) {
    const face = fb2.Face();
    fb2.delete();
    return face;
  }

  const err2 = fb2.Error();
  fb2.delete();
  console.error(
    `[VolumeEditor] wireToFace falhou em ambas as tentativas (erro fallback: ${err2}).`,
    "Wire não planar? Verifique se todos os pontos pertencem ao mesmo plano.",
  );
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — BLOCO 4: SHAPE → THREE.BufferGeometry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Triangula qualquer `TopoDS_Shape` OCCT e retorna uma `THREE.BufferGeometry`.
 *
 * Usa `BRepMesh_IncrementalMesh` (triangulador padrão do OCCT) seguido de
 * `TopExp_Explorer` para varrer as faces e extrair os triângulos.
 *
 * A geometria resultante usa **flat shading** (normais calculadas por produto
 * vetorial). Para smooth shading, chame `geo.computeVertexNormals()` depois.
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object} shape          Qualquer TopoDS_Shape (face, solid, shell, etc.).
 * @param {number} [meshQuality]  Deflexão linear (padrão 0.1). Menor = malha mais fina.
 * @returns {THREE.BufferGeometry | null}
 *
 * @example
 *   const geo = shapeToThreeMesh(oc, face, 0.05);
 *   const mat = new THREE.MeshStandardMaterial({ color: 0x2266ff, side: THREE.DoubleSide });
 *   scene.add(new THREE.Mesh(geo, mat));
 */
export function shapeToThreeMesh(oc, shape, meshQuality = 0.1) {
  // ── 1. Triangulação incremental ───────────────────────────────────────────
  // BRepMesh_IncrementalMesh(shape, linDeflection, isRelative, angDeflection, inParallel)
  // → construtor #2
  const mesher = new oc.BRepMesh_IncrementalMesh_2(
    shape,
    meshQuality, // deflexão linear (mm ou unidade do modelo)
    false, // isRelative: false = deflexão absoluta
    0.5, // deflexão angular (radianos); 0.5 ≈ 28°
    false, // isInParallel: false = single-thread (seguro no WASM)
  );
  mesher.Perform();

  if (!mesher.IsDone()) {
    console.warn("[VolumeEditor] BRepMesh_IncrementalMesh falhou.");
    mesher.delete();
    return null;
  }
  mesher.delete();

  // ── 2. Extração dos triângulos ─────────────────────────────────────────────
  const positions = []; // [x0,y0,z0, x1,y1,z1, ...]  (3 floats por vértice)
  const normals = []; // [nx,ny,nz, ...] (flat shading)

  // TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SHAPE) → construtor #2
  // O terceiro parâmetro (ToAvoid) é obrigatório no binding Emscripten,
  // mesmo sendo opcional no C++ original. TopAbs_SHAPE = sem restrição de evitar.
  const explorer = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  while (explorer.More()) {
    // Obtém a TopoDS_Face atual (downcast via TopoDS.Face)
    const face = oc.TopoDS.Face_1(explorer.Current());
    // Orientation() é sobrecarregado → getter exposto como Orientation_1() no binding Emscripten
    const isReversed =
      face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

    // Recupera a triangulação de Poly_Triangulation associada à face
    // TopLoc_Location() → construtor #1
    const location = new oc.TopLoc_Location_1();
    const triHandle = oc.BRep_Tool.Triangulation(face, location);

    if (!triHandle.IsNull()) {
      const tri = triHandle.get(); // desreferencia o Handle<>
      const nNodes = tri.NbNodes();
      const nTriangles = tri.NbTriangles();

      // ── 2a. Coleta os vértices (transformados pela localização) ──────────
      const nodes = new Array(nNodes);

      // Verifica se a face tem uma transformação local não-identidade
      const hasTrsf = !location.IsIdentity();
      const trsf = hasTrsf ? location.Transformation() : null;

      for (let i = 1; i <= nNodes; i++) {
        // tri.Node(i) → gp_Pnt (índice 1-based)
        const node = tri.Node(i);

        let x, y, z;
        if (hasTrsf) {
          // Aplica a transformação de localização (pose do sub-shape)
          const tp = node.Transformed(trsf);
          x = tp.X();
          y = tp.Y();
          z = tp.Z();
          cleanupOCCT(tp);
        } else {
          x = node.X();
          y = node.Y();
          z = node.Z();
        }
        nodes[i - 1] = new THREE.Vector3(x, y, z);
      }

      cleanupOCCT(trsf); // null-safe (cleanupOCCT ignora null)

      // ── 2b. Monta os triângulos ──────────────────────────────────────────
      for (let t = 1; t <= nTriangles; t++) {
        // tri.Triangle(t) → Poly_Triangle (índice 1-based)
        const triangle = tri.Triangle(t);

        // Poly_Triangle::Value(index) → Standard_Integer (vértice 1-based)
        let i1 = triangle.Value(1) - 1;
        let i2 = triangle.Value(2) - 1;
        let i3 = triangle.Value(3) - 1;

        // Inverte winding order para faces com orientação reversa
        if (isReversed) [i2, i3] = [i3, i2];

        const v0 = nodes[i1];
        const v1 = nodes[i2];
        const v2 = nodes[i3];

        positions.push(v0.x, v0.y, v0.z);
        positions.push(v1.x, v1.y, v1.z);
        positions.push(v2.x, v2.y, v2.z);

        // Normal flat (produto vetorial das arestas)
        const e1 = new THREE.Vector3().subVectors(v1, v0);
        const e2 = new THREE.Vector3().subVectors(v2, v0);
        const nrm = new THREE.Vector3().crossVectors(e1, e2).normalize();
        if (isReversed) nrm.negate();

        normals.push(nrm.x, nrm.y, nrm.z); // vértice 0
        normals.push(nrm.x, nrm.y, nrm.z); // vértice 1
        normals.push(nrm.x, nrm.y, nrm.z); // vértice 2
      }
    }

    location.delete();
    face.delete();
    explorer.Next();
  }
  explorer.delete();

  if (positions.length === 0) {
    console.warn("[VolumeEditor] shapeToThreeMesh: nenhum triângulo gerado.");
    return null;
  }

  // ── 3. Monta a BufferGeometry Three.js ───────────────────────────────────
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geo.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3),
  );

  return geo;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PONTO DE ENTRADA PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline completo: `Vector3[]` + configuração do plano → face OCCT + preview Three.js.
 *
 * Orquestra todas as etapas internas e gerencia a memória WASM intermediária.
 * Apenas a `TopoDS_Face` final é exposta ao caller (para uso em operações
 * futuras como extrusão e operações booleanas).
 *
 * @param {THREE.Vector3[]} points
 *   Pontos do contorno no espaço 3D (mínimo 3, máximo ilimitado).
 *   Devem estar aproximadamente no plano definido por `planeConfig`.
 *
 * @param {{ origin: THREE.Vector3, normal: THREE.Vector3 }} planeConfig
 *   Configuração do plano de trabalho.
 *   Use `planeConfigFromPivot(pivot, activePlane)` para extrair do pivot existente.
 *
 * @param {number} [meshQuality=0.1]
 *   Deflexão linear para triangulação do preview (menor = mais fino).
 *
 * @returns {Promise<{
 *   face:     object,                   // TopoDS_Face — para operações OCCT futuras
 *   geometry: THREE.BufferGeometry,     // para renderização imediata no Three.js
 *   dispose:  () => void                // libera face OCCT + BufferGeometry
 * } | null>}
 *
 * @example
 * // ── Exemplo de uso com o plano de trabalho existente ─────────────────────
 *
 * // 1. Obtém a configuração do plano a partir do pivot (ThreeCanvas.jsx)
 * const planeConfig = planeConfigFromPivot(pivotRef.current, activePlane);
 *
 * // 2. Usa os pontos desenhados (drawPts já coletados no ThreeCanvas)
 * const result = await buildFaceFromPoints(drawPts, planeConfig, 0.05);
 *
 * if (result) {
 *   // 3. Adiciona o preview à cena Three.js
 *   const mat = new THREE.MeshStandardMaterial({
 *     color: 0x2266ff,
 *     side: THREE.DoubleSide,
 *     transparent: true,
 *     opacity: 0.6,
 *   });
 *   const mesh = new THREE.Mesh(result.geometry, mat);
 *   scene.add(mesh);
 *
 *   // 4. Quando a face não for mais necessária (ex: desmontagem do componente):
 *   result.dispose();
 *   scene.remove(mesh);
 * }
 */
export async function buildFaceFromPoints(
  points,
  planeConfig,
  meshQuality = 0.1,
) {
  const oc = await initOCCT();

  // ── Etapa 1: Constrói o plano OCCT ────────────────────────────────────────
  const { pln, ax3 } = buildGpPln(oc, planeConfig.origin, planeConfig.normal);

  // ── Etapa 2: Converte pontos → wire fechado ───────────────────────────────
  const wire = pointsToOCCTWire(oc, points, pln);
  if (!wire) {
    cleanupOCCT(pln, ax3);
    return null;
  }

  // ── Etapa 3: Wire + plano → face planar ──────────────────────────────────
  const face = wireToFace(oc, wire, pln);

  // Wire e plano já foram consumidos (copiados) pelos builders — podem ser liberados
  cleanupOCCT(pln, ax3, wire);

  if (!face) return null;

  // ── Etapa 4: Triangulação para preview Three.js ───────────────────────────
  const geometry = shapeToThreeMesh(oc, face, meshQuality);

  return {
    /** TopoDS_Face OCCT — preserve para extrusão, booleanas, etc. (Parte 2+) */
    face,

    /** BufferGeometry Three.js pronta para `new THREE.Mesh(geometry, mat)` */
    geometry,

    /**
     * Libera a face do heap WASM e descarta a BufferGeometry.
     * Chame quando a face não for mais necessária.
     */
    dispose() {
      cleanupOCCT(face);
      geometry?.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO 5 — EXTRUSÃO: TopoDS_Face → TopoDS_Shape (Prism)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extruda uma `TopoDS_Face` usando `BRepPrimAPI_MakePrism`.
 *
 * Para uma face planar fechada, o OCCT retorna um `TopoDS_Solid` com a face
 * inferior, a face superior e as faces laterais. Para geometria aberta pode
 * retornar um `TopoDS_Shell`; `shapeToThreeMesh` trata ambos os casos.
 *
 * Construtores usados (OCCT 7.7+):
 *   gp_Vec_4(x,y,z)                              ← gp_Vec(Real,Real,Real)
 *   BRepPrimAPI_MakePrism_1(shape, vec, copy, canonize)
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object}                face             TopoDS_Face de origem (não é consumido).
 * @param {THREE.Vector3 | number} direction
 *   - `THREE.Vector3` — vetor de extrusão (direção + magnitude).
 *   - `number`        — distância ao longo da `options.normal` (padrão Y-up).
 * @param {{ normal?: THREE.Vector3, quality?: number }} [options]
 *   - `normal`  — normal do plano (usada quando `direction` é `number`).
 *   - `quality` — deflexão linear para triangulação do preview (padrão 0.1).
 * @returns {{ solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
 */
export function extrudeFace(oc, face, direction, options = {}) {
  const { normal = new THREE.Vector3(0, 1, 0), quality = 0.1 } = options;

  // Resolve o vetor de extrusão final
  const extVec3 =
    typeof direction === "number"
      ? normal.clone().normalize().multiplyScalar(direction)
      : direction.clone();

  // gp_Vec(x, y, z) → construtor #4
  const vec = new oc.gp_Vec_4(extVec3.x, extVec3.y, extVec3.z);

  // BRepPrimAPI_MakePrism(shape, gp_Vec, Copy=false, Canonize=true) → construtor #1
  // Copy=false  : reutiliza a topologia da face (mais eficiente)
  // Canonize=true: simplifica superfícies planas/cilíndricas quando possível
  const prism = new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true);
  prism.Build();
  cleanupOCCT(vec);

  if (!prism.IsDone()) {
    console.error("[VolumeEditor] extrudeFace: BRepPrimAPI_MakePrism falhou.");
    prism.delete();
    return null;
  }

  const solid = prism.Shape(); // TopoDS_Shape — valor independente do builder
  prism.delete();

  const geometry = shapeToThreeMesh(oc, solid, quality);

  return {
    /** TopoDS_Shape (geralmente TopoDS_Solid) — preserve para booleanas etc. */
    solid,
    /** BufferGeometry Three.js para preview imediato */
    geometry,
    dispose() {
      cleanupOCCT(solid);
      geometry?.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO 6 — REVOLUÇÃO: TopoDS_Face → TopoDS_Shape (Revol)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Revolve uma `TopoDS_Face` usando `BRepPrimAPI_MakeRevol`.
 *
 * Construtores usados (OCCT 7.7+):
 *   gp_Ax1_2(gp_Pnt, gp_Dir)                             ← eixo de revolução
 *   BRepPrimAPI_MakeRevol_1(shape, ax1, angleRad, copy)   ← parcial (< 360°)
 *   BRepPrimAPI_MakeRevol_2(shape, ax1, copy)             ← completo (360°)
 *
 * @param {import('opencascade.js').OpenCascadeInstance} oc
 * @param {object} face  TopoDS_Face de origem (não é consumido).
 * @param {{ origin: THREE.Vector3, direction: THREE.Vector3 } | THREE.Line3} axis
 *   Eixo de revolução. Aceita `{ origin, direction }` ou `THREE.Line3`.
 * @param {number} [angleDegrees=360]  Ângulo em graus (1–360).
 * @param {{ quality?: number }} [options]
 * @returns {{ solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
 */
export function revolveFace(oc, face, axis, angleDegrees = 360, options = {}) {
  const { quality = 0.1 } = options;

  // Normaliza o eixo para { origin, direction }
  let origin, direction;
  if (axis && "start" in axis) {
    // THREE.Line3 — start + end definem a direção
    origin = axis.start.clone();
    direction = new THREE.Vector3()
      .subVectors(axis.end, axis.start)
      .normalize();
  } else {
    origin = axis.origin.clone();
    direction = axis.direction.clone().normalize();
  }

  // gp_Pnt(x,y,z) → construtor #3
  const axPnt = new oc.gp_Pnt_3(origin.x, origin.y, origin.z);
  // gp_Dir(x,y,z) → construtor #4
  const axDir = new oc.gp_Dir_4(direction.x, direction.y, direction.z);
  // gp_Ax1(gp_Pnt, gp_Dir) → construtor #2
  const ax1 = new oc.gp_Ax1_2(axPnt, axDir);
  cleanupOCCT(axPnt, axDir); // copiados internamente pelo gp_Ax1

  // Escolhe construtor baseado no ângulo
  const isFull = Math.abs(angleDegrees - 360) < 1e-4;
  const revol = isFull
    ? // BRepPrimAPI_MakeRevol(shape, gp_Ax1, Copy=false) → construtor #2 (360°)
      new oc.BRepPrimAPI_MakeRevol_2(face, ax1, false)
    : // BRepPrimAPI_MakeRevol(shape, gp_Ax1, angleRad, Copy=false) → construtor #1
      new oc.BRepPrimAPI_MakeRevol_1(
        face,
        ax1,
        THREE.MathUtils.degToRad(angleDegrees),
        false,
      );

  revol.Build();
  cleanupOCCT(ax1);

  if (!revol.IsDone()) {
    console.error("[VolumeEditor] revolveFace: BRepPrimAPI_MakeRevol falhou.");
    revol.delete();
    return null;
  }

  const solid = revol.Shape();
  revol.delete();

  const geometry = shapeToThreeMesh(oc, solid, quality);

  return {
    solid,
    geometry,
    dispose() {
      cleanupOCCT(solid);
      geometry?.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO 7 — CLASSE VolumeEditor (histórico + undo/redo)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} OperationRecord
 * @property {string}  id        Identificador único (ex: "op_3_1712345678")
 * @property {'sketch'|'extrude'|'revolve'} type
 * @property {string|null}  parentId  ID da operação pai (sketch de origem)
 * @property {object}  params    Parâmetros serializáveis da operação
 * @property {object}  shape     TopoDS_Shape (Face ou Solid) — heap WASM
 * @property {THREE.BufferGeometry|null} geometry  Mesh de preview
 */

/**
 * Editor volumétrico com histórico de operações e undo/redo.
 *
 * Cada operação retorna um objeto com `{ id, shape/face/solid, geometry, dispose }`.
 * O `dispose()` individual NÃO remove do histórico — use `undo()` ou `editor.dispose()`.
 *
 * @example
 * // ── Retângulo no plano XY extrudado 50 unidades ──────────────────────────
 *
 * import * as THREE from "three";
 * import { VolumeEditor, planeConfigFromPivot } from "./occt/VolumeEditor.js";
 *
 * // 1. Cria o editor (inicializa OCCT uma vez)
 * const editor = await VolumeEditor.create();
 *
 * // 2. Define o plano XY (normal Z-up, origem em 0,0,0)
 * const planeConfig = {
 *   origin: new THREE.Vector3(0, 0, 0),
 *   normal: new THREE.Vector3(0, 0, 1),   // XY: normal Z
 * };
 * // Ou, usando o pivot do ThreeGrid.jsx:
 * // const planeConfig = planeConfigFromPivot(pivotRef.current);
 *
 * // 3. Retângulo 10×5 no plano XY  (pontos no plano Z=0)
 * const rect = [
 *   new THREE.Vector3(0,  0, 0),
 *   new THREE.Vector3(10, 0, 0),
 *   new THREE.Vector3(10, 5, 0),
 *   new THREE.Vector3(0,  5, 0),
 * ];
 *
 * // 4. Cria o sketch (face planar)
 * const sk = editor.addSketch(rect, planeConfig, 0.05);
 * // sk = { id, face, geometry, dispose }
 *
 * // 5. Preview da face (opcional — mostra o contorno 2D)
 * const faceMat = new THREE.MeshStandardMaterial({
 *   color: 0x2266ff, side: THREE.DoubleSide, transparent: true, opacity: 0.4,
 * });
 * const faceMesh = new THREE.Mesh(sk.geometry, faceMat);
 * scene.add(faceMesh);
 *
 * // 6. Extruda 50 unidades ao longo da normal Z
 * const ext = editor.extrude(sk.id, 50);
 * // ext = { id, solid, geometry, dispose }
 *
 * // 7. Substitui o preview de face pelo sólido
 * scene.remove(faceMesh);
 * const solidMat = new THREE.MeshStandardMaterial({
 *   color: 0x44aaff,
 *   metalness: 0.2,
 *   roughness: 0.5,
 * });
 * scene.add(new THREE.Mesh(ext.geometry, solidMat));
 *
 * // 8. Histórico e undo/redo
 * console.log(editor.history);  // [{ id, type:'sketch' }, { id, type:'extrude' }]
 * editor.undo();                // desfaz extrusão
 * editor.redo();                // refaz extrusão
 *
 * // 9. Limpeza total ao desmontar
 * editor.dispose();
 */
export class VolumeEditor {
  /** @param {import('opencascade.js').OpenCascadeInstance} oc */
  constructor(oc) {
    this._oc = oc;
    /** @type {OperationRecord[]} */
    this._ops = [];
    this._cursor = -1; // índice da última operação ativa
    this._idSeq = 0;
  }

  // ── Factory ─────────────────────────────────────────────────────────────────

  /**
   * Cria uma instância inicializando o kernel OCCT.
   * @returns {Promise<VolumeEditor>}
   */
  static async create() {
    const oc = await initOCCT();
    return new VolumeEditor(oc);
  }

  // ── Getters de estado ────────────────────────────────────────────────────────

  /** `true` se houver ao menos uma operação para desfazer. */
  get canUndo() {
    return this._cursor >= 0;
  }

  /** `true` se houver operações desfeitas para refazer. */
  get canRedo() {
    return this._cursor < this._ops.length - 1;
  }

  /**
   * Árvore de histórico: lista das operações ativas (antes do cursor).
   * Cada entrada é imutável (somente parâmetros — sem shapes WASM).
   * @returns {{ id: string, type: string, parentId: string|null, params: object }[]}
   */
  get history() {
    return this._ops
      .slice(0, this._cursor + 1)
      .map(({ id, type, parentId, params }) => ({
        id,
        type,
        parentId,
        params: { ...params },
      }));
  }

  // ── Operações ────────────────────────────────────────────────────────────────

  /**
   * Cria uma face planar ("sketch") a partir de um array de pontos.
   *
   * @param {THREE.Vector3[]} points      Contorno do sketch (mínimo 3).
   * @param {{ origin: THREE.Vector3, normal: THREE.Vector3 }} planeConfig
   * @param {number} [quality=0.1]        Deflexão para preview.
   * @returns {{ id: string, face: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
   */
  addSketch(points, planeConfig, quality = 0.1) {
    const oc = this._oc;

    const { pln, ax3 } = buildGpPln(oc, planeConfig.origin, planeConfig.normal);
    const wire = pointsToOCCTWire(oc, points, pln);
    if (!wire) {
      cleanupOCCT(pln, ax3);
      return null;
    }

    const face = wireToFace(oc, wire, pln);
    cleanupOCCT(pln, ax3, wire);
    if (!face) return null;

    const geometry = shapeToThreeMesh(oc, face, quality);
    const id = this._genId();

    this._commit({
      id,
      type: "sketch",
      parentId: null,
      params: {
        points: points.map((p) => p.clone()),
        planeConfig: this._clonePlane(planeConfig),
      },
      shape: face,
      geometry,
    });

    return {
      id,
      face,
      geometry,
      dispose: () => {
        cleanupOCCT(face);
        geometry?.dispose();
      },
    };
  }

  /**
   * Extruda o sketch identificado por `sketchId`.
   *
   * @param {string}                 sketchId       ID retornado por `addSketch`.
   * @param {THREE.Vector3 | number} distanceOrVec  Vetor ou distância escalar.
   * @param {{ quality?: number, normal?: THREE.Vector3 }} [options]
   * @returns {{ id: string, solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
   */
  extrude(sketchId, distanceOrVec, options = {}) {
    const sketch = this._findSketch(sketchId);
    if (!sketch) return null;

    const extNormal = options.normal ?? sketch.params.planeConfig.normal;
    const result = extrudeFace(this._oc, sketch.shape, distanceOrVec, {
      normal: extNormal,
      quality: options.quality ?? 0.1,
    });
    if (!result) return null;

    const extVec =
      typeof distanceOrVec === "number"
        ? extNormal.clone().normalize().multiplyScalar(distanceOrVec)
        : distanceOrVec.clone();

    const id = this._genId();
    this._commit({
      id,
      type: "extrude",
      parentId: sketchId,
      params: { sketchId, direction: extVec },
      shape: result.solid,
      geometry: result.geometry,
    });

    return {
      id,
      solid: result.solid,
      geometry: result.geometry,
      dispose: result.dispose,
    };
  }

  /**
   * Revolve o sketch identificado por `sketchId`.
   *
   * @param {string} sketchId   ID retornado por `addSketch`.
   * @param {{ origin: THREE.Vector3, direction: THREE.Vector3 } | THREE.Line3} axis
   * @param {number} [angleDegrees=360]
   * @param {{ quality?: number }} [options]
   * @returns {{ id: string, solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
   */
  revolve(sketchId, axis, angleDegrees = 360, options = {}) {
    const sketch = this._findSketch(sketchId);
    if (!sketch) return null;

    const result = revolveFace(this._oc, sketch.shape, axis, angleDegrees, {
      quality: options.quality ?? 0.1,
    });
    if (!result) return null;

    const id = this._genId();
    this._commit({
      id,
      type: "revolve",
      parentId: sketchId,
      params: { sketchId, axis, angleDegrees },
      shape: result.solid,
      geometry: result.geometry,
    });

    return {
      id,
      solid: result.solid,
      geometry: result.geometry,
      dispose: result.dispose,
    };
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────────

  /**
   * Desfaz a última operação ativa.
   * A shape OCCT **não** é deletada (precisa existir para `redo()`).
   * @returns {{ id: string, type: string } | null}  Operação desfeita, ou null se vazio.
   */
  undo() {
    if (!this.canUndo) return null;
    const op = this._ops[this._cursor--];
    return { id: op.id, type: op.type };
  }

  /**
   * Refaz a última operação desfeita.
   * @returns {{ id: string, type: string, geometry: THREE.BufferGeometry|null } | null}
   */
  redo() {
    if (!this.canRedo) return null;
    const op = this._ops[++this._cursor];
    return { id: op.id, type: op.type, geometry: op.geometry };
  }

  /**
   * Retorna a geometria (BufferGeometry) de qualquer operação pelo ID.
   * Útil para restaurar previews após um redo.
   * @param {string} id
   * @returns {THREE.BufferGeometry | null}
   */
  getGeometry(id) {
    return this._ops.find((op) => op.id === id)?.geometry ?? null;
  }

  /**
   * Retorna a TopoDS_Shape (face, solid, etc.) de qualquer operação pelo ID.
   * Necessário para operações avançadas (booleanas, loft) em VolumeEditorAdvanced.
   * @param {string} id
   * @returns {object | null}  TopoDS_Shape no heap WASM, ou null se não encontrado.
   */
  getShape(id) {
    return this._ops.find((op) => op.id === id)?.shape ?? null;
  }

  // ── Limpeza ──────────────────────────────────────────────────────────────────

  /**
   * Libera **todos** os shapes OCCT e geometrias Three.js do histórico.
   * Chame ao desmontar o componente que usa o VolumeEditor.
   */
  dispose() {
    for (const op of this._ops) {
      cleanupOCCT(op.shape);
      op.geometry?.dispose();
    }
    this._ops.length = 0;
    this._cursor = -1;
  }

  // ── Internos ─────────────────────────────────────────────────────────────────

  _genId() {
    return `op_${++this._idSeq}_${Date.now()}`;
  }

  /** Encontra um sketch ativo pelo ID. */
  _findSketch(sketchId) {
    const idx = this._ops.findIndex(
      (op) => op.id === sketchId && op.type === "sketch",
    );
    if (idx < 0 || idx > this._cursor) {
      console.error(
        `[VolumeEditor] Sketch '${sketchId}' não encontrado ou foi desfeito.`,
      );
      return null;
    }
    return this._ops[idx];
  }

  /**
   * Commit de uma operação no histórico.
   * Operações à frente do cursor (redos pendentes) são destruídas.
   * @param {OperationRecord} record
   */
  _commit(record) {
    // Descarta operações futuras (undo branch) e libera seus recursos
    const pruned = this._ops.splice(this._cursor + 1);
    for (const op of pruned) {
      cleanupOCCT(op.shape);
      op.geometry?.dispose();
    }
    this._ops.push(record);
    this._cursor = this._ops.length - 1;
  }

  _clonePlane(cfg) {
    return { origin: cfg.origin.clone(), normal: cfg.normal.clone() };
  }
}
