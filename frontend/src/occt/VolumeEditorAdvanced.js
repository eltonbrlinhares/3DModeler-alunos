/**
 * src/occt/VolumeEditorAdvanced.js
 *
 * Extensão do VolumeEditor com operações avançadas:
 *   - Loft (BRepOffsetAPI_ThruSections)
 *   - Operações booleanas (BRepAlgoAPI_Fuse / Cut / Common)
 *   - Shell → Solid (BRepBuilderAPI_MakeSolid)
 *   - Exportação STEP (STEPControl_Writer)
 *   - API fluente encadeável (VolumeBuilder)
 *
 * Construtores e métodos OCCT usados (OCCT 7.7+):
 *   BRepOffsetAPI_ThruSections_1(isSolid, ruled, pres3d)
 *     .AddWire(wire)  .Build()  .IsDone()  .Shape()
 *
 *   BRepAlgoAPI_Fuse_1()   → default constructor (SetShape1/2 + Build)
 *   BRepAlgoAPI_Cut_1()    → idem
 *   BRepAlgoAPI_Common_1() → idem
 *     .SetShape1(shape)  .SetShape2(shape)  .Build()  .IsDone()  .Shape()
 *
 *   BRepBuilderAPI_MakeSolid_3(shell)  → construtor nº 3 (Shell → Solid)
 *     .IsDone()  .Solid()
 *
 *   STEPControl_Writer_1()
 *     .Transfer(shape, stepModelType, compgraph)
 *     .Write(filename)
 *
 *   TopExp_Explorer_2(shape, TopAbs_WIRE) — extrai outer wire de uma face
 *   oc.TopoDS.Wire_1(shape)              — downcast para TopoDS_Wire
 */

import * as THREE from "three";
import {
  initOCCT,
  cleanupOCCT,
  buildGpPln,
  planeConfigFromPivot, // re-exportado adiante
  pointsToOCCTWire,
  wireToFace,
  shapeToThreeMesh,
  buildFaceFromPoints, // re-exportado adiante
  extrudeFace,
  revolveFace,
  VolumeEditor,
} from "./VolumeEditor.js";

// Re-exporta tudo da Parte 1+2 para que o caller importe apenas daqui
export {
  initOCCT,
  cleanupOCCT,
  buildGpPln,
  planeConfigFromPivot,
  pointsToOCCTWire,
  wireToFace,
  shapeToThreeMesh,
  buildFaceFromPoints,
  extrudeFace,
  revolveFace,
  VolumeEditor,
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUXILIAR: extrai o outer wire de uma face
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retorna o primeiro (outer) `TopoDS_Wire` de uma face.
 * Necessário para `BRepOffsetAPI_ThruSections`, que aceita wires, não faces.
 *
 * @param {object} oc
 * @param {object} face  TopoDS_Face
 * @returns {object | null}  TopoDS_Wire (não precisa ser deletado — referência interna)
 */
function faceOuterWire(oc, face) {
  // Terceiro parâmetro (ToAvoid) obrigatório no binding Emscripten
  const exp = new oc.TopExp_Explorer_2(
    face,
    oc.TopAbs_ShapeEnum.TopAbs_WIRE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  if (!exp.More()) {
    exp.delete();
    return null;
  }
  const wire = oc.TopoDS.Wire_1(exp.Current()); // downcast TopoDS_Shape → TopoDS_Wire
  exp.delete();
  return wire;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO A — LOFT: [TopoDS_Face] → TopoDS_Shape
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cria um sólido de loft passando por um array de faces planares.
 *
 * Cada face é reduzida ao seu outer wire antes de ser entregue ao
 * `BRepOffsetAPI_ThruSections`. Os wires devem ser compatíveis em topologia
 * (mesmo número de vértices ou seções simplesmente conexas).
 *
 * @param {object}   oc
 * @param {object[]} faces      Array de TopoDS_Face (mínimo 2).
 * @param {boolean}  [isSolid=true]  true = gera sólido fechado; false = shell.
 * @param {boolean}  [ruled=false]   true = superfícies regradas; false = smooth.
 * @param {number}   [quality=0.1]   Deflexão para triangulação do preview.
 * @returns {{ solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
 */
export function loftFaces(
  oc,
  faces,
  isSolid = true,
  ruled = false,
  quality = 0.1,
) {
  if (faces.length < 2) {
    console.error("[VolumeEditor] loftFaces: mínimo 2 faces necessárias.");
    return null;
  }

  // BRepOffsetAPI_ThruSections(isSolid, ruled, pres3d) → construtor #1
  const loft = new oc.BRepOffsetAPI_ThruSections_1(isSolid, ruled, 1e-6);

  for (const face of faces) {
    const wire = faceOuterWire(oc, face);
    if (!wire) {
      console.warn("[VolumeEditor] loftFaces: face sem wire ignorada.");
      continue;
    }
    loft.AddWire(wire);
    // wire é referência ao subshape da face — não precisa de cleanup
  }

  loft.Build();

  if (!loft.IsDone()) {
    console.error("[VolumeEditor] loftFaces: ThruSections falhou.");
    loft.delete();
    return null;
  }

  const solid = loft.Shape(); // cópia por valor — independente do builder
  loft.delete();

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
// BLOCO B — OPERAÇÕES BOOLEANAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Executa uma operação booleana entre dois shapes.
 *
 * Usa a API moderna do OCCT 7.x (construtor padrão + SetShape1/2 + Build),
 * mais robusta que a API legada de construtor direto.
 *
 * Construtores usados (todos `_1` = default):
 *   BRepAlgoAPI_Fuse_1()    → SetShape1/2 → Build
 *   BRepAlgoAPI_Cut_1()     → idem
 *   BRepAlgoAPI_Common_1()  → idem
 *
 * @param {object}  oc
 * @param {object}  shapeA     TopoDS_Shape base (target em 'cut').
 * @param {object}  shapeB     TopoDS_Shape ferramenta (tool em 'cut').
 * @param {'fuse'|'cut'|'common'} type
 * @param {number}  [quality=0.1]
 * @returns {{ solid: object, geometry: THREE.BufferGeometry, dispose: ()=>void } | null}
 */
export function boolOp(oc, shapeA, shapeB, type, quality = 0.1) {
  let op;
  switch (type) {
    case "fuse":
      op = new oc.BRepAlgoAPI_Fuse_1();
      break;
    case "cut":
      op = new oc.BRepAlgoAPI_Cut_1();
      break;
    case "common":
      op = new oc.BRepAlgoAPI_Common_1();
      break;
    default:
      console.error(`[VolumeEditor] boolOp: tipo desconhecido '${type}'.`);
      return null;
  }

  op.SetShape1(shapeA);
  op.SetShape2(shapeB);
  op.Build();

  if (!op.IsDone()) {
    console.error(`[VolumeEditor] boolOp '${type}': Build falhou.`);
    op.delete();
    return null;
  }

  const solid = op.Shape();
  op.delete();

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

/** União de dois shapes (A ∪ B). */
export const union = (oc, a, b, q) => boolOp(oc, a, b, "fuse", q);
/** Subtração de B de A (A − B). */
export const subtract = (oc, a, b, q) => boolOp(oc, a, b, "cut", q);
/** Interseção (A ∩ B). */
export const intersect = (oc, a, b, q) => boolOp(oc, a, b, "common", q);

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO C — SHELL → SOLID
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converte um `TopoDS_Shell` em `TopoDS_Solid` usando `BRepBuilderAPI_MakeSolid`.
 *
 * Útil quando `BRepPrimAPI_MakePrism` retorna um Shell (para geometria aberta)
 * ao invés de um Solid. O Shell deve ser fechado e manifold para obter um
 * Solid válido; de outro modo `IsDone()` retorna false.
 *
 * BRepBuilderAPI_MakeSolid(TopoDS_Shell) → construtor #3
 *
 * @param {object} oc
 * @param {object} shell  TopoDS_Shell — não é consumido.
 * @returns {{ solid: object, dispose: ()=>void } | null}
 */
export function makeSolidFromShell(oc, shell) {
  const builder = new oc.BRepBuilderAPI_MakeSolid_3(shell);

  if (!builder.IsDone()) {
    console.error(
      "[VolumeEditor] makeSolidFromShell: Shell não é fechado/manifold.",
    );
    builder.delete();
    return null;
  }

  const solid = builder.Solid();
  builder.delete();

  return {
    solid,
    dispose() {
      cleanupOCCT(solid);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO D — EXPORT STEP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exporta um `TopoDS_Shape` para STEP e dispara o download no browser.
 *
 * Compatível com importação direta no GiD (AP214 / AP203).
 * Usa o sistema de arquivos virtual do Emscripten (`oc.FS`).
 *
 * Pipeline:
 *   STEPControl_Writer_1()
 *   → .Transfer(solid, STEPControl_AsIs, true)
 *   → .Write("/tmp_ve.step")
 *   → oc.FS.readFile("/tmp_ve.step")
 *   → Blob → URL → <a download>
 *
 * @param {object}  solid     TopoDS_Shape a exportar.
 * @param {string}  [filename="modelo.step"]
 * @returns {Promise<Blob | null>}  O Blob do arquivo (útil para testes/servidor).
 */
export async function exportSTEP(solid, filename = "modelo.step") {
  const oc = await initOCCT();
  const tmpPath = "/tmp_ve_export.step";

  // STEPControl_Writer() → construtor padrão #1
  const writer = new oc.STEPControl_Writer_1();

  // Transfer(shape, mode, computeGraph)
  // STEPControl_AsIs = 0: exporta o shape como está (sem conversão de tipo)
  const status = writer.Transfer(
    solid,
    oc.STEPControl_StepModelType.STEPControl_AsIs,
    true, // computeGraph = true para sólidos complexos
  );

  // IFSelect_RetDone = 1 → sucesso
  const ok = status === oc.IFSelect_ReturnStatus.IFSelect_RetDone;
  if (!ok) {
    console.error(
      "[VolumeEditor] exportSTEP: Transfer falhou (status:",
      status,
      ")",
    );
    writer.delete();
    return null;
  }

  // Grava no sistema de arquivos virtual do Emscripten
  writer.Write(tmpPath);
  writer.delete();

  // Lê o arquivo gerado como Uint8Array
  let data;
  try {
    data = oc.FS.readFile(tmpPath, { encoding: "binary" });
  } catch (e) {
    console.error("[VolumeEditor] exportSTEP: leitura do FS falhou:", e);
    return null;
  } finally {
    try {
      oc.FS.unlink(tmpPath);
    } catch (_) {
      /* ignora */
    }
  }

  // Cria Blob e dispara download
  const blob = new Blob([data], { type: "application/step" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return blob;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO E — VolumeEditorAdvanced (subclasse com operações avançadas)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estende `VolumeEditor` (Partes 1+2) com loft, booleanas, exportação STEP
 * e o getter `getCurrentSolid`.
 *
 * Use diretamente para acesso explícito por ID, ou crie um `VolumeBuilder`
 * para a API fluente.
 */
export class VolumeEditorAdvanced extends VolumeEditor {
  /** Factory: cria e inicializa o OCCT. @returns {Promise<VolumeEditorAdvanced>} */
  static async create() {
    const oc = await initOCCT();
    return new VolumeEditorAdvanced(oc);
  }

  // ── Loft ──────────────────────────────────────────────────────────────────

  /**
   * Loft por uma lista de sketch IDs.
   *
   * @param {string[]} sketchIds  IDs de sketches registrados via `addSketch`.
   * @param {boolean}  [isSolid=true]
   * @param {boolean}  [ruled=false]
   * @param {number}   [quality=0.1]
   * @returns {{ id, solid, geometry, dispose } | null}
   */
  loft(sketchIds, isSolid = true, ruled = false, quality = 0.1) {
    if (sketchIds.length < 2) {
      console.error("[VolumeEditor] loft: mínimo 2 sketchIds necessários.");
      return null;
    }

    const faces = sketchIds.map((id) => this.getShape(id)).filter(Boolean);
    if (faces.length < 2) {
      console.error(
        "[VolumeEditor] loft: shapes não encontradas para os IDs fornecidos.",
      );
      return null;
    }

    const result = loftFaces(this._oc, faces, isSolid, ruled, quality);
    if (!result) return null;

    const id = this._genId();
    this._commit({
      id,
      type: "loft",
      parentId: sketchIds[0],
      params: { sketchIds, isSolid, ruled },
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

  // ── Booleanas ─────────────────────────────────────────────────────────────

  /**
   * União: A ∪ B.
   * @param {string} solidIdA  ID do shape base.
   * @param {string} solidIdB  ID do shape ferramenta.
   * @param {number} [quality=0.1]
   */
  union(solidIdA, solidIdB, quality = 0.1) {
    return this._boolOp(solidIdA, solidIdB, "fuse", quality);
  }

  /**
   * Subtração: A − B.
   * @param {string} solidIdA  ID do shape base (alvo).
   * @param {string} solidIdB  ID do shape ferramenta (a subtrair).
   * @param {number} [quality=0.1]
   */
  subtract(solidIdA, solidIdB, quality = 0.1) {
    return this._boolOp(solidIdA, solidIdB, "cut", quality);
  }

  /**
   * Interseção: A ∩ B.
   * @param {string} solidIdA
   * @param {string} solidIdB
   * @param {number} [quality=0.1]
   */
  intersect(solidIdA, solidIdB, quality = 0.1) {
    return this._boolOp(solidIdA, solidIdB, "common", quality);
  }

  _boolOp(idA, idB, type, quality) {
    const shapeA = this.getShape(idA);
    const shapeB = this.getShape(idB);
    if (!shapeA || !shapeB) {
      console.error(
        `[VolumeEditor] ${type}: shapes '${idA}' / '${idB}' não encontradas.`,
      );
      return null;
    }

    const result = boolOp(this._oc, shapeA, shapeB, type, quality);
    if (!result) return null;

    const id = this._genId();
    this._commit({
      id,
      type,
      parentId: idA,
      params: { idA, idB },
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

  // ── Shell → Solid ─────────────────────────────────────────────────────────

  /**
   * Converte um shell (por ID no histórico) em solid.
   * @param {string} shellId  ID de uma operação que produziu um TopoDS_Shell.
   * @returns {{ id, solid, geometry, dispose } | null}
   */
  solidifyShell(shellId, quality = 0.1) {
    const shell = this.getShape(shellId);
    if (!shell) {
      console.error(
        `[VolumeEditor] solidifyShell: shape '${shellId}' não encontrado.`,
      );
      return null;
    }

    const result = makeSolidFromShell(this._oc, shell);
    if (!result) return null;

    const geometry = shapeToThreeMesh(this._oc, result.solid, quality);
    const id = this._genId();

    this._commit({
      id,
      type: "solidify",
      parentId: shellId,
      params: { shellId },
      shape: result.solid,
      geometry,
    });

    return {
      id,
      solid: result.solid,
      geometry,
      dispose: () => {
        result.dispose();
        geometry?.dispose();
      },
    };
  }

  // ── getCurrentSolid ───────────────────────────────────────────────────────

  /**
   * Retorna o último shape sólido produzido no histórico ativo.
   * Percorre o cursor de trás para frente procurando por operações
   * que geram volume (extrude, revolve, loft, fuse, cut, common, solidify).
   *
   * @returns {{ solid: object, geometry: THREE.BufferGeometry } | null}
   */
  getCurrentSolid() {
    const SOLID_OPS = new Set([
      "extrude",
      "revolve",
      "loft",
      "fuse",
      "cut",
      "common",
      "solidify",
    ]);
    for (let i = this._cursor; i >= 0; i--) {
      const op = this._ops[i];
      if (SOLID_OPS.has(op.type)) {
        return { solid: op.shape, geometry: op.geometry };
      }
    }
    return null;
  }

  // ── Exportação STEP ───────────────────────────────────────────────────────

  /**
   * Exporta o shape de um ID (ou o `getCurrentSolid` se não informado) para STEP.
   *
   * @param {string} [solidId]         ID da operação; omitir usa o último sólido.
   * @param {string} [filename="modelo.step"]
   * @returns {Promise<Blob | null>}
   */
  async exportSTEP(solidId, filename = "modelo.step") {
    const shape =
      (solidId ? this.getShape(solidId) : null) ??
      this.getCurrentSolid()?.solid;

    if (!shape) {
      console.error("[VolumeEditor] exportSTEP: nenhum solid encontrado.");
      return null;
    }
    return exportSTEP(shape, filename);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO F — VolumeBuilder (API fluente/encadeável)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * API fluente encadeável sobre `VolumeEditorAdvanced`.
 *
 * Cada método retorna um **novo** `VolumeBuilder` imutável que aponta para
 * o mesmo editor interno compartilhado. Isso permite dividir a cadeia em
 * variáveis independentes (para booleanas entre dois sólidos, por ex.).
 *
 * @example
 * // ── Retângulo 10×5 no plano XY → extrudado 50 → download STEP ────────────
 *
 * import * as THREE from "three";
 * import { VolumeBuilder } from "./occt/VolumeEditorAdvanced.js";
 *
 * const ed = await VolumeBuilder.create();
 *
 * const planeXY = {
 *   origin: new THREE.Vector3(0, 0, 0),
 *   normal: new THREE.Vector3(0, 0, 1),  // normal Z = plano XY
 * };
 *
 * // Caixa 10×5×50
 * const rect = [
 *   new THREE.Vector3( 0, 0, 0),
 *   new THREE.Vector3(10, 0, 0),
 *   new THREE.Vector3(10, 5, 0),
 *   new THREE.Vector3( 0, 5, 0),
 * ];
 * const box = ed.addSketch(rect, planeXY).extrude(50);
 *
 * // Cilindro de subração (aproximação com polígono de 32 lados)
 * const N = 32, R = 2;
 * const circle = Array.from({ length: N }, (_, i) => {
 *   const a = (2 * Math.PI * i) / N;
 *   return new THREE.Vector3(5 + R * Math.cos(a), 2.5 + R * Math.sin(a), 0);
 * });
 * const hole = ed.addSketch(circle, planeXY).extrude(50);
 *
 * // Booleana: caixa − furo
 * const result = box.subtract(hole);
 *
 * // Preview na cena Three.js
 * const mat = new THREE.MeshStandardMaterial({ color: 0x44aaff, metalness: 0.2 });
 * scene.add(new THREE.Mesh(result.geometry, mat));
 *
 * // Exporta para GiD
 * await result.step("peca.step");
 *
 * // Histórico
 * console.log(ed.history);
 * // [{ type:'sketch' }, { type:'extrude' }, { type:'sketch' }, { type:'extrude' }, { type:'cut' }]
 *
 * // Undo / Redo
 * ed.undo().undo();
 * console.log(ed.history.at(-1).type); // 'extrude'
 * ed.redo();
 *
 * // Limpeza
 * ed.dispose();
 *
 * // ── Loft: seção quadrada → seção circular ─────────────────────────────────
 * const square = [ v(0,0,0), v(4,0,0), v(4,4,0), v(0,4,0) ];
 * const circ32 = Array.from({ length:32 }, (_,i) => {
 *   const a = (2*Math.PI*i)/32;
 *   return new THREE.Vector3(2+2*Math.cos(a), 2+2*Math.sin(a), 10);
 * });
 * const body = (await VolumeBuilder.create())
 *   .addSketch(square, { origin: new THREE.Vector3(0,0,0), normal: new THREE.Vector3(0,0,1) })
 *   .addSketch(circ32, { origin: new THREE.Vector3(0,0,10), normal: new THREE.Vector3(0,0,1) })
 *   .loft();
 * scene.add(new THREE.Mesh(body.geometry, mat));
 */
export class VolumeBuilder {
  /**
   * @param {VolumeEditorAdvanced} editor   Editor compartilhado entre builders.
   * @param {string|null} solidId           ID do último sólido produzido.
   * @param {string[]}    sketchIds         Sketches acumulados para loft.
   * @param {string|null} lastId            ID da última operação qualquer.
   */
  constructor(editor, solidId = null, sketchIds = [], lastId = null) {
    this._ed = editor;
    this._solidId = solidId;
    this._sketchIds = sketchIds;
    this._lastId = lastId;
  }

  // ── Factory ──────────────────────────────────────────────────────────────

  /** Cria um VolumeBuilder com OCCT inicializado. @returns {Promise<VolumeBuilder>} */
  static async create() {
    const ed = await VolumeEditorAdvanced.create();
    return new VolumeBuilder(ed);
  }

  // ── Sketches ─────────────────────────────────────────────────────────────

  /**
   * Adiciona um sketch planar.
   * O ID é acumulado em `_sketchIds` (usado por `.loft()`).
   *
   * @param {THREE.Vector3[]} points
   * @param {{ origin: THREE.Vector3, normal: THREE.Vector3 }} planeConfig
   * @param {number} [quality=0.1]
   */
  addSketch(points, planeConfig, quality = 0.1) {
    const r = this._ed.addSketch(points, planeConfig, quality);
    if (!r) return this;
    return this._next({ sketchIds: [...this._sketchIds, r.id], lastId: r.id });
  }

  // ── Operações de criação de volume ────────────────────────────────────────

  /**
   * Extruda o sketch mais recentemente adicionado.
   * @param {THREE.Vector3 | number} distanceOrVec
   * @param {{ quality?: number, normal?: THREE.Vector3 }} [options]
   */
  extrude(distanceOrVec, options) {
    const sketchId = this._lastSketch();
    if (!sketchId) {
      console.error("[VolumeBuilder] extrude: nenhum sketch ativo.");
      return this;
    }
    const r = this._ed.extrude(sketchId, distanceOrVec, options);
    if (!r) return this;
    return this._next({ solidId: r.id, sketchIds: [], lastId: r.id });
  }

  /**
   * Revolve o sketch mais recentemente adicionado.
   * @param {{ origin: THREE.Vector3, direction: THREE.Vector3 } | THREE.Line3} axis
   * @param {number} [angleDegrees=360]
   * @param {{ quality?: number }} [options]
   */
  revolve(axis, angleDegrees = 360, options) {
    const sketchId = this._lastSketch();
    if (!sketchId) {
      console.error("[VolumeBuilder] revolve: nenhum sketch ativo.");
      return this;
    }
    const r = this._ed.revolve(sketchId, axis, angleDegrees, options);
    if (!r) return this;
    return this._next({ solidId: r.id, sketchIds: [], lastId: r.id });
  }

  /**
   * Loft pelos sketches acumulados desde o último `.loft()` / `.extrude()` / `.revolve()`.
   * É necessário ter chamado `.addSketch()` pelo menos 2 vezes antes.
   *
   * @param {boolean} [isSolid=true]
   * @param {boolean} [ruled=false]
   * @param {number}  [quality=0.1]
   */
  loft(isSolid = true, ruled = false, quality = 0.1) {
    if (this._sketchIds.length < 2) {
      console.error(
        "[VolumeBuilder] loft: acumule pelo menos 2 sketches antes de chamar .loft().",
      );
      return this;
    }
    const r = this._ed.loft(this._sketchIds, isSolid, ruled, quality);
    if (!r) return this;
    return this._next({ solidId: r.id, sketchIds: [], lastId: r.id });
  }

  // ── Operações booleanas ───────────────────────────────────────────────────

  /**
   * União: this ∪ other.
   * @param {VolumeBuilder | string} other  Outro builder ou solidId.
   * @param {number} [quality=0.1]
   */
  union(other, quality = 0.1) {
    return this._bool("union", other, quality);
  }

  /**
   * Subtração: this − other.
   * @param {VolumeBuilder | string} other  Shape a subtrair.
   * @param {number} [quality=0.1]
   */
  subtract(other, quality = 0.1) {
    return this._bool("subtract", other, quality);
  }

  /**
   * Interseção: this ∩ other.
   * @param {VolumeBuilder | string} other
   * @param {number} [quality=0.1]
   */
  intersect(other, quality = 0.1) {
    return this._bool("intersect", other, quality);
  }

  _bool(method, other, quality) {
    const toolId = other instanceof VolumeBuilder ? other._solidId : other;
    if (!this._solidId || !toolId) {
      console.error(`[VolumeBuilder] ${method}: solid IDs inválidos.`);
      return this;
    }
    const r = this._ed[method](this._solidId, toolId, quality);
    if (!r) return this;
    return this._next({ solidId: r.id, lastId: r.id });
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────

  /** Desfaz a última operação. O builder permanece imutável; o editor é atualizado. */
  undo() {
    this._ed.undo();
    return this;
  }

  /** Refaz a última operação desfeita. */
  redo() {
    this._ed.redo();
    return this;
  }

  // ── Exportação ───────────────────────────────────────────────────────────

  /**
   * Exporta o sólido atual para STEP e dispara o download.
   * @param {string} [filename="modelo.step"]
   * @returns {Promise<this>}  Permite continuar a cadeia após await.
   */
  async step(filename = "modelo.step") {
    await this._ed.exportSTEP(this._solidId, filename);
    return this;
  }

  // ── Getters ──────────────────────────────────────────────────────────────

  /** BufferGeometry da última operação (sketch, extrude, loft, etc.). */
  get geometry() {
    return this._ed.getGeometry(this._lastId);
  }

  /** TopoDS_Shape da última operação. */
  get solid() {
    return this._ed.getShape(this._lastId);
  }

  /**
   * Retorna `{ solid, geometry }` do último sólido no histórico ativo.
   * @returns {{ solid: object, geometry: THREE.BufferGeometry } | null}
   */
  getCurrentSolid() {
    return this._ed.getCurrentSolid();
  }

  /** Histórico serializável das operações ativas (sem handles WASM). */
  get history() {
    return this._ed.history;
  }

  /** `true` se houver operações para desfazer. */
  get canUndo() {
    return this._ed.canUndo;
  }

  /** `true` se houver operações desfeitas para refazer. */
  get canRedo() {
    return this._ed.canRedo;
  }

  // ── Limpeza ──────────────────────────────────────────────────────────────

  /** Libera todos os recursos WASM + BufferGeometries. */
  dispose() {
    this._ed.dispose();
    return this;
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  _next(patch) {
    return new VolumeBuilder(
      this._ed,
      patch.solidId !== undefined ? patch.solidId : this._solidId,
      patch.sketchIds !== undefined ? patch.sketchIds : this._sketchIds,
      patch.lastId !== undefined ? patch.lastId : this._lastId,
    );
  }

  _lastSketch() {
    return this._sketchIds.at(-1) ?? null;
  }
}
