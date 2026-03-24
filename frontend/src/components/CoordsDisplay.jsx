/**
 * src/components/CoordsDisplay.jsx
 *
 * Barra de status inferior que exibe e permite editar as configurações
 * do plano de trabalho, snaps e coordenadas 3D em tempo real.
 *
 * Layout (da esquerda para a direita):
 *   [XY] [XZ] [YZ]  |  [Grid] Space: <valor>  [Snap Grid]
 *   |  X: n  Y: n  Z: n  |  Centro: X:<val> Y:<val> Z:<val>
 *   |  Passo T: <val>  Passo R: <val>°
 *
 * Sub-componentes internos:
 *   AxisField  — campo editável para X, Y ou Z do pivot (clique para editar)
 *   StepField  — campo editável para passo de translação ou rotação
 *   ToggleBtn  — botão de alternância estilizado (ativo/inativo)
 */

import { useState } from "react";

/** Cores usadas nos labels de eixo (padrão Three.js: X=vermelho, Y=verde, Z=azul). */
const AXIS_COLORS = { x: "#f88", y: "#8f8", z: "#88f" };

/** Estilo base dos inputs de edição inline. */
const inputStyle = {
  background: "#2d2d2d",
  color: "#fff",
  border: "1px solid #666",
  fontFamily: "monospace",
  fontSize: "0.8rem",
  padding: "0 2px",
};

/** Estilo do valor exibido (não editando) — cursor de texto para indicar clicabilidade. */
const valueStyle = { cursor: "text", color: "#ddd" };

// ── Sub-componentes ────────────────────────────────────────────────────────────

/**
 * AxisField — exibe o valor de um eixo (X, Y ou Z) do pivot.
 * Ao clicar, torna-se um input numérico inline. Confirma com Enter.
 *
 * @param {object}   props
 * @param {string}   props.axis     - "x" | "y" | "z"
 * @param {number}   props.value    - Valor atual do eixo no pivot
 * @param {function} props.onCommit - Chamado com o novo valor ao confirmar
 */
function AxisField({ axis, value, onCommit }) {
  // `draft` é null quando não está editando, ou a string digitada enquanto edita
  const [draft, setDraft] = useState(null);
  const isEditing = draft !== null;

  /** Valida e envia o valor digitado; retorna ao modo exibição. */
  const commit = () => {
    const val = parseFloat(draft);
    if (!isNaN(val)) onCommit(val);
    setDraft(null);
  };

  return (
    <span style={{ marginRight: 8 }}>
      <span style={{ color: AXIS_COLORS[axis] }}>{axis.toUpperCase()}: </span>
      {isEditing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null); // cancela sem confirmar
          }}
          onBlur={() => setDraft(null)} // cancela ao perder o foco
          style={{ ...inputStyle, width: 52 }}
        />
      ) : (
        <span
          onClick={() => setDraft(value.toFixed(3))} // preenche o draft com o valor atual
          title="Clique para editar"
          style={valueStyle}
        >
          {value.toFixed(3)}
        </span>
      )}
    </span>
  );
}

/**
 * StepField — campo editável para passo de snap (translação ou rotação).
 * Exibe "livre" quando o valor é 0 (snap desativado).
 *
 * @param {object}   props
 * @param {string}   props.label    - Label exibido (ex: "Passo T", "Passo R")
 * @param {number}   props.value    - Valor atual do passo (0 = livre)
 * @param {string}   props.unit     - Unidade exibida após o valor (ex: "" ou "°")
 * @param {function} props.onCommit - Chamado com o novo valor (ou 0 se inválido)
 */
function StepField({ label, value, unit, onCommit }) {
  const [draft, setDraft] = useState(null);
  const isEditing = draft !== null;

  const commit = () => {
    const val = parseFloat(draft);
    // Valor inválido ou zero → desativa o snap (passa 0 para o pai)
    onCommit(!isNaN(val) && val > 0 ? val : 0);
    setDraft(null);
  };

  const display = value > 0 ? `${value}${unit}` : "free";

  return (
    <span style={{ marginRight: 8 }}>
      <span style={{ color: "#aaa" }}>{label}: </span>
      {isEditing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
          }}
          onBlur={() => setDraft(null)}
          style={{ ...inputStyle, width: 48 }}
        />
      ) : (
        <span
          onClick={() => setDraft(value > 0 ? String(value) : "")}
          title="Clique para editar o passo (0 = free)"
          style={valueStyle}
        >
          {display}
        </span>
      )}
    </span>
  );
}

/**
 * ToggleBtn — botão de alternância com estado ativo/inativo.
 * Muda de cor para indicar o estado atual.
 *
 * @param {object}   props
 * @param {string}   props.label   - Texto exibido no botão
 * @param {boolean}  props.active  - Se true, usa estilo "ativo" (verde)
 * @param {function} props.onClick - Callback ao clicar
 */
function ToggleBtn({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "#2a4a2a" : "#2a2a2a",
        color: active ? "#8f8" : "#666",
        border: `1px solid ${active ? "#4a7a4a" : "#444"}`,
        fontFamily: "monospace",
        fontSize: "0.75rem",
        padding: "1px 7px",
        cursor: "pointer",
        borderRadius: 3,
        userSelect: "none",
      }}
    >
      {label}
    </button>
  );
}

/** Separador visual entre grupos de controles. */
const sep = <span style={{ color: "#555" }}>|</span>;

// ── Componente principal ───────────────────────────────────────────────────────

/**
 * CoordsDisplay — barra de status inferior com controles de viewport.
 *
 * @param {object}   props
 * @param {string}   props.coords               - String de coordenadas do cursor ("X: n, Y: n, Z: n")
 * @param {{x,y,z}}  props.center               - Posição atual do pivot
 * @param {function} props.onCenterSet           - Chamado com novo {x,y,z} ao editar
 * @param {number}   props.translationSnap       - Passo de translação atual (0 = livre)
 * @param {number}   props.rotationSnap          - Passo de rotação atual em graus (0 = livre)
 * @param {function} props.onTranslationSnapChange
 * @param {function} props.onRotationSnapChange
 * @param {boolean}  props.gridVisible           - Visibilidade do grid
 * @param {function} props.onGridToggle
 * @param {boolean}  props.gridSnap              - Se o snap está travado no espaçamento do grid
 * @param {function} props.onGridSnapToggle
 * @param {number}   props.gridSize              - Espaçamento atual do grid
 * @param {function} props.onGridSizeChange
 * @param {string}   props.activePlane           - Plano ativo: "XY" | "XZ" | "YZ"
 * @param {function} props.onPlaneChange
 */
export default function CoordsDisplay({
  coords,
  center,
  onCenterSet,
  translationSnap,
  rotationSnap,
  onTranslationSnapChange,
  onRotationSnapChange,
  gridVisible,
  onGridToggle,
  gridSnap,
  onGridSnapToggle,
  gridSize,
  onGridSizeChange,
  activePlane,
  onPlaneChange,
  workPlaneControls,
  onWorkPlaneControlsToggle,
}) {
  return (
    <div
      style={{
        height: "28px",
        background: "#1e1e1e",
        color: "#ccc",
        fontFamily: "monospace",
        fontSize: "0.8rem",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        borderTop: "1px solid #444",
        userSelect: "none",
        flexShrink: 0,
        gap: 10,
      }}
    >
      {/* Seleção do plano de trabalho */}
      {["XY", "XZ", "YZ"].map((p) => (
        <ToggleBtn
          key={p}
          label={p}
          active={activePlane === p}
          onClick={() => onPlaneChange(p)}
        />
      ))}

      {sep}

      {/* Toggle dos controles do plano de trabalho */}
      <ToggleBtn
        label="Controls"
        active={workPlaneControls}
        onClick={onWorkPlaneControlsToggle}
      />

      {sep}

      {/* Controles de grid */}
      <ToggleBtn label="Grid" active={gridVisible} onClick={onGridToggle} />
      <StepField
        label="Space"
        value={gridSize}
        unit=""
        onCommit={onGridSizeChange}
      />
      <ToggleBtn
        label="Snap Grid"
        active={gridSnap}
        onClick={onGridSnapToggle}
      />

      {sep}

      {/* Coordenadas 3D do cursor (atualizadas em tempo real pelo ThreeCanvas) */}
      <span style={{ color: "#888" }}>{coords}</span>

      {sep}

      {/* Posição editável do pivot (centro do plano de trabalho) */}
      <span style={{ color: "#777" }}>Center:</span>
      {["x", "y", "z"].map((axis) => (
        <AxisField
          key={axis}
          axis={axis}
          value={center[axis]}
          onCommit={(val) => onCenterSet({ ...center, [axis]: val })}
        />
      ))}

      {sep}

      {/* Passos de snap de translação e rotação */}
      <StepField
        label="Step T"
        value={translationSnap}
        unit="m"
        onCommit={onTranslationSnapChange}
      />
      <StepField
        label="Step R"
        value={rotationSnap}
        unit="°"
        onCommit={onRotationSnapChange}
      />
    </div>
  );
}
