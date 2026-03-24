/**
 * src/components/ModeIndicator.jsx
 *
 * Overlay de texto no canto superior esquerdo da viewport que exibe:
 *   - O nome da ferramenta ativa e suas instruções de uso
 *   - Atalhos rápidos (Esc = cancelar, C = limpar) quando uma ferramenta de
 *     desenho está ativa
 *
 * É somente leitura — não tem interação, apenas exibe informações.
 *
 * Props:
 *   activeTool {string} — ID da ferramenta ativa (ex: "select", "line")
 */

/**
 * Mapeamento de ID de ferramenta → instrução exibida ao usuário.
 * Aparece no canto superior esquerdo da viewport.
 */
const TOOL_LABELS = {
  select:   "Selecionar",
  line:     "Linha — clique 2 pontos",
  polyline: "Polilinha — clique pontos, Enter ou 2×clique para finalizar",
  arc:      "Arco — clique início, ponto no arco, fim",
  spline:   "Spline — clique pontos, Enter ou 2×clique para finalizar",
};

/**
 * ModeIndicator — indicador de modo flutuante (não interativo).
 *
 * @param {object} props
 * @param {string} props.activeTool - ID da ferramenta ativa
 */
export default function ModeIndicator({ activeTool }) {
  const label = TOOL_LABELS[activeTool] ?? "Selecionar";

  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        left: 10,
        padding: "4px 8px",
        background: "rgba(0,0,0,0.5)",
        color: "#fff",
        fontFamily: "sans-serif",
        fontSize: "0.85rem",
        pointerEvents: "none", // não bloqueia cliques na viewport
        userSelect: "none",
      }}
    >
      {/* Instrução principal da ferramenta */}
      {label}

      {/* Atalhos exibidos apenas quando uma ferramenta de desenho está ativa */}
      {activeTool !== "select" && (
        <span style={{ color: "#aaa", marginLeft: 8 }}>
          Esc = cancelar  |  C = limpar
        </span>
      )}
    </div>
  );
}
