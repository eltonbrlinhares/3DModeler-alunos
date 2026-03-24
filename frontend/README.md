# 3DModeler.js

Aplicação web de modelagem geométrica 3D construída com React, Three.js e OpenCascade.js. Combina sketching paramétrico NURBS em um plano de trabalho interativo com geração de superfícies e malhas de elementos finitos executadas no navegador via WebAssembly.

---

## Índice

- [Fluxo de trabalho](#fluxo-de-trabalho)
- [Stack](#stack)
- [Como executar](#como-executar)
- [Interface e atalhos](#interface-e-atalhos)
- [Recursos em detalhe](#recursos-em-detalhe)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Arquitetura](#arquitetura)
- [Módulos canvas/](#módulos-canvas)
- [Malha de superfície (mshsurf)](#malha-de-superfície-mshsurf)
- [Editor volumétrico OCCT](#editor-volumétrico-occt)
- [Observações para contribuidores](#observações-para-contribuidores)

---

## Fluxo de trabalho

```
1. Selecionar ferramenta (Linha / Polilinha / Arco / Spline)
2. Clicar no plano de trabalho para adicionar pontos
3. Confirmar a curva (Enter ou duplo-clique para polilinhas/splines)
4. Selecionar 2–N curvas para gerar uma superfície NURBS
5. Selecionar a superfície e abrir o painel de malha para gerar malha FEM
6. [opcional] Enviar sketch para o editor volumétrico OCCT
```

---

## Stack

| Tecnologia       | Versão | Papel no projeto                                       |
| ---------------- | ------ | ------------------------------------------------------ |
| React            | 19.1   | Interface e estado da aplicação                        |
| Three.js         | 0.177  | Viewport 3D, câmera, controles e geometria visual      |
| Vite             | 6.3    | Dev server, build e preview                            |
| OpenCascade.js   | 1.1    | Kernel CAD/B-Rep via WASM                              |
| mshsurf (WASM)   | —      | Geração de malha estruturada de superfície (C++ → WASM)|
| ESLint           | 9      | Verificação estática                                   |

---

## Como executar

### Requisitos

- Node.js (LTS recomendado)
- Navegador moderno com suporte a WebAssembly e `SharedArrayBuffer` em contexto isolado (Chrome, Edge, Firefox recentes)

### Instalação

```bash
cd frontend
npm install
```

### Desenvolvimento

```bash
cd frontend
npm run dev
```

Disponível em `http://localhost:5173`.

### Build e preview

```bash
npm run build
npm run preview
```

### Lint

```bash
npm run lint
```

### Dependência de headers CORS

O OpenCascade WASM requer `SharedArrayBuffer`, que só está disponível em contexto isolado. Os headers necessários já são injetados automaticamente pelo Vite:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Configurados em [vite.config.js](vite.config.js). Em produção, o servidor HTTP deve reproduzir esses headers.

---

## Interface e atalhos

### Toolbar

| Botão       | Ação                                       |
| ----------- | ------------------------------------------ |
| `Selecionar`| Ativa OrbitControls e gizmos do plano      |
| `Linha`     | Segmento de 2 pontos                       |
| `Polilinha` | N pontos, finaliza com `Enter` ou dblclick |
| `Arco`      | 3 pontos: centro, início, fim              |
| `Spline`    | Curva interpolada por N pontos             |
| `3D`        | Abre/fecha o editor volumétrico OCCT       |

### Barra inferior

| Controle       | Função                                                  |
| -------------- | ------------------------------------------------------- |
| `XY / XZ / YZ` | Reorienta o pivot para o plano selecionado              |
| `Controls`     | Mostra/oculta os gizmos TransformControls               |
| `Grid`         | Visibilidade do grid                                    |
| `Space`        | Espaçamento do grid (reconstruído ao confirmar)         |
| `Snap Grid`    | Trava pontos de desenho ao espaçamento do grid          |
| `X / Y / Z`    | Edição direta da posição do centro do pivot             |
| `Step T`       | Snap de translação do gizmo (0 = livre)                 |
| `Step R`       | Snap de rotação do gizmo em graus (0 = livre)           |

### Atalhos de teclado

| Tecla    | Ação                                                     |
| -------- | -------------------------------------------------------- |
| `Enter`  | Finaliza polilinha ou spline em andamento                |
| `Esc`    | Cancela o desenho; volta para ferramenta Selecionar      |
| `Delete` | Remove as curvas/superfície selecionadas                 |
| `C`      | Limpa todas as curvas e superfícies da cena              |

### Mouse na viewport

| Gesto                | Ação                                |
| -------------------- | ----------------------------------- |
| LMB arrastar         | Rotaciona a câmera (OrbitControls)  |
| MMB arrastar / scroll| Pan / zoom                          |
| LMB clicar (curva)   | Seleciona/deseleciona curva         |
| LMB clicar (handle)  | Seleciona ponto de controle         |
| LMB arrastar handle  | Move ponto de controle da curva     |
| LMB arrastar canto   | Redimensiona o grid                 |

---

## Recursos em detalhe

### Desenho paramétrico NURBS

Cada ferramenta de desenho produz uma curva NURBS construída pelos builders em `curves/NURBSBuilders.js`:

- **Linha** — segmento reto (grau 1)
- **Polilinha** — segmentos encadeados (grau 1)
- **Arco** — arco circular por centro + início + fim
- **Spline** — curva interpolada (grau 3, Catmull-Rom)

Durante o desenho, uma pré-visualização laranja é atualizada a cada frame. Ao confirmar, a curva é adicionada à cena com cor vermelha e seus pontos de controle ficam editáveis via drag.

### Snap de extremidades

Ao posicionar o cursor próximo à extremidade de uma curva existente, o ponto se prende automaticamente a ela (pixel tolerance = 14 px para pontos internos, 24 px para o primeiro ponto). Funciona independentemente do snap de grid.

### Subdivisão paramétrica

Com uma ou mais curvas selecionadas, o painel de subdivisão permite definir:

- **N** — número de segmentos
- **Razão** — proporção último/primeiro segmento (1.0 = uniforme, >1.0 = progressivo)

Os pontos de subdivisão (marcadores verdes) são recalculados em tempo real e armazenados no `userData` de cada curva para uso no gerador de malha.

### Geração de superfície

Selecione 2 ou mais curvas e clique em **Gerar Superfície**:

| Configuração                      | Algoritmo usado               |
| --------------------------------- | ----------------------------- |
| Loop fechado de 3–4 curvas        | Coons patch (`fillBoundary`)  |
| Loop fechado de 2 ou 5+ curvas    | Superfície plana triangulada (`fillPlanar`) |
| Cadeia aberta de N curvas         | Loft de seções (`loftSections`) |

O algoritmo detecta automaticamente se as curvas formam um loop fechado usando clustering de extremidades com tolerância proporcional ao espaçamento do grid.

### Exportação / Importação de modelo

O menu **Salvar / Carregar** serializa o estado atual (curvas + superfícies + subdivisões + malha FEM) para JSON e permite restaurá-lo. O formato é `{ version: 1, curves: [...], surfaces: [...] }`.

---

## Estrutura do projeto

```text
3DModeler.js/
├── frontend/                  ← este pacote
│   ├── public/
│   │   ├── opencascade.wasm.wasm
│   │   └── mesh.wasm          ← binário do mshsurf compilado para WASM
│   ├── src/
│   │   ├── App.jsx
│   │   ├── ThreeGrid.jsx      ← coordenador central da UI
│   │   ├── components/
│   │   │   ├── ThreeCanvas.jsx        ← viewport 3D principal
│   │   │   ├── canvas/                ← módulos internos do ThreeCanvas
│   │   │   │   ├── sceneSetup.js      ← cena, câmera, renderers, pivot
│   │   │   │   ├── curveUtils.js      ← buildNURBS, computeSubdivTs
│   │   │   │   ├── surfaceOrderUtils.js ← ordenação de seções para loft/patch
│   │   │   │   ├── generateSurface.js ← factory generateSurfaceFromSelection
│   │   │   │   ├── meshSurface.js     ← factory meshSurface (FEM via WASM)
│   │   │   │   ├── femUtils.js        ← femWireframeGeometry
│   │   │   │   └── modelIO.js         ← factory exportModel/importModel
│   │   │   ├── Toolbar.jsx
│   │   │   ├── CoordsDisplay.jsx
│   │   │   ├── ViewCube.jsx
│   │   │   ├── ModeIndicator.jsx
│   │   │   ├── CurveSubdivDialog.jsx
│   │   │   ├── SurfaceMeshPanel.jsx
│   │   │   └── VolumeEditorUI.jsx
│   │   ├── curves/
│   │   │   └── NURBSBuilders.js
│   │   ├── mesh/
│   │   │   ├── MeshModule.js  ← wrapper JS do WASM mshsurf
│   │   │   └── useMesh.js
│   │   └── occt/
│   │       ├── CurveEditor.js
│   │       ├── SurfaceEditor.js
│   │       ├── VolumeEditor.js
│   │       └── VolumeEditorAdvanced.js
│   ├── package.json
│   ├── vite.config.js
│   └── README.md
└── mesh_server/               ← código-fonte C++ do mshsurf
    ├── mshsurf/               ← gerador de malha estruturada
    ├── mshaux/                ← estruturas geométricas auxiliares
    ├── rtree/                 ← R-tree para busca espacial
    └── surftop/               ← topologia de superfície
```

---

## Arquitetura

### Coordenação central: ThreeGrid.jsx

`ThreeGrid.jsx` mantém o estado React da aplicação e conecta os componentes:

```text
ThreeGrid
  ├─> Toolbar          (ferramenta ativa, toggle do editor 3D)
  ├─> ModeIndicator    (instrução contextual do modo atual)
  ├─> CoordsDisplay    (grid, plano, snaps, centro)
  ├─> SurfaceMeshPanel (parâmetros de malha FEM)
  ├─> VolumeEditorUI   (sketch pendente para operações OCCT)
  └─> ThreeCanvas      (ref com API imperativa)
```

### API imperativa do ThreeCanvas

`ThreeCanvas` expõe métodos estáveis via `forwardRef` + `useImperativeHandle`. Nenhum deles causa re-render React — todos operam diretamente nos refs Three.js.

| Método                        | Descrição                                          |
| ----------------------------- | -------------------------------------------------- |
| `setCenter(x, y, z)`          | Move o pivot do plano de trabalho                  |
| `setPlane(name)`              | Reorienta para `"XY"`, `"XZ"` ou `"YZ"`           |
| `setGridVisible(bool)`        | Mostra/oculta grid e handles                       |
| `setGridSize(spacing)`        | Reconstrói o grid com novo espaçamento             |
| `setGridSnap(bool)`           | Ativa/desativa snap ao grid                        |
| `setActiveTool(tool)`         | Muda ferramenta, cancela desenho em curso          |
| `setWorkPlaneControls(bool)`  | Mostra/oculta gizmos do plano de trabalho          |
| `setTranslationSnap(value)`   | Snap de translação do gizmo (0 = livre)            |
| `setRotationSnap(degrees)`    | Snap de rotação do gizmo (0 = livre)               |
| `generateSurfaceFromSelection()` | Gera superfície das curvas selecionadas         |
| `applySubdivisions(n, ratio)` | Aplica subdivisão às curvas selecionadas           |
| `getSelectedSubdivParams()`   | Retorna `{ subdivisions, ratio }` da 1ª selecionada|
| `meshSurface(algo, params)`   | Gera malha FEM na superfície selecionada           |
| `hasSurfaceSelected()`        | `true` se uma superfície estiver selecionada       |
| `getSurfaceBoundarySubdivs()` | Retorna `{ u, v, ratioU, ratioV }` do contorno     |
| `exportModel()`               | Serializa modelo para JSON                         |
| `importModel(data)`           | Restaura modelo de JSON                            |
| `getScene()`                  | Retorna `THREE.Scene`                              |
| `getPivot()`                  | Retorna `THREE.Group` pivot                        |
| `getCamera()`                 | Retorna `THREE.PerspectiveCamera`                  |
| `getOrbitControls()`          | Retorna `OrbitControls`                            |

---

## Módulos canvas/

O `ThreeCanvas.jsx` delega lógica complexa para módulos em `src/components/canvas/`. Todos operam com dependências explícitas via parâmetro — sem acesso a estado global.

### sceneSetup.js

Funções de inicialização puras, chamadas uma única vez no `useEffect`:

- `setupRenderers(container)` — cria `THREE.Scene`, `PerspectiveCamera`, `WebGLRenderer` e `CSS2DRenderer`
- `setupPivotAndGrid(scene, halfSize)` — cria pivot, grid inicial, AxesHelper, labels CSS2D e handles de canto
- `setupControls(scene, camera, domElement, pivot, onCenterChange)` — cria `OrbitControls` e dois `TransformControls` (translação + rotação)

### curveUtils.js

Funções puras sem estado:

- `buildNURBS(pts, tool)` — despacha para o builder correto em `NURBSBuilders.js`
- `computeSubdivTs(n, ratio)` — calcula parâmetros `t ∈ [0,1]` com razão geométrica
- `getLineEndpoints(line)` — retorna as extremidades conectáveis de uma curva
- `isEndpointHandle(line, ptIndex)` — indica se um índice é extremidade

### surfaceOrderUtils.js

Funções puras para preparar curvas antes do loft/patch:

- `getSurfacePairing(samplesA, samplesB)` — decide se duas seções precisam ser invertidas
- `orderSurfaceSections(sections, spacing)` — ordena em cadeia por conectividade
- `orientSurfaceSections(orderedSections)` — garante consistência de orientação
- `fallbackOrderSurfaceSections(sections)` — ordenação greedy por proximidade
- `orderClosedBoundary(secs, tolerance)` — detecta e ordena loop fechado via clustering

### generateSurface.js

`createGenerateSurface(deps)` — factory que retorna a função `generateSurfaceFromSelection`. Decide entre Coons patch, superfície plana ou loft com base na topologia das curvas selecionadas.

### meshSurface.js

`createMeshSurface(deps)` — factory que retorna a função `meshSurface(algo, params)`. Constrói o boundary a partir das curvas de contorno com a subdivisão correta, chama o módulo WASM e exibe o wireframe resultante na cena.

### femUtils.js

`femWireframeGeometry(result)` — constrói `THREE.BufferGeometry` de arestas únicas a partir do resultado WASM, evitando duplicatas internas.

### modelIO.js

`createModelIO(deps)` — factory que retorna `{ exportModel, importModel }`. Serializa/restaura curvas, superfícies, subdivisões e malha FEM para JSON.

---

## Malha de superfície (mshsurf)

O gerador de malha estruturada é uma biblioteca C++ em `mesh_server/mshsurf/` compilada para WebAssembly. O módulo JS em `src/mesh/MeshModule.js` expõe os algoritmos disponíveis:

| Algoritmo       | Topologia    | Elementos | Descrição                                         |
| --------------- | ------------ | --------- | ------------------------------------------------- |
| `bilinear`      | 4 curvas     | Q4 / T3   | Mapeamento bilinear transfinito                   |
| `collbilinear`  | 3–4 curvas   | T3        | Bilinear com colapso de nó para triangular        |
| `loft`          | 4 curvas     | Q4 / T3   | Interpolação por loft entre lados opostos         |
| `trilinear`     | 3–4 curvas   | T3        | Mapeamento trilinear (lados iguais)               |
| `template`      | 3–N curvas   | Q4        | Geração por template topológico (N-sided)         |

A subdivisão de cada lado do contorno é controlada individualmente pelo campo **N** e **Razão** no painel de curva. O painel de malha exibe as subdivisões U/V lidas ao vivo das curvas selecionadas.

---

## Editor volumétrico OCCT

Aberto pelo botão `3D` na toolbar. Recebe sketches do plano de trabalho via `onSketchCommit` e opera sobre sólidos B-Rep via OpenCascade.js:

| Operação             | Descrição                                          |
| -------------------- | -------------------------------------------------- |
| Extrudar             | Extrusão linear do perfil                          |
| Revolucionar         | Revolução em torno de X, Y ou Z                   |
| Loft                 | Loft entre dois ou mais perfis                     |
| União / Subtração / Interseção | Operações booleanas                  |
| Undo / Redo          | Histórico de operações                             |
| Exportar STEP        | Exportação para formato padrão ISO 10303           |

---

## Observações para contribuidores

### Adicionar uma nova ferramenta de desenho

1. Adicionar um builder em `curves/NURBSBuilders.js`.
2. Registrar o `tool` em `buildNURBS` dentro de `canvas/curveUtils.js`.
3. Adicionar o botão na `Toolbar.jsx`.
4. Ajustar `getLineEndpoints` e `isEndpointHandle` em `curveUtils.js` se a semântica de extremidade for diferente.

### Adicionar um novo algoritmo de malha

1. Implementar o algoritmo no C++ em `mesh_server/mshsurf/`.
2. Recompilar para WASM e atualizar `public/mesh.wasm`.
3. Expor o método em `MeshModule.js`.
4. Adicionar a entrada em `ALGORITHMS` em `SurfaceMeshPanel.jsx`.
5. Tratar o novo `algo` em `meshSurface.js`.

### Modificar a API imperativa do canvas

Qualquer método novo ou removido deve ser refletido em:
- `useImperativeHandle` em `ThreeCanvas.jsx`
- Tabela de API neste README
- Chamadas em `ThreeGrid.jsx` e demais consumidores

### Convenção de coordenadas

O projeto usa **Z-up** (convencão CAD). `camera.up = (0, 0, 1)`. O plano XY padrão tem o pivot rotacionado em `(π/2, 0, 0)` para que Z seja a normal do plano no espaço mundo.
