/**
 * src/components/Toolbar.jsx
 *
 * Barra de ferramentas vertical flutuante posicionada no canto superior esquerdo
 * da viewport 3D.
 *
 * Ferramentas de desenho disponíveis:
 *   ↖  select   — modo de seleção (sem desenho; habilita TransformControls)
 *   L   line     — linha reta (2 cliques)
 *   PL  polyline — polilinha aberta (N cliques + Enter ou duplo-clique)
 *   A   arc      — arco por 3 pontos: início, ponto no arco, fim
 *   SP  spline   — spline interpolante (N cliques + Enter ou duplo-clique)
 *
 * Além das ferramentas, exibe botões para gerar superfície NURBS e abrir o editor 3D.
 *
 * Props:
 *   activeTool   {string}   — ID da ferramenta ativa (ex: "select", "line")
 *   onToolChange {function} — chamado com o ID da nova ferramenta ao clicar
 *   selectedCurveCount {number} — quantidade de curvas atualmente selecionadas
 *   onGenerateSurface {function} — gera superfície a partir das curvas selecionadas
 *   volumeOpen   {boolean}  — true se o painel de volume estiver visível
 *   onVolumeToggle {function} — chamado ao clicar no botão "3D"
 */

/** Definição das ferramentas de desenho exibidas na toolbar. */
const TOOLS = [
  { id: "select", label: "↖", title: "Selecionar" },
  { id: "line", label: "L", title: "Linha (2 pontos)" },
  {
    id: "polyline",
    label: "PL",
    title: "Polilinha (Enter/2×clique para fechar)",
  },
  { id: "arc", label: "A", title: "Arco (3 pontos: início, meio, fim)" },
  { id: "spline", label: "SP", title: "Spline (Enter/2×clique para fechar)" },
];

/**
 * Toolbar — barra de ferramentas de desenho e acesso ao editor de volume.
 */
export default function Toolbar({
  activeTool,
  onToolChange,
  selectedCurveCount,
  onGenerateSurface,
  onOpenSubdiv,
  volumeOpen,
  onVolumeToggle,
  surfaceSelected,
  onOpenMesh,
  onExport,
  onImport,
}) {
  const surfaceEnabled = selectedCurveCount >= 2;
  const subdivEnabled = selectedCurveCount >= 1;
  const meshEnabled = !!surfaceSelected;

  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        left: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        zIndex: 10,
      }}
    >
      {/* Botões das ferramentas de desenho */}
      {TOOLS.map(({ id, label, title }) => {
        const active = activeTool === id;
        return (
          <button
            key={id}
            title={title}
            onClick={() => onToolChange(id)}
            style={{
              width: 44,
              height: 44,
              background: active ? "#1a3a5c" : "#222",
              color: active ? "#6af" : "#aaa",
              border: `1px solid ${active ? "#4a7abf" : "#444"}`,
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: "0.85rem",
              fontWeight: "bold",
              userSelect: "none",
            }}
          >
            {label}
          </button>
        );
      })}

      {/* Separador visual */}
      <div style={{ height: 1, background: "#444", margin: "4px 0" }} />

      <button
        title={
          surfaceEnabled
            ? `Gerar superfície NURBS com ${selectedCurveCount} curvas selecionadas`
            : "Selecione ao menos 2 curvas para gerar a superfície"
        }
        onClick={onGenerateSurface}
        disabled={!surfaceEnabled}
        style={{
          width: 44,
          height: 44,
          background: surfaceEnabled ? "#2b2338" : "#222",
          color: surfaceEnabled ? "#d8b4fe" : "#666",
          border: `1px solid ${surfaceEnabled ? "#8b5cf6" : "#444"}`,
          borderRadius: 4,
          cursor: surfaceEnabled ? "pointer" : "not-allowed",
          fontFamily: "monospace",
          fontSize: "0.72rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        SF
      </button>

      {/* Botão de subdivisão de curva */}
      <button
        title={
          subdivEnabled
            ? "Subdivisão de curva (FEM)"
            : "Selecione ao menos 1 curva para configurar subdivisão"
        }
        onClick={onOpenSubdiv}
        disabled={!subdivEnabled}
        style={{
          width: 44,
          height: 44,
          background: subdivEnabled ? "#1a2e1a" : "#222",
          color: subdivEnabled ? "#00ffaa" : "#666",
          border: `1px solid ${subdivEnabled ? "#00aa66" : "#444"}`,
          borderRadius: 4,
          cursor: subdivEnabled ? "pointer" : "not-allowed",
          fontFamily: "monospace",
          fontSize: "0.65rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        SBD
      </button>

      {/* Botão de malha FEM de superfície */}
      <button
        title={
          meshEnabled
            ? "Gerar malha de elementos finitos na superfície selecionada"
            : "Selecione uma superfície para gerar malha FEM"
        }
        onClick={onOpenMesh}
        disabled={!meshEnabled}
        style={{
          width: 44,
          height: 44,
          background: meshEnabled ? "#1a2436" : "#222",
          color: meshEnabled ? "#38bdf8" : "#666",
          border: `1px solid ${meshEnabled ? "#0ea5e9" : "#444"}`,
          borderRadius: 4,
          cursor: meshEnabled ? "pointer" : "not-allowed",
          fontFamily: "monospace",
          fontSize: "0.72rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        MSH
      </button>

      {/* Botão de toggle do Editor de Volume 3D (OCCT) */}
      <button
        title="Editor de Volume 3D (OCCT)"
        onClick={onVolumeToggle}
        style={{
          width: 44,
          height: 44,
          background: volumeOpen ? "#1a3a1a" : "#222",
          color: volumeOpen ? "#4f4" : "#aaa",
          border: `1px solid ${volumeOpen ? "#3a7a3a" : "#444"}`,
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: "0.75rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        3D
      </button>

      {/* Separador visual */}
      <div style={{ height: 1, background: "#444", margin: "4px 0" }} />

      {/* Exportar modelo para JSON */}
      <button
        title="Exportar modelo (curvas, superfícies, malhas) para arquivo JSON"
        onClick={onExport}
        style={{
          width: 44,
          height: 44,
          background: "#1a2a1a",
          color: "#86efac",
          border: "1px solid #22c55e",
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: "0.65rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        EXP
      </button>

      {/* Importar modelo de JSON */}
      <button
        title="Importar modelo (curvas, superfícies, malhas) de arquivo JSON"
        onClick={onImport}
        style={{
          width: 44,
          height: 44,
          background: "#1a1a2a",
          color: "#93c5fd",
          border: "1px solid #3b82f6",
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: "0.65rem",
          fontWeight: "bold",
          userSelect: "none",
        }}
      >
        IMP
      </button>
    </div>
  );
}
