/**
 * MeshModule.js
 *
 * Carrega mesh.wasm (compilado via Emscripten a partir do mesh_server C++)
 * e expõe uma API assíncrona que espelha os endpoints do servidor HTTP,
 * mas sem nenhuma requisição de rede — tudo executa no navegador.
 *
 * Padrão de uso:
 *   import { meshModule } from './MeshModule.js';
 *
 *   // Malha 2D bilinear
 *   const result = await meshModule.msh2d.bilinear({
 *     boundary: [0,0, 1,0, 1,0, 1,1, 1,1, 0,1, 0,1, 0,0],  // 4 lados
 *     m: 5, n: 5
 *   });
 *   // result.positions  → Float64Array  [x0,y0,z0, x1,y1,z1, ...]
 *   // result.index      → Int32Array    [i0,i1,...] (0-based)
 *   // result.n_nodes    → número de nós
 *   // result.n_elements → número de elementos
 *   // result.elem_size  → nós por elemento (3, 4, 6, 8 etc.)
 *
 * Convenções:
 *   - Todos os arrays de saída (positions, index) são cópias — seguros para
 *     uso depois que a função retorna.
 *   - Coordenadas de saída: sempre 3D (x,y,z) — malhas 2D têm z=0.
 *   - Índices de saída e entrada: sempre 0-based.
 *   - As chamadas NÃO são thread-safe entre si (WASM single-thread + estado
 *     global nas libs). Use await em sequência ou um Web Worker dedicado.
 */

// mesh.js é um módulo Emscripten IIFE/UMD gerado pelo compilador e servido
// de public/ como asset estático. Vite não permite import estático de arquivos
// em /public — carregamos via <script> tag dinâmica, igual a outros módulos
// Emscripten (ex: opencascade.wasm.js em alguns setups).

/* =========================================================================
 * Estado do módulo (singleton)
 * ======================================================================= */

let _mod = null;
let _initPromise = null;
let _scriptLoaded = false;

/**
 * Injeta mesh.js no documento (UMD/IIFE do Emscripten).
 * Após o carregamento, window.createMeshModule fica disponível.
 */
function loadMeshScript() {
  if (_scriptLoaded) return Promise.resolve();
  _scriptLoaded = true;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/mesh.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('[MeshModule] Falha ao carregar /mesh.js'));
    document.head.appendChild(s);
  });
}

/**
 * Inicializa (ou retorna o já inicializado) módulo WASM de malhas.
 * @returns {Promise<EmscriptenModule>}
 */
async function getModule() {
  if (_mod) return _mod;
  if (_initPromise) return _initPromise;

  _initPromise = loadMeshScript().then(() => {
    // Após o script, window.createMeshModule está disponível
    const factory = window.createMeshModule;
    if (typeof factory !== 'function') {
      throw new Error('[MeshModule] window.createMeshModule não é uma função após carregar /mesh.js');
    }
    return factory({
      locateFile: (path) => `/${path}`,
    });
  }).then((mod) => {
    _mod = mod;
    _initPromise = null;
    console.log('[MeshModule] mesh.wasm inicializado.');
    return mod;
  });

  return _initPromise;
}

/* =========================================================================
 * Helpers de heap WASM
 * ======================================================================= */

/**
 * Aloca um Float64Array no heap WASM e retorna o ponteiro.
 * @param {EmscriptenModule} M
 * @param {ArrayLike<number>} data
 * @returns {number} ponteiro WASM
 */
function allocF64(M, data) {
  const arr = data instanceof Float64Array ? data : new Float64Array(data);
  const ptr = M._malloc(arr.byteLength);
  M.HEAPF64.set(arr, ptr / 8);
  return ptr;
}

/**
 * Aloca um Int32Array no heap WASM e retorna o ponteiro.
 * @param {EmscriptenModule} M
 * @param {ArrayLike<number>} data
 * @returns {number} ponteiro WASM
 */
function allocI32(M, data) {
  const arr = data instanceof Int32Array ? data : new Int32Array(data);
  const ptr = M._malloc(arr.byteLength);
  M.HEAP32.set(arr, ptr / 4);
  return ptr;
}

/**
 * Lê o resultado armazenado no slot global do WASM, copia os arrays e
 * libera a memória C. Deve ser chamado imediatamente após uma função
 * wasm_mshXxx_algo() bem-sucedida.
 *
 * @param {EmscriptenModule} M
 * @returns {{ positions: Float64Array, index: Int32Array, n_nodes: number,
 *             n_elements: number, elem_size: number }}
 */
function readAndFreeResult(M) {
  const nno  = M.ccall('mesh_get_nno',       'number', [], []);
  const nel  = M.ccall('mesh_get_nel',       'number', [], []);
  const esz  = M.ccall('mesh_get_elem_size', 'number', [], []);
  const pPtr = M.ccall('mesh_get_positions', 'number', [], []);
  const iPtr = M.ccall('mesh_get_index',     'number', [], []);

  // Copiar com slice() antes de liberar (o Free invalida os ponteiros)
  const positions = new Float64Array(
    M.HEAPF64.buffer.slice(pPtr, pPtr + nno * 3 * 8)
  );
  const index = new Int32Array(
    M.HEAP32.buffer.slice(iPtr, iPtr + nel * esz * 4)
  );

  M.ccall('mesh_free_last', null, [], []);

  return { positions, index, n_nodes: nno, n_elements: nel, elem_size: esz };
}

/**
 * Padrão para funções simples com entrada (boundary float64) + ints.
 * Aloca boundary no heap, chama fn(M, bry_ptr, ...intArgs), lê resultado.
 */
async function callWithBoundary(fnName, boundary, intArgTypes, intArgs) {
  const M = await getModule();
  const bry = allocF64(M, boundary);
  const ok = M.ccall(fnName, 'number',
    ['number', ...intArgTypes],
    [bry,      ...intArgs]);
  M._free(bry);
  if (!ok) throw new Error(`[MeshModule] ${fnName} falhou.`);
  return readAndFreeResult(M);
}

/* =========================================================================
 * API Pública
 * ======================================================================= */

export const meshModule = {

  /* -----------------------------------------------------------------------
   * msh2d — Malhas 2D
   *
   * boundary: array plano [x0,y0, x1,y1, ...] com 4 lados em ordem:
   *   baixo(m pts) + direita(n pts) + topo(m pts) + esquerda(n pts)
   * --------------------------------------------------------------------- */
  msh2d: {

    /**
     * Mapeamento bilinear transfinito para regiões quadrilaterais.
     * @param {{ boundary: number[], m: number, n: number,
     *           elem_type?: number, diag_type?: number }} p
     */
    async bilinear({ boundary, m, n, elem_type = 4, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_msh2d_bilinear',
        boundary,
        ['number','number','number','number'],
        [m, n, elem_type, diag_type]
      );
    },

    /**
     * Mapeamento bilinear colapsado (região triangular, um lado é ponto).
     */
    async collbilinear({ boundary, m, n, elem_type = 3, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_msh2d_collbilinear',
        boundary,
        ['number','number','number','number'],
        [m, n, elem_type, diag_type]
      );
    },

    /**
     * Lofting linear transfinito entre dois lados opostos.
     * @param {{ boundary, m, n, dir?, weight?, elem_type?, diag_type? }} p
     */
    async loft({ boundary, m, n, dir = 0, weight = 1.0, elem_type = 4, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_msh2d_loft',
        boundary,
        ['number','number','number','number','number','number'],
        [m, n, dir, weight, elem_type, diag_type]
      );
    },

    /**
     * Mapeamento trilinear para regiões triangulares equilaterais.
     * Todos os três lados devem ter o mesmo número de segmentos.
     */
    async trilinear({ boundary, m, elem_type = 3 }) {
      return callWithBoundary(
        'wasm_msh2d_trilinear',
        boundary,
        ['number','number'],
        [m, elem_type]
      );
    },

    /**
     * Triangulação não-estruturada por contração de fronteira.
     * @param {{ loop_segs: number[], boundary: number[], gen_intpts?: number,
     *           qt_flag?: number, elem_type?: number }} p
     */
    async contraction({ loop_segs, boundary, gen_intpts = 1, qt_flag = 1, elem_type = 3 }) {
      const M = await getModule();
      const n_loops = loop_segs.length;
      const segs = allocI32(M, loop_segs);
      const bry  = allocF64(M, boundary);
      const ok = M.ccall('wasm_msh2d_contraction', 'number',
        ['number','number','number','number','number','number'],
        [n_loops, segs, bry, gen_intpts, qt_flag, elem_type]);
      M._free(segs);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_msh2d_contraction falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Malha não-estruturada baseada em quadtree.
     * @param {{ loop_segs, boundary, elem_type?, ref_quad? }} p
     */
    async quadbound({ loop_segs, boundary, elem_type = 3, ref_quad = 1 }) {
      const M = await getModule();
      const n_loops = loop_segs.length;
      const segs = allocI32(M, loop_segs);
      const bry  = allocF64(M, boundary);
      const ok = M.ccall('wasm_msh2d_quadbound', 'number',
        ['number','number','number','number','number'],
        [n_loops, segs, bry, elem_type, ref_quad]);
      M._free(segs);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_msh2d_quadbound falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Triangulação advancing-front + quadtree (T3 ou T6).
     * @param {{ loop_segs, boundary, elem_type? }} p
     */
    async shape({ loop_segs, boundary, elem_type = 3 }) {
      const M = await getModule();
      const n_loops = loop_segs.length;
      const segs = allocI32(M, loop_segs);
      const bry  = allocF64(M, boundary);
      const ok = M.ccall('wasm_msh2d_shape', 'number',
        ['number','number','number','number'],
        [n_loops, segs, bry, elem_type]);
      M._free(segs);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_msh2d_shape falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Malha quadrilateral indireta Q-Morph (Q4 ou Q8).
     * @param {{ loop_segs, boundary, elem_type? }} p
     */
    async seam({ loop_segs, boundary, elem_type = 4 }) {
      const M = await getModule();
      const n_loops = loop_segs.length;
      const segs = allocI32(M, loop_segs);
      const bry  = allocF64(M, boundary);
      const ok = M.ccall('wasm_msh2d_seam', 'number',
        ['number','number','number','number'],
        [n_loops, segs, bry, elem_type]);
      M._free(segs);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_msh2d_seam falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Malha estruturada por template para regiões de 2/3/4 lados.
     * @param {{ n_sides: number, subdivision: number[4], boundary: number[],
     *           dim?: number, elem_type?: number, smooth?: number }} p
     */
    async template({ n_sides, subdivision, boundary, dim = 2, elem_type = 4, smooth = 1 }) {
      const M = await getModule();
      const sub4 = [
        subdivision[0] ?? 0,
        subdivision[1] ?? 0,
        subdivision[2] ?? 0,
        subdivision[3] ?? 0,
      ];
      const sub = allocI32(M, sub4);
      const bry = allocF64(M, boundary);
      const ok = M.ccall('wasm_msh2d_template', 'number',
        ['number','number','number','number','number','number'],
        [n_sides, sub, bry, dim, elem_type, smooth]);
      M._free(sub);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_msh2d_template falhou.');
      return readAndFreeResult(M);
    },
  },

  /* -----------------------------------------------------------------------
   * msh3d — Malhas Volumétricas
   * --------------------------------------------------------------------- */
  msh3d: {

    /**
     * Extrusão de malha 2D ao longo de um vetor.
     * @param {{ direction: number[3], magnitude: number, steps: number,
     *           surface_nodes: number[], surface_index: number[],
     *           surface_elem_size: number }} p
     */
    async extrusion({ direction, magnitude, steps,
                      surface_nodes, surface_index, surface_elem_size }) {
      const M = await getModule();
      const esize = surface_elem_size;
      const np2D  = surface_nodes.length / 2;
      const ne2D  = surface_index.length / esize;

      const dir  = allocF64(M, direction);
      const pts  = allocF64(M, surface_nodes);
      const conn = allocI32(M, surface_index);

      const ok = M.ccall('wasm_msh3d_extrusion', 'number',
        ['number','number','number','number','number','number','number','number'],
        [dir, magnitude, steps, np2D, pts, ne2D, esize, conn]);

      M._free(dir);
      M._free(pts);
      M._free(conn);

      if (!ok) throw new Error('[MeshModule] wasm_msh3d_extrusion falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Sweeping mesh: fonte + alvo + laterais → hexaédrica.
     * @param {{ nodes: number[], faces: number[], idfaces?: number[] }} p
     *   nodes  : [x0,y0,z0, ...] — nós 3D
     *   faces  : [i0,i1,i2,i3, ...] — faces quad (4 índices 0-based por face)
     *   idfaces: [0|1, ...] — 0=lateral, 1=fonte/alvo (opcional)
     */
    async sweeping({ nodes, faces, idfaces }) {
      const M = await getModule();
      const num_node = nodes.length / 3;
      const num_face = faces.length / 4;

      const n_ptr    = allocF64(M, nodes);
      const f_ptr    = allocI32(M, faces);
      const has_idf  = idfaces ? 1 : 0;
      const idf_ptr  = idfaces ? allocI32(M, idfaces) : 0;

      const ok = M.ccall('wasm_msh3d_sweeping', 'number',
        ['number','number','number','number','number','number'],
        [num_node, num_face, n_ptr, f_ptr, idf_ptr, has_idf]);

      M._free(n_ptr);
      M._free(f_ptr);
      if (idf_ptr) M._free(idf_ptr);

      if (!ok) throw new Error('[MeshModule] wasm_msh3d_sweeping falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Mapeamento transfinito entre 2–6 malhas de superfície.
     * @param {{ surfaces: Array<{ id?, divs?, ratio?, nodes, index, elem_size? }> }} p
     *   Todas as superfícies devem ter o mesmo número de nós e elementos.
     */
    async mapp({ surfaces }) {
      const M = await getModule();
      const ns     = surfaces.length;
      const esize  = surfaces[0].elem_size ?? 4;
      const npts   = surfaces[0].nodes.length / 3;
      const nelem  = surfaces[0].index.length / esize;

      const ids    = surfaces.map((s, i) => s.id    ?? (i + 1));
      const divs   = surfaces.map((s)    => s.divs  ?? 1);
      const ratios = surfaces.map((s)    => s.ratio ?? 1.0);

      // Concatenar nós e conectividades de todas as superfícies
      const nodes_flat = new Float64Array(ns * npts * 3);
      const conn_flat  = new Int32Array(ns * nelem * esize);
      for (let i = 0; i < ns; i++) {
        const s = surfaces[i];
        nodes_flat.set(new Float64Array(s.nodes), i * npts * 3);
        conn_flat.set(new Int32Array(s.index),    i * nelem * esize);
      }

      const ids_p    = allocI32(M, ids);
      const divs_p   = allocI32(M, divs);
      const ratios_p = allocF64(M, ratios);
      const nodes_p  = allocF64(M, nodes_flat);
      const conn_p   = allocI32(M, conn_flat);

      const ok = M.ccall('wasm_msh3d_mapp', 'number',
        ['number','number','number','number','number','number','number','number','number'],
        [ns, ids_p, divs_p, ratios_p, npts, nodes_p, nelem, esize, conn_p]);

      M._free(ids_p);
      M._free(divs_p);
      M._free(ratios_p);
      M._free(nodes_p);
      M._free(conn_p);

      if (!ok) throw new Error('[MeshModule] wasm_msh3d_mapp falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Sweep ao longo de uma curva 3D.
     * @param {{ curve_pts: number[], u_dirs: number[][], v_dirs: number[][],
     *           w_dirs: number[][], surface_nodes: number[],
     *           surface_index: number[], surface_elem_size: number }} p
     *   u_dirs/v_dirs/w_dirs: arrays de vetores 3D, um por ponto da curva.
     *   Podem ser passados como array de arrays [[x,y,z], ...] ou plano [x0,y0,z0,...].
     */
    async curvesweep({ curve_pts, u_dirs, v_dirs, w_dirs,
                       surface_nodes, surface_index, surface_elem_size }) {
      const M = await getModule();
      const n_pts_curve = curve_pts.length / 3;
      const esize = surface_elem_size;
      const np2D  = surface_nodes.length / 2;
      const ne2D  = surface_index.length / esize;

      // Montar uvw_flat: [u0x,u0y,u0z, v0x,v0y,v0z, w0x,w0y,w0z, u1x,...] por ponto
      const uvw_flat = new Float64Array(n_pts_curve * 9);
      const toFlat = (dirs) =>
        Array.isArray(dirs[0]) ? dirs.flat() : dirs;
      const uF = toFlat(u_dirs);
      const vF = toFlat(v_dirs);
      const wF = toFlat(w_dirs);
      for (let i = 0; i < n_pts_curve; i++) {
        uvw_flat[i * 9 + 0] = uF[i * 3];     uvw_flat[i * 9 + 1] = uF[i * 3 + 1]; uvw_flat[i * 9 + 2] = uF[i * 3 + 2];
        uvw_flat[i * 9 + 3] = vF[i * 3];     uvw_flat[i * 9 + 4] = vF[i * 3 + 1]; uvw_flat[i * 9 + 5] = vF[i * 3 + 2];
        uvw_flat[i * 9 + 6] = wF[i * 3];     uvw_flat[i * 9 + 7] = wF[i * 3 + 1]; uvw_flat[i * 9 + 8] = wF[i * 3 + 2];
      }

      const crv_p  = allocF64(M, curve_pts);
      const uvw_p  = allocF64(M, uvw_flat);
      const pts_p  = allocF64(M, surface_nodes);
      const conn_p = allocI32(M, surface_index);

      const ok = M.ccall('wasm_msh3d_curvesweep', 'number',
        ['number','number','number','number','number','number','number','number'],
        [n_pts_curve, crv_p, uvw_p, np2D, pts_p, ne2D, esize, conn_p]);

      M._free(crv_p);
      M._free(uvw_p);
      M._free(pts_p);
      M._free(conn_p);

      if (!ok) throw new Error('[MeshModule] wasm_msh3d_curvesweep falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Malha hexaédrica por decomposição em templates (requer rtree).
     * @param {{ surfaces: Array<{ nodes: number[], index: number[], elem_size?: number }> }} p
     *   Tipicamente 6 superfícies Q4. Superfícies podem ter nós/elementos diferentes.
     */
    async template({ surfaces }) {
      const M = await getModule();
      const numfaces = surfaces.length;
      const npoints_per = new Int32Array(surfaces.map(s => s.nodes.length / 3));
      const n_elem_per  = new Int32Array(surfaces.map(s => {
        const esz = s.elem_size ?? 4;
        return s.index.length / esz;
      }));

      const total_nodes_3d = npoints_per.reduce((a, b) => a + b, 0) * 3;
      const total_conn     = surfaces.reduce((acc, s) => {
        const esz = s.elem_size ?? 4;
        return acc + s.index.length;
      }, 0);

      const nodes_flat = new Float64Array(total_nodes_3d);
      const conn_flat  = new Int32Array(total_conn);
      let noff = 0, coff = 0;
      for (const s of surfaces) {
        const nn = new Float64Array(s.nodes);
        const cc = new Int32Array(s.index);
        nodes_flat.set(nn, noff); noff += nn.length;
        conn_flat.set(cc, coff);  coff += cc.length;
      }

      const np_p     = allocI32(M, npoints_per);
      const ne_p     = allocI32(M, n_elem_per);
      const nodes_p  = allocF64(M, nodes_flat);
      const conn_p   = allocI32(M, conn_flat);

      const ok = M.ccall('wasm_msh3d_template', 'number',
        ['number','number','number','number','number'],
        [numfaces, np_p, nodes_p, ne_p, conn_p]);

      M._free(np_p);
      M._free(ne_p);
      M._free(nodes_p);
      M._free(conn_p);

      if (!ok) throw new Error('[MeshModule] wasm_msh3d_template falhou.');
      return readAndFreeResult(M);
    },
  },

  /* -----------------------------------------------------------------------
   * mshsurf — Malhas de Superfície 3D
   * boundary sempre em 3D: [x0,y0,z0, ...]
   * --------------------------------------------------------------------- */
  mshsurf: {

    /**
     * Mapeamento bilinear transfinito para patch de superfície 3D.
     * @param {{ boundary, m, n, elem_type?, diag_type? }} p
     */
    async bilinear({ boundary, m, n, elem_type = 4, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_mshsurf_bilinear',
        boundary,
        ['number','number','number','number'],
        [m, n, elem_type, diag_type]
      );
    },

    /**
     * Mapeamento bilinear colapsado para patch triangular 3D.
     */
    async collbilinear({ boundary, m, n, elem_type = 3, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_mshsurf_collbilinear',
        boundary,
        ['number','number','number','number'],
        [m, n, elem_type, diag_type]
      );
    },

    /**
     * Lofting entre dois lados opostos de um patch de superfície 3D.
     * @param {{ boundary, m, n, dir?, weight?, elem_type?, diag_type? }} p
     */
    async loft({ boundary, m, n, dir = 0, weight = 1.0, elem_type = 4, diag_type = 4 }) {
      return callWithBoundary(
        'wasm_mshsurf_loft',
        boundary,
        ['number','number','number','number','number','number'],
        [m, n, dir, weight, elem_type, diag_type]
      );
    },

    /**
     * Mapeamento trilinear para patch triangular equilateral 3D.
     */
    async trilinear({ boundary, m, elem_type = 3 }) {
      return callWithBoundary(
        'wasm_mshsurf_trilinear',
        boundary,
        ['number','number'],
        [m, elem_type]
      );
    },

    /**
     * Malha estruturada por template para patches de superfície 3D.
     * @param {{ n_sides, subdivision: number[4], boundary }} p
     */
    async template({ n_sides, subdivision, boundary }) {
      const M = await getModule();
      const sub4 = [
        subdivision[0] ?? 0,
        subdivision[1] ?? 0,
        subdivision[2] ?? 0,
        subdivision[3] ?? 0,
      ];
      const sub = allocI32(M, sub4);
      const bry = allocF64(M, boundary);
      const ok = M.ccall('wasm_mshsurf_template', 'number',
        ['number','number','number'],
        [n_sides, sub, bry]);
      M._free(sub);
      M._free(bry);
      if (!ok) throw new Error('[MeshModule] wasm_mshsurf_template falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Malha de superfície 3D por advancing-front 2D com suavização.
     * @param {{ boundary: number[], edges: number[], inter_edges?: number[],
     *           internal_pts?: number }} p
     *   boundary    : [x0,y0,z0, ...] — pontos 3D
     *   edges       : [i0,j0, ...] — arestas de contorno (pares de índices 0-based)
     *   inter_edges : [i0,j0, ...] — arestas internas (opcional)
     */
    async edge2d({ boundary, edges, inter_edges = [], internal_pts = 1 }) {
      const M = await getModule();
      const n_pts      = boundary.length / 3;
      const bound_edge = edges.length / 2;
      const inter_edge = inter_edges.length / 2;
      const all_edges  = [...edges, ...inter_edges];

      const bry  = allocF64(M, boundary);
      const ed_p = allocI32(M, all_edges);

      const ok = M.ccall('wasm_mshsurf_edge2d', 'number',
        ['number','number','number','number','number','number'],
        [n_pts, bry, bound_edge, inter_edge, ed_p, internal_pts]);

      M._free(bry);
      M._free(ed_p);

      if (!ok) throw new Error('[MeshModule] wasm_mshsurf_edge2d falhou.');
      return readAndFreeResult(M);
    },

    /**
     * Gerador advancing-front 3D com malha de suporte.
     * @param {{ support_nodes, support_index, support_elem_size?,
     *           boundary, edges, inter_edges?, max_elm_size?, curvature? }} p
     *   support_nodes : [x0,y0,z0, ...] — nós 3D da malha de suporte
     *   support_index : 0-based
     */
    async edge({ support_nodes, support_index, support_elem_size = 3,
                 boundary, edges, inter_edges = [],
                 max_elm_size = 0.0, curvature = 1 }) {
      const M = await getModule();
      const supp_n_node = support_nodes.length / 3;
      const supp_n_elem = support_index.length / support_elem_size;
      const n_pts       = boundary.length / 3;
      const bound_edge  = edges.length / 2;
      const inter_edge  = inter_edges.length / 2;
      const all_edges   = [...edges, ...inter_edges];

      const sn_p  = allocF64(M, support_nodes);
      const sc_p  = allocI32(M, support_index);
      const bry_p = allocF64(M, boundary);
      const ed_p  = allocI32(M, all_edges);

      const ok = M.ccall('wasm_mshsurf_edge', 'number',
        ['number','number','number','number','number',
         'number','number','number','number','number',
         'number','number'],
        [supp_n_node, supp_n_elem, support_elem_size, sn_p, sc_p,
         n_pts, bry_p, bound_edge, inter_edge, ed_p,
         max_elm_size, curvature]);

      M._free(sn_p);
      M._free(sc_p);
      M._free(bry_p);
      M._free(ed_p);

      if (!ok) throw new Error('[MeshModule] wasm_mshsurf_edge falhou.');
      return readAndFreeResult(M);
    },
  },
};

/**
 * Converte o resultado de meshModule em um THREE.BufferGeometry pronto para uso.
 *
 * @param {{ positions: Float64Array, index: Int32Array }} result
 * @param {THREE} THREE — objeto THREE passado pelo chamador
 * @returns {THREE.BufferGeometry}
 */
export function meshResultToGeometry(result, THREE) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(result.positions), 3)
  );
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(result.index), 1));
  geo.computeVertexNormals();
  return geo;
}
