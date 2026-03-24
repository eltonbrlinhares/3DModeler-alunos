/**
 * src/ThreeGrid.jsx
 *
 * Componente raiz da interface de modelagem 3D.
 *
 * Responsabilidades:
 *   - Manter o estado global da UI (ferramenta ativa, configuração de grid, plano, snaps)
 *   - Intermediar a comunicação entre a barra de ferramentas (Toolbar), a viewport
 *     3D (ThreeCanvas) e a barra de status (CoordsDisplay)
 *   - Gerenciar o painel de edição volumétrica (VolumeEditorUI) e o fluxo de
 *     sketches desenhados no canvas até o editor OCCT
 *
 * Arquitetura de comunicação:
 *
 *   ThreeGrid  ──props──▶  Toolbar          (ferramenta ativa, toggle volume)
 *              ──props──▶  ModeIndicator     (label do modo atual)
 *              ──ref────▶  ThreeCanvas       (API imperativa via useImperativeHandle)
 *              ──props──▶  CoordsDisplay     (snaps, grid, plano, centro do pivot)
 *              ──props──▶  VolumeEditorUI    (pendingSketch do canvas → editor OCCT)
 *
 *   ThreeCanvas ──callback──▶ ThreeGrid  (coordenadas do cursor, centro do pivot,
 *                                          sketch comprometido)
 */

import { useState, useRef, useCallback } from "react";
import ThreeCanvas from "./components/ThreeCanvas";
import ModeIndicator from "./components/ModeIndicator";
import CoordsDisplay from "./components/CoordsDisplay";
import Toolbar from "./components/Toolbar";
import VolumeEditorUI from "./components/VolumeEditorUI";
import ViewCube from "./components/ViewCube";
import CurveSubdivDialog from "./components/CurveSubdivDialog";
import SurfaceMeshPanel from "./components/SurfaceMeshPanel";

/**
 * ThreeGrid — componente principal da aplicação.
 *
 * Não recebe props — é a raiz da árvore de componentes (renderizado em App.jsx).
 */
export default function ThreeGrid() {
  // ── Estado da ferramenta de desenho ────────────────────────────────────────
  /** ID da ferramenta ativa: "select" | "line" | "polyline" | "arc" | "spline" */
  const [activeTool, setActiveTool] = useState("select");

  // ── Estado do display de coordenadas (barra inferior) ──────────────────────
  /** String formatada com as coords 3D do cursor ("X: 1.23, Y: 0.00, Z: 4.56") */
  const [coords, setCoords] = useState("X: –, Y: –, Z: –");
  /** Posição atual do pivot (centro do plano de trabalho) */
  const [center, setCenter] = useState({ x: 0, y: 0, z: 0 });

  // ── Estado de snap e grid ──────────────────────────────────────────────────
  /** Passo de translação (0 = livre). Sincronizado com TransformControls. */
  const [translationSnap, setTranslationSnap] = useState(0);
  /** Passo de rotação em graus (0 = livre). Sincronizado com TransformControls. */
  const [rotationSnap, setRotationSnap] = useState(0);
  /** Controla a visibilidade do GridHelper na cena. */
  const [gridVisible, setGridVisible] = useState(true);
  /** Se true, o passo de translação é travado no espaçamento do grid. */
  const [gridSnap, setGridSnap] = useState(false);
  /** Espaçamento entre linhas do grid (em unidades do modelo). */
  const [gridSpacing, setGridSpacing] = useState(1);

  // ── Estado do plano de trabalho ────────────────────────────────────────────
  /** Plano ativo: "XY" (padrão, convenção CAD: Z perpendicular) | "XZ" | "YZ" */
  const [activePlane, setActivePlane] = useState("XY");

  // ── Estado do editor de volume ─────────────────────────────────────────────
  /** Controla se o painel VolumeEditorUI está visível. */
  const [volumeOpen, setVolumeOpen] = useState(false);
  /**
   * Sketch pendente que o ThreeCanvas produziu (ao pressionar Enter ou
   * duplo-clique) e que ainda não foi processado pelo VolumeEditorUI.
   * Formato: { points: THREE.Vector3[], planeConfig: { origin, normal } }
   */
  const [pendingSketch, setPendingSketch] = useState(null);
  /** Quantidade de curvas selecionadas no canvas. */
  const [selectedCurveCount, setSelectedCurveCount] = useState(0);

  // ── Ref para a API imperativa do ThreeCanvas ───────────────────────────────
  /**
   * Expõe métodos do ThreeCanvas sem re-renderizações:
   *   setActiveTool, setCenter, setTranslationSnap, setRotationSnap,
   *   setGridVisible, setGridSize, setPlane, getScene, getPivot
   */
  const canvasRef = useRef();

  // ── Handlers de Toolbar ────────────────────────────────────────────────────

  /**
   * Muda a ferramenta ativa e notifica o ThreeCanvas para cancelar
   * qualquer desenho em andamento e desabilitar TransformControls.
   */
  const handleToolChange = (tool) => {
    setActiveTool(tool);
    canvasRef.current?.setActiveTool(tool);
  };

  // ── Handlers de CoordsDisplay ──────────────────────────────────────────────

  /**
   * Atualiza a posição do pivot quando o usuário edita o campo Centro.
   * O ThreeCanvas move o objeto pivot imediatamente (sem re-render da cena).
   */
  const handleCenterSet = (newCenter) => {
    setCenter(newCenter);
    canvasRef.current?.setCenter(newCenter.x, newCenter.y, newCenter.z);
  };

  /**
   * Atualiza o passo de translação dos TransformControls.
   * Desativa o "Snap Grid" ao editar manualmente o passo.
   */
  const handleTranslationSnapChange = (val) => {
    setTranslationSnap(val);
    setGridSnap(false); // snap manual desliga o "Snap Grid"
    canvasRef.current?.setTranslationSnap(val);
  };

  /** Atualiza o passo de rotação (em graus) dos TransformControls. */
  const handleRotationSnapChange = (val) => {
    setRotationSnap(val);
    canvasRef.current?.setRotationSnap(val);
  };

  /** Alterna a visibilidade do GridHelper na cena. */
  const handleGridToggle = () => {
    const next = !gridVisible;
    setGridVisible(next);
    canvasRef.current?.setGridVisible(next);
  };

  /**
   * Alterna o "Snap Grid": quando ativo, o passo de translação é fixado
   * no espaçamento atual do grid; quando desativado, volta a ser livre (0).
   */
  const handleGridSnapToggle = () => {
    const next = !gridSnap;
    setGridSnap(next);
    const snapVal = next ? gridSpacing : 0;
    setTranslationSnap(snapVal);
    canvasRef.current?.setTranslationSnap(snapVal);
    canvasRef.current?.setGridSnap(next);
  };

  /** Muda o plano de trabalho ativo e reorienta o pivot no ThreeCanvas. */
  const handlePlaneChange = (plane) => {
    setActivePlane(plane);
    canvasRef.current?.setPlane(plane);
  };

  /**
   * Atualiza o tamanho do grid. Se o "Snap Grid" estiver ativo,
   * o passo de translação acompanha automaticamente o novo espaçamento.
   *
   * @param {number} spacing - Espaçamento entre linhas (mínimo 0.01).
   */
  const handleGridSizeChange = (spacing) => {
    const s = Math.max(0.01, spacing);
    setGridSpacing(s);
    if (gridSnap) {
      setTranslationSnap(s);
      canvasRef.current?.setTranslationSnap(s);
    }
    canvasRef.current?.setGridSize(s);
  };

  // ── Handler de sketch comprometido ────────────────────────────────────────

  /**
   * Chamado pelo ThreeCanvas quando o usuário finaliza um desenho (Enter ou
   * duplo-clique). Armazena o sketch em `pendingSketch` para que o
   * VolumeEditorUI o processe e crie a face OCCT correspondente.
   *
   * Usa `useCallback` para manter a referência estável e evitar que o
   * ThreeCanvas re-execute o setup do useEffect.
   *
   * @param {THREE.Vector3[]} points - Pontos do contorno desenhado.
   * @param {{ origin: THREE.Vector3, normal: THREE.Vector3 }} planeConfig
   */
  const handleSketchCommit = useCallback((points, planeConfig) => {
    setPendingSketch({ points, planeConfig });
  }, []);

  /** Alterna o painel de edição volumétrica. */
  const handleVolumeToggle = () => setVolumeOpen((v) => !v);

  /** Gera uma superfície NURBS a partir das curvas selecionadas no canvas. */
  const handleGenerateSurface = () => {
    canvasRef.current?.generateSurfaceFromSelection?.();
  };

  // ── Estado e handlers do diálogo de subdivisão ─────────────────────────────
  const [subdivDialogOpen, setSubdivDialogOpen] = useState(false);
  const [subdivInitialValues, setSubdivInitialValues] = useState(null);

  /** Abre o diálogo lendo os params atuais da(s) curva(s) selecionada(s). */
  const handleOpenSubdivDialog = () => {
    const params = canvasRef.current?.getSelectedSubdivParams?.();
    setSubdivInitialValues(params);
    setSubdivDialogOpen(true);
  };

  /** Aplica os parâmetros de subdivisão às curvas selecionadas e fecha o diálogo. */
  const handleApplySubdiv = (n, ratio) => {
    canvasRef.current?.applySubdivisions?.(n, ratio);
    setSubdivDialogOpen(false);
  };

  // ── Estado da malha FEM de superfície ─────────────────────────────────────
  const [meshPanelOpen, setMeshPanelOpen]       = useState(false);
  const [selectedSurfaceAvail, setSelectedSurfaceAvail] = useState(false);
  const [surfaceSubdivs, setSurfaceSubdivs]     = useState(null);
  const [meshLoading, setMeshLoading]           = useState(false);
  const [meshError, setMeshError]               = useState(null);
  const [meshResult, setMeshResult]             = useState(null);

  const handleSurfaceSelectChange = useCallback((hasSurface) => {
    setSelectedSurfaceAvail(hasSurface);
    if (hasSurface) {
      // lê as subdivisões do contorno logo após a seleção mudar
      setSurfaceSubdivs(canvasRef.current?.getSurfaceBoundarySubdivs?.() ?? null);
    } else {
      setSurfaceSubdivs(null);
      setMeshError(null);
      setMeshResult(null);
    }
  }, []);

  const handleOpenMeshPanel = () => {
    setMeshError(null);
    setMeshResult(null);
    setSurfaceSubdivs(canvasRef.current?.getSurfaceBoundarySubdivs?.() ?? null);
    setMeshPanelOpen(true);
  };

  const handleMeshSurface = async ({ algo, elem_type }) => {
    setMeshLoading(true);
    setMeshError(null);
    setMeshResult(null);
    const res = await canvasRef.current?.meshSurface(algo, { elem_type });
    setMeshLoading(false);
    if (res?.error) setMeshError(res.error);
    else if (res?.ok) setMeshResult({ n_nodes: res.n_nodes, n_elements: res.n_elements });
  };

  // ── Export / Import de modelo ──────────────────────────────────────────────

  /** Exporta o modelo atual para um arquivo JSON disparando o download. */
  const handleExport = () => {
    const data = canvasRef.current?.exportModel?.();
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Abre um seletor de arquivo e importa o modelo JSON. */
  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          const ok = canvasRef.current?.importModel?.(data);
          if (!ok) console.warn("[Import] Falha ao importar modelo: formato inválido.");
        } catch (err) {
          console.error("[Import] Erro ao ler arquivo JSON:", err);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // ── Estado dos controles do plano de trabalho ──────────────────────────────
  const [workPlaneControls, setWorkPlaneControls] = useState(true);

  const handleWorkPlaneControlsToggle = () => {
    const next = !workPlaneControls;
    setWorkPlaneControls(next);
    canvasRef.current?.setWorkPlaneControls(next);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Área principal: viewport 3D + overlays */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Canvas Three.js — ocupa 100% da área disponível */}
        <ThreeCanvas
          ref={canvasRef}
          onCoordsChange={setCoords}
          onCenterChange={setCenter}
          onSketchCommit={handleSketchCommit}
          onToolChange={handleToolChange}
          onSelectionCountChange={setSelectedCurveCount}
          onSurfaceSelectChange={handleSurfaceSelectChange}
        />

        {/* Barra de ferramentas flutuante (canto superior esquerdo) */}
        <Toolbar
          activeTool={activeTool}
          onToolChange={handleToolChange}
          selectedCurveCount={selectedCurveCount}
          onGenerateSurface={handleGenerateSurface}
          onOpenSubdiv={handleOpenSubdivDialog}
          volumeOpen={volumeOpen}
          onVolumeToggle={handleVolumeToggle}
          surfaceSelected={selectedSurfaceAvail}
          onOpenMesh={handleOpenMeshPanel}
          onExport={handleExport}
          onImport={handleImport}
        />

        {/* Diálogo de subdivisão de curvas */}
        <CurveSubdivDialog
          open={subdivDialogOpen}
          onClose={() => setSubdivDialogOpen(false)}
          onApply={handleApplySubdiv}
          initialValues={subdivInitialValues}
        />

        {/* Painel de malha FEM de superfície */}
        <SurfaceMeshPanel
          open={meshPanelOpen}
          hasSurface={selectedSurfaceAvail}
          subdivs={surfaceSubdivs}
          loading={meshLoading}
          error={meshError}
          result={meshResult}
          onGenerate={handleMeshSurface}
          onClose={() => setMeshPanelOpen(false)}
        />

        {/* Indicador do modo atual (topo esquerdo, sobre a Toolbar) */}
        <ModeIndicator activeTool={activeTool} />

        {/* ViewCube — orientação 3D (canto superior direito) */}
        <ViewCube canvasRef={canvasRef} />

        {/* Painel de edição volumétrica (direita) — visível quando volumeOpen */}
        {volumeOpen && (
          <VolumeEditorUI
            canvasRef={canvasRef}
            pendingSketch={pendingSketch}
            onSketchConsumed={() => setPendingSketch(null)}
          />
        )}
      </div>

      {/* Barra de status inferior: coordenadas, snap, grid, plano */}
      <CoordsDisplay
        coords={coords}
        center={center}
        onCenterSet={handleCenterSet}
        translationSnap={translationSnap}
        rotationSnap={rotationSnap}
        onTranslationSnapChange={handleTranslationSnapChange}
        onRotationSnapChange={handleRotationSnapChange}
        gridVisible={gridVisible}
        onGridToggle={handleGridToggle}
        gridSnap={gridSnap}
        onGridSnapToggle={handleGridSnapToggle}
        gridSize={gridSpacing}
        onGridSizeChange={handleGridSizeChange}
        activePlane={activePlane}
        onPlaneChange={handlePlaneChange}
        workPlaneControls={workPlaneControls}
        onWorkPlaneControlsToggle={handleWorkPlaneControlsToggle}
      />
    </div>
  );
}
