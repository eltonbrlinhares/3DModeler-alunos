# mesh_server

Servidor HTTP responsável pela geração de malhas 2D, 3D e de superfície.

## Obter o executável

O código-fonte do servidor não é distribuído neste repositório.
Solicite ao professor o executável compilado (`mesh_server.exe` no Windows ou `mesh_server` no Linux/macOS) e coloque-o **nesta pasta**.

## Executar

**Windows (PowerShell):**
```powershell
.\run_server.ps1           # porta padrão 7070
.\run_server.ps1 -Port 8080
```

**Linux / macOS:**
```bash
./run_server.sh            # porta padrão 7070
./run_server.sh 8080
```

## Porta padrão

O frontend está configurado para se comunicar com o servidor na porta **7070**.
Se mudar a porta, atualize também a constante `MESH_SERVER_URL` em `frontend/src/`.
