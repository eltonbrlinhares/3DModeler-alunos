# 3DModeler.js — Projeto do Curso

Modelador 3D interativo baseado em Three.js, React e OpenCascade.js (WASM).

## Estrutura do repositório

```
3DModeler-alunos/
├── frontend/          # Aplicação React/Vite — código-fonte principal
│   ├── public/        # Binários WASM pré-compilados (não editar)
│   └── src/           # Código-fonte JavaScript/JSX (aqui você vai trabalhar)
└── mesh_server/       # Scripts para rodar o servidor de malha
    ├── run_server.ps1 # Windows
    └── run_server.sh  # Linux/macOS
```

## Pré-requisitos

- [Node.js](https://nodejs.org/) 18+
- Executável `mesh_server` (solicitar ao professor)

## Configuração inicial

```bash
# 1. Clone o repositório
git clone https://github.com/<org>/3DModeler-alunos.git
cd 3DModeler-alunos

# 2. Crie seu branch de trabalho
git checkout -b aluno/seu-nome

# 3. Instale as dependências do frontend
cd frontend
npm install

# 4. Inicie o servidor de desenvolvimento
npm run dev
```

Acesse em [http://localhost:5173](http://localhost:5173).

## Servidor de malha

O frontend se comunica com um servidor local de malha na porta **7070**.
Coloque o executável (`mesh_server.exe` / `mesh_server`) na pasta `mesh_server/` e execute:

```powershell
# Windows
.\mesh_server\run_server.ps1
```
```bash
# Linux/macOS
./mesh_server/run_server.sh
```

## Fluxo de trabalho (por aluno)

```bash
# Certifique-se de estar no seu branch
git checkout aluno/seu-nome

# Implemente, commite e envie
git add .
git commit -m "descrição da implementação"
git push origin aluno/seu-nome
```

> **Nunca commite diretamente no `main`.** O branch `main` é protegido e serve como base para todos.

## Tecnologias

| Tecnologia | Papel |
|---|---|
| [React](https://react.dev/) + [Vite](https://vitejs.dev/) | UI e bundler |
| [Three.js](https://threejs.org/) | Renderização 3D |
| [OpenCascade.js](https://ocjs.org/) | Modelagem B-Rep (WASM) |
| mesh_server | Geração de malhas 2D/3D (servidor local) |
