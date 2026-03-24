/**
 * src/components/CurveSubdivDialog.jsx
 *
 * Diálogo modal para configurar a subdivisão de curvas selecionadas.
 *
 * Parâmetros:
 *   subdivisions — número de segmentos (divisões) ao longo da curva
 *   ratio        — razão geométrica entre o último e o primeiro segmento
 *                  1.0 = espaçamento uniforme
 *                  > 1.0 = segmentos crescem do início para o fim
 *                  < 1.0 = segmentos diminuem do início para o fim
 *
 * Os dados são guardados em line.userData.subdivisions e line.userData.ratio
 * para uso posterior na geração de malhas de elementos finitos.
 *
 * Props:
 *   open          {boolean}  — controla a visibilidade do diálogo
 *   onClose       {function} — fecha sem aplicar
 *   onApply       {function(n, ratio)} — aplica e fecha
 *   initialValues {object}   — { subdivisions, ratio } da curva selecionada
 */

import { useState, useEffect } from "react";

const S = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  dialog: {
    background: "#1a1a2e",
    border: "1px solid #2a4a6a",
    borderRadius: 8,
    padding: "20px 24px",
    minWidth: 280,
    color: "#cdd",
    fontFamily: "monospace",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  },
  title: {
    margin: "0 0 16px 0",
    fontSize: "1rem",
    color: "#7dd3fc",
    borderBottom: "1px solid #2a4a6a",
    paddingBottom: 8,
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 14,
  },
  label: {
    fontSize: "0.8rem",
    color: "#8aabb0",
  },
  input: {
    background: "#111827",
    border: "1px solid #2a4a6a",
    borderRadius: 4,
    color: "#e2f8ff",
    padding: "5px 8px",
    fontFamily: "monospace",
    fontSize: "0.9rem",
    width: "100%",
    boxSizing: "border-box",
    marginTop: 2,
  },
  hint: {
    fontSize: "0.72rem",
    color: "#5577aa",
    lineHeight: 1.6,
    marginBottom: 16,
    background: "#111827",
    borderRadius: 4,
    padding: "6px 8px",
  },
  buttons: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
  btnCancel: {
    background: "#222",
    border: "1px solid #444",
    color: "#aaa",
    borderRadius: 4,
    padding: "6px 14px",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "0.82rem",
  },
  btnApply: {
    background: "#1a3a5c",
    border: "1px solid #4a7abf",
    color: "#6af",
    borderRadius: 4,
    padding: "6px 14px",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "0.82rem",
    fontWeight: "bold",
  },
};

export default function CurveSubdivDialog({ open, onClose, onApply, initialValues }) {
  const [subdivisions, setSubdivisions] = useState(10);
  const [ratio, setRatio] = useState(1.0);

  // Sincroniza com os valores da curva selecionada ao abrir
  useEffect(() => {
    if (open) {
      setSubdivisions(initialValues?.subdivisions ?? 10);
      setRatio(initialValues?.ratio ?? 1.0);
    }
  }, [open, initialValues]);

  if (!open) return null;

  const handleApply = () => {
    const n = Math.max(1, Math.round(Number(subdivisions)));
    const r = Math.max(0.01, parseFloat(ratio) || 1.0);
    onApply(n, r);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleApply();
    if (e.key === "Escape") onClose();
  };

  return (
    <div style={S.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.dialog} onKeyDown={handleKeyDown}>
        <h3 style={S.title}>Subdivisão de Curva</h3>

        <div style={S.row}>
          <span style={S.label}>Subdivisões (nº de segmentos)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={subdivisions}
            onChange={(e) => setSubdivisions(e.target.value)}
            style={S.input}
            autoFocus
          />
        </div>

        <div style={S.row}>
          <span style={S.label}>Ratio (último / primeiro segmento)</span>
          <input
            type="number"
            min={0.01}
            step={0.1}
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            style={S.input}
          />
        </div>

        <div style={S.hint}>
          ratio = 1.0 → espaçamento uniforme<br />
          ratio &gt; 1.0 → segmentos crescem inicio→fim<br />
          ratio &lt; 1.0 → segmentos diminuem inicio→fim<br />
          <span style={{ color: "#3a6a9a" }}>
            Dados guardados em userData para geração de malha FEM.
          </span>
        </div>

        <div style={S.buttons}>
          <button onClick={onClose} style={S.btnCancel}>Cancelar</button>
          <button onClick={handleApply} style={S.btnApply}>Aplicar</button>
        </div>
      </div>
    </div>
  );
}
