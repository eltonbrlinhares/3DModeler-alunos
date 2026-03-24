/**
 * src/components/VolumeEditorUI.jsx
 *
 * Painel lateral de edição volumétrica 3D integrado ao kernel OpenCascade (OCCT/WASM).
 * Aparece à direita da viewport quando o botão "3D" da Toolbar está ativo.
 *
 * Fluxo de uso típico:
 *   1. Usuário seleciona Polilinha (PL) ou Spline (SP) na Toolbar
 *   2. Desenha um contorno no plano de trabalho e pressiona Enter
 *   3. ThreeGrid captura o sketch e passa via prop `pendingSketch`
 *   4. VolumeEditorUI converte os pontos em uma face OCCT (`addSketch`)
 *   5. Usuário escolhe Extrudar, Revolucionar ou Loft para gerar o sólido
 *   6. Operações booleanas (União/Subtração/Interseção) combinam sólidos
 *   7. Exporta para STEP (compatível com GiD) via botão "Exportar STEP"
 *
 * Internamente usa `VolumeEditorAdvanced` (subclasse de `VolumeEditor`) que
 * mantém um histórico de operações com suporte a Undo/Redo.
 * Cada operação produz um `THREE.Mesh` que é adicionado/removido da cena via `canvasRef`.
 *
 * Props:
 *   canvasRef        — ref para ThreeCanvas (expõe getScene / getPivot)
 *   pendingSketch    — { points, planeConfig } enviado pelo ThreeCanvas ao commitar desenho
 *   onSketchConsumed — callback chamado depois que o sketch pendente for processado
 */
import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { VolumeEditorAdvanced, initOCCT } from "../occt/VolumeEditorAdvanced.js";

// ── Constantes ─────────────────────────────────────────────────────────────────

/** Largura do painel lateral em pixels. */
const PANEL_W = 268;

/** Ícone Unicode associado a cada tipo de operação (exibido no histórico). */
const OP_ICONS = {
  sketch:   "✏",
  extrude:  "↑",
  revolve:  "↻",
  loft:     "⇑",
  fuse:     "∪",
  cut:      "∖",
  common:   "∩",
  solidify: "◈",
};

/** Label traduzido de cada tipo de operação (exibido no histórico e nas mensagens). */
const OP_LABELS = {
  sketch:   "Sketch",
  extrude:  "Extrudar",
  revolve:  "Revolucionar",
  loft:     "Loft",
  fuse:     "União",
  cut:      "Subtração",
  common:   "Interseção",
  solidify: "Solidificar",
};

/**
 * Eixos de revolução pré-definidos (origem na origem do mundo).
 * Usados pelo `handleRevolve` quando o usuário seleciona X, Y ou Z.
 */
const AXIS_PRESETS = {
  X: { origin: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(1, 0, 0) },
  Y: { origin: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 1, 0) },
  Z: { origin: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 0, 1) },
};

/**
 * Material compartilhado para todos os sólidos exibidos na cena.
 * DoubleSide permite ver o interior em casos de sólidos parcialmente abertos.
 */
const SOLID_MAT = new THREE.MeshStandardMaterial({
  color: 0x4488cc,
  metalness: 0.15,
  roughness: 0.6,
  side: THREE.DoubleSide,
});

// ── Estilos ───────────────────────────────────────────────────────────────────
// Objeto centralizado de estilos inline. Usar funções para estilos dinâmicos
// (com parâmetro `active`) evita recriar objetos a cada render.

const S = {
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    width: PANEL_W,
    height: "100%",
    background: "#181818",
    borderLeft: "1px solid #333",
    display: "flex",
    flexDirection: "column",
    zIndex: 20,
    fontFamily: "monospace",
    fontSize: "0.78rem",
    color: "#ccc",
    userSelect: "none",
    overflow: "hidden",
  },
  header: {
    padding: "8px 10px",
    background: "#1e1e1e",
    borderBottom: "1px solid #333",
    fontWeight: "bold",
    fontSize: "0.85rem",
    color: "#8af",
    letterSpacing: "0.05em",
  },
  section: {
    padding: "6px 8px 4px",
    borderBottom: "1px solid #2a2a2a",
  },
  sectionTitle: {
    color: "#666",
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 4,
  },
  row: {
    display: "flex",
    gap: 4,
    marginBottom: 4,
  },
  btn: (active, color = "#4a7abf") => ({
    flex: 1,
    padding: "4px 6px",
    background: active ? "#1a2a3a" : "#252525",
    color: active ? "#6af" : "#999",
    border: `1px solid ${active ? color : "#383838"}`,
    borderRadius: 3,
    cursor: "pointer",
    fontSize: "0.75rem",
    fontFamily: "monospace",
  }),
  btnDanger: {
    flex: 1,
    padding: "4px 6px",
    background: "#252525",
    color: "#f66",
    border: "1px solid #4a1a1a",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: "0.75rem",
    fontFamily: "monospace",
  },
  btnGreen: (active) => ({
    flex: 1,
    padding: "4px 6px",
    background: active ? "#1a2e1a" : "#252525",
    color: active ? "#4f4" : "#999",
    border: `1px solid ${active ? "#3a7a3a" : "#383838"}`,
    borderRadius: 3,
    cursor: "pointer",
    fontSize: "0.75rem",
    fontFamily: "monospace",
  }),
  label: { color: "#888", marginBottom: 2, display: "block" },
  input: {
    width: "100%",
    background: "#222",
    color: "#ddd",
    border: "1px solid #444",
    borderRadius: 3,
    padding: "2px 5px",
    fontFamily: "monospace",
    fontSize: "0.78rem",
    boxSizing: "border-box",
  },
  slider: { width: "100%", accentColor: "#4a7abf" },
  historyList: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 0",
  },
  historyItem: (active) => ({
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 8px",
    background: active ? "#1a2a3a" : "transparent",
    borderLeft: `3px solid ${active ? "#4a7abf" : "transparent"}`,
    cursor: "pointer",
    color: active ? "#8af" : "#888",
  }),
  status: {
    padding: "5px 8px",
    background: "#111",
    borderTop: "1px solid #2a2a2a",
    color: "#777",
    fontSize: "0.72rem",
    minHeight: 28,
  },
  undoBar: {
    display: "flex",
    gap: 4,
    padding: "5px 8px",
    borderTop: "1px solid #2a2a2a",
  },
};

// ── Helpers de malha 3D ───────────────────────────────────────────────────────

/**
 * Cria um `THREE.Mesh` a partir de uma BufferGeometry OCCT e o adiciona à cena.
 * Registra o mesh no `meshMap` (opId → Mesh) para remoção futura.
 *
 * @param {THREE.Scene}          scene
 * @param {THREE.BufferGeometry} geometry - Geometria triangulada pelo OCCT
 * @param {string}               id       - ID da operação (usado como mesh.name)
 * @param {Map<string, THREE.Mesh>} meshMap
 */
function addMeshToScene(scene, geometry, id, meshMap) {
  if (!geometry || !scene) return;
  const mesh = new THREE.Mesh(geometry, SOLID_MAT);
  mesh.name = id;
  scene.add(mesh);
  meshMap.set(id, mesh);
}

/**
 * Remove o mesh associado ao `id` da cena e do `meshMap`.
 * Chamado antes de substituir uma operação por outra (ex: sketch → sólido extrudado).
 *
 * @param {THREE.Scene}             scene
 * @param {string}                  id
 * @param {Map<string, THREE.Mesh>} meshMap
 */
function removeMeshFromScene(scene, id, meshMap) {
  const mesh = meshMap.get(id);
  if (mesh) {
    scene.remove(mesh);
    meshMap.delete(id);
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * VolumeEditorUI — painel de edição 3D integrado ao Three.js via canvasRef.
 *
 * Props:
 *   canvasRef        — ref para ThreeCanvas (expõe getScene / getPivot)
 *   pendingSketch    — { points, planeConfig } enviado pelo ThreeCanvas ao commitar desenho
 *   onSketchConsumed — callback chamado depois que o sketch pendente for processado
 */
export default function VolumeEditorUI({ canvasRef, pendingSketch, onSketchConsumed }) {
  // ── Refs do engine OCCT ──────────────────────────────────────────────────
  /** Instância de VolumeEditorAdvanced (inicializada de forma assíncrona). */
  const edRef   = useRef(null);
  /** Mapa de opId → THREE.Mesh para gerenciar os sólidos na cena. */
  const meshMap = useRef(new Map());

  // ── Estado da UI ─────────────────────────────────────────────────────────
  /** true após o OCCT/WASM terminar de carregar. */
  const [ready,      setReady]      = useState(false);
  /** Mensagem exibida na barra de status inferior do painel. */
  const [status,     setStatus]     = useState("Inicializando OpenCascade...");
  /** Lista de operações do histórico para exibição: [{id, type, label}] */
  const [history,    setHistory]    = useState([]);
  /** ID da operação selecionada no histórico (base para extrudar, boolean, etc.). */
  const [selectedId, setSelectedId] = useState(null);
  /** Operação booleana em andamento: "fuse" | "cut" | "common" | null */
  const [activeOp,   setActiveOp]   = useState(null);
  /** Parâmetros editáveis pelo usuário (distância de extrusão, ângulo e eixo de revolução). */
  const [params,     setParams]     = useState({ distance: 20, angle: 360, axis: "Y" });
  /** ID do segundo sólido selecionado numa operação booleana (o "tool shape"). */
  const [boolTarget, setBoolTarget] = useState(null);

  // ── Inicialização do OCCT (executa uma vez ao montar) ─────────────────────

  useEffect(() => {
    let cancelled = false;

    // `VolumeEditorAdvanced.create()` inicializa o kernel WASM de forma assíncrona.
    // Isso pode levar alguns segundos na primeira carga (carrega ~30 MB de WASM).
    VolumeEditorAdvanced.create().then((ed) => {
      if (cancelled) { ed.dispose(); return; }
      edRef.current = ed;
      setReady(true);
      setStatus("Pronto. Clique em 'Nova Sketch' e desenhe no grid.");
    }).catch((e) => {
      setStatus("Erro OCCT: " + e.message);
    });

    return () => {
      cancelled = true;
      // Remove todos os meshes da cena ao desmontar o painel
      const scene = canvasRef.current?.getScene();
      if (scene) {
        meshMap.current.forEach((mesh) => scene.remove(mesh));
      }
      // Libera shapes OCCT do heap WASM
      edRef.current?.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Atualização do histórico exibido ─────────────────────────────────────

  /**
   * Lê o histórico do VolumeEditor e atualiza o state para re-renderizar a lista.
   * Chamado após cada operação (addSketch, extrude, revolve, loft, undo, redo).
   * `useCallback` garante referência estável para o array de dependências dos effects.
   */
  const refreshHistory = useCallback(() => {
    const ed = edRef.current;
    if (!ed) return;
    setHistory(ed.history.map((op) => ({
      id:    op.id,
      type:  op.type,
      label: `${OP_ICONS[op.type] ?? "?"} ${OP_LABELS[op.type] ?? op.type}`,
    })));
  }, []);

  // ── Consumo do sketch pendente vindo do ThreeCanvas ──────────────────────

  /**
   * Disparado quando ThreeGrid recebe um sketch (pontos + planeConfig) do canvas
   * e o passa via prop `pendingSketch`. Converte os pontos em uma face OCCT,
   * adiciona o mesh à cena e limpa o sketch pendente via `onSketchConsumed`.
   */
  useEffect(() => {
    if (!pendingSketch || !ready) return;
    const ed = edRef.current;
    const scene = canvasRef.current?.getScene();
    if (!ed || !scene) return;

    const { points, planeConfig } = pendingSketch;
    setStatus(`Adicionando sketch com ${points.length} pontos...`);

    const r = ed.addSketch(points, planeConfig);
    if (r) {
      addMeshToScene(scene, r.geometry, r.id, meshMap.current);
      setSelectedId(r.id);
      refreshHistory();
      setStatus(`Sketch adicionado (${points.length} pts). Escolha uma operação de volume.`);
    } else {
      setStatus("Falha ao criar sketch. Tente com mais pontos.");
    }

    onSketchConsumed?.();
  }, [pendingSketch, ready, canvasRef, refreshHistory, onSketchConsumed]);

  // ── Helper de cena ────────────────────────────────────────────────────────

  /** Atalho para obter a THREE.Scene atual (pode ser null se o canvas desmontou). */
  const getScene = () => canvasRef.current?.getScene();

  // ── Operações volumétricas ────────────────────────────────────────────────

  const handleExtrude = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene || !selectedId) {
      setStatus("Selecione um sketch no histórico antes de extrudar.");
      return;
    }
    setStatus("Extrudando...");
    const r = ed.extrude(selectedId, params.distance);
    if (!r) { setStatus("Falha na extrusão. Verifique o sketch selecionado."); return; }
    removeMeshFromScene(scene, selectedId, meshMap.current);
    addMeshToScene(scene, r.geometry, r.id, meshMap.current);
    setSelectedId(r.id);
    refreshHistory();
    setStatus(`Sólido extrudado ${params.distance} u. (ID: ${r.id.split("_")[1]})`);
  };

  const handleRevolve = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene || !selectedId) {
      setStatus("Selecione um sketch no histórico antes de revolucionar.");
      return;
    }
    const axis = AXIS_PRESETS[params.axis] ?? AXIS_PRESETS.Y;
    setStatus("Revolucionando...");
    const r = ed.revolve(selectedId, axis, params.angle);
    if (!r) { setStatus("Falha na revolução."); return; }
    removeMeshFromScene(scene, selectedId, meshMap.current);
    addMeshToScene(scene, r.geometry, r.id, meshMap.current);
    setSelectedId(r.id);
    refreshHistory();
    setStatus(`Sólido revolucionado ${params.angle}° em torno de ${params.axis}.`);
  };

  const handleLoft = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene) return;

    // Collect all sketch IDs currently active in history
    const sketchIds = ed.history.filter((op) => op.type === "sketch").map((op) => op.id);
    if (sketchIds.length < 2) {
      setStatus("Loft requer pelo menos 2 sketches no histórico.");
      return;
    }
    setStatus("Criando loft...");
    const r = ed.loft(sketchIds);
    if (!r) { setStatus("Falha no loft."); return; }
    sketchIds.forEach((id) => removeMeshFromScene(scene, id, meshMap.current));
    addMeshToScene(scene, r.geometry, r.id, meshMap.current);
    setSelectedId(r.id);
    refreshHistory();
    setStatus(`Loft criado entre ${sketchIds.length} perfis.`);
  };

  /**
   * Inicia uma operação booleana de dois passos:
   *   1. Usuário clica em "União/Subtração/Interseção" com um shape BASE selecionado
   *   2. `startBoolOp` registra a operação pendente em `activeOp`
   *   3. Usuário clica num segundo shape no histórico → vira `boolTarget`
   *   4. `confirmBoolOp` executa a operação com BASE (selectedId) e TOOL (boolTarget)
   */
  const startBoolOp = (opName) => {
    if (!selectedId) {
      setStatus("Selecione o shape BASE no histórico, depois clique na operação booleana.");
      return;
    }
    setActiveOp(opName);
    setBoolTarget(null);
    setStatus(`Operação: ${OP_LABELS[opName]}. Agora selecione o shape FERRAMENTA no histórico.`);
  };

  const confirmBoolOp = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene || !activeOp || !selectedId || !boolTarget) {
      setStatus("Selecione base e ferramenta antes de confirmar.");
      return;
    }
    setStatus(`Executando ${OP_LABELS[activeOp]}...`);
    let r = null;
    if (activeOp === "fuse")   r = ed.union(selectedId, boolTarget);
    if (activeOp === "cut")    r = ed.subtract(selectedId, boolTarget);
    if (activeOp === "common") r = ed.intersect(selectedId, boolTarget);
    if (!r) { setStatus("Falha na operação booleana."); return; }
    removeMeshFromScene(scene, selectedId, meshMap.current);
    removeMeshFromScene(scene, boolTarget, meshMap.current);
    addMeshToScene(scene, r.geometry, r.id, meshMap.current);
    setSelectedId(r.id);
    setBoolTarget(null);
    setActiveOp(null);
    refreshHistory();
    setStatus(`${OP_LABELS[activeOp]} concluída.`);
  };

  const cancelBoolOp = () => {
    setActiveOp(null);
    setBoolTarget(null);
    setStatus("Operação booleana cancelada.");
  };

  /**
   * Trata clique em item do histórico:
   *   - Modo normal: seleciona o item como operação base
   *   - Modo booleano (activeOp ativo): o segundo clique define o shape "ferramenta"
   */
  const handleHistoryClick = (id) => {
    if (activeOp && selectedId && id !== selectedId) {
      // Segundo clique no modo booleano → define o shape ferramenta
      setBoolTarget(id);
      setStatus(`Ferramenta selecionada. Clique em 'Confirmar' para executar.`);
    } else {
      setSelectedId(id);
    }
  };

  const handleUndo = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene) return;
    const r = ed.undo();
    if (!r) { setStatus("Nada para desfazer."); return; }
    removeMeshFromScene(scene, r.id, meshMap.current);
    setSelectedId(null);
    refreshHistory();
    setStatus(`Desfeito: ${OP_LABELS[r.type] ?? r.type}`);
  };

  const handleRedo = () => {
    const ed = edRef.current;
    const scene = getScene();
    if (!ed || !scene) return;
    const r = ed.redo();
    if (!r) { setStatus("Nada para refazer."); return; }
    if (r.geometry) {
      addMeshToScene(scene, r.geometry, r.id, meshMap.current);
      setSelectedId(r.id);
    }
    refreshHistory();
    setStatus(`Refeito: ${OP_LABELS[r.type] ?? r.type}`);
  };

  const handleExportSTEP = async () => {
    const ed = edRef.current;
    if (!ed) return;
    setStatus("Exportando STEP...");
    try {
      const blob = await ed.exportSTEP(selectedId || undefined, "modelo.step");
      setStatus(blob ? "STEP exportado com sucesso." : "Nenhum sólido disponível para exportar.");
    } catch (e) {
      setStatus("Erro ao exportar STEP: " + e.message);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  /** Atalhos para leitura/escrita de `params` sem repetição de código. */
  const p    = params;
  const setP = (key, val) => setParams((prev) => ({ ...prev, [key]: val }));

  return (
    <div style={S.panel}>
      {/* Header */}
      <div style={S.header}>◈ Editor de Volume 3D</div>

      {/* Sketch section */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Sketch</div>
        <div style={S.row}>
          <button
            style={S.btn(false)}
            title="Desenhe uma polilinha/spline no grid e pressione Enter"
            onClick={() => setStatus("Selecione ferramenta Polilinha ou Spline, desenhe e pressione Enter.")}
          >
            + Nova Sketch
          </button>
        </div>
        <div style={{ color: "#555", fontSize: "0.7rem", lineHeight: 1.4 }}>
          Use Polilinha (PL) ou Spline (SP) na barra esquerda.
          Enter ou duplo-clique para confirmar.
        </div>
      </div>

      {/* Volume section */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Volume</div>

        {/* Extrude params */}
        <label style={S.label}>
          Distância: <strong style={{ color: "#ddd" }}>{p.distance}</strong> u
        </label>
        <input
          type="range"
          min={0.1} max={200} step={0.1}
          value={p.distance}
          onChange={(e) => setP("distance", parseFloat(e.target.value))}
          style={S.slider}
        />
        <input
          type="number"
          min={0.1} step={0.1}
          value={p.distance}
          onChange={(e) => setP("distance", parseFloat(e.target.value) || 1)}
          style={{ ...S.input, marginBottom: 6 }}
        />

        <div style={S.row}>
          <button style={S.btn(!ready || !selectedId)} onClick={handleExtrude} disabled={!ready}>
            ↑ Extrudar
          </button>
        </div>

        {/* Revolve params */}
        <label style={S.label}>
          Ângulo: <strong style={{ color: "#ddd" }}>{p.angle}°</strong>
        </label>
        <input
          type="range"
          min={1} max={360} step={1}
          value={p.angle}
          onChange={(e) => setP("angle", parseFloat(e.target.value))}
          style={S.slider}
        />
        <label style={S.label}>Eixo de revolução</label>
        <div style={{ ...S.row, marginBottom: 6 }}>
          {["X", "Y", "Z"].map((ax) => (
            <button
              key={ax}
              style={S.btn(p.axis === ax)}
              onClick={() => setP("axis", ax)}
            >
              {ax}
            </button>
          ))}
        </div>

        <div style={S.row}>
          <button style={S.btn(!ready || !selectedId)} onClick={handleRevolve} disabled={!ready}>
            ↻ Revolucionar
          </button>
        </div>

        {/* Loft */}
        <div style={{ ...S.row, marginTop: 4 }}>
          <button style={S.btn(false)} onClick={handleLoft} disabled={!ready}>
            ⇑ Loft (todos sketches)
          </button>
        </div>
      </div>

      {/* Boolean section */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Booleanas</div>
        {activeOp ? (
          <>
            <div style={{ color: "#fa4", fontSize: "0.72rem", marginBottom: 4 }}>
              {boolTarget
                ? `Base: ${selectedId?.split("_")[1]} / Ferramenta: ${boolTarget?.split("_")[1]}`
                : "Selecione o shape FERRAMENTA no histórico abaixo."}
            </div>
            <div style={S.row}>
              <button style={S.btnGreen(!!boolTarget)} onClick={confirmBoolOp} disabled={!boolTarget}>
                ✓ Confirmar
              </button>
              <button style={S.btnDanger} onClick={cancelBoolOp}>✕ Cancelar</button>
            </div>
          </>
        ) : (
          <div style={S.row}>
            <button style={S.btn(false)} onClick={() => startBoolOp("fuse")}   disabled={!ready}>∪ União</button>
            <button style={S.btn(false)} onClick={() => startBoolOp("cut")}    disabled={!ready}>∖ Subtr.</button>
            <button style={S.btn(false)} onClick={() => startBoolOp("common")} disabled={!ready}>∩ Inters.</button>
          </div>
        )}
      </div>

      {/* History */}
      <div style={{ ...S.section, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={S.sectionTitle}>
          Histórico ({history.length} op{history.length !== 1 ? "s" : ""})
        </div>
        <div style={S.historyList}>
          {history.length === 0 && (
            <div style={{ padding: "4px 8px", color: "#444" }}>— vazio —</div>
          )}
          {history.map((op) => {
            const isBase = op.id === selectedId;
            const isTool = op.id === boolTarget;
            return (
              <div
                key={op.id}
                style={{
                  ...S.historyItem(isBase),
                  color: isTool ? "#fa4" : isBase ? "#8af" : "#777",
                  borderLeft: `3px solid ${isTool ? "#fa4" : isBase ? "#4a7abf" : "transparent"}`,
                }}
                onClick={() => handleHistoryClick(op.id)}
                title={op.id}
              >
                <span style={{ fontSize: "1rem" }}>{OP_ICONS[op.type] ?? "?"}</span>
                <span>{OP_LABELS[op.type] ?? op.type}</span>
                <span style={{ marginLeft: "auto", color: "#444", fontSize: "0.68rem" }}>
                  #{op.id.split("_")[1]}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Export */}
      <div style={S.section}>
        <button
          style={{ ...S.btn(false, "#3a7a3a"), width: "100%", color: "#4f4" }}
          onClick={handleExportSTEP}
          disabled={!ready}
        >
          ⬇ Exportar STEP (GiD)
        </button>
      </div>

      {/* Undo / Redo */}
      <div style={S.undoBar}>
        <button style={S.btn(false)} onClick={handleUndo} disabled={!ready}>
          ← Desfazer
        </button>
        <button style={S.btn(false)} onClick={handleRedo} disabled={!ready}>
          Refazer →
        </button>
      </div>

      {/* Status bar */}
      <div style={S.status}>{status}</div>
    </div>
  );
}
