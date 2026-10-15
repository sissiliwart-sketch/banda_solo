# Banda Solo

Web app (PWA) para gravar uma banda inteira em camadas: cada instrumento numa tela (2 a 8),
cada gravação nova toca junto com as anteriores e cai exatamente no tempo delas. No fim, o app gera
um vídeo único em tela dividida (vertical, quadrado ou horizontal) com o som mixado.

Feito para tablet Android (Chrome), funciona também em computador.

## Como a sincronia funciona

- **Um relógio só**: tudo roda no relógio do `AudioContext` (precisão de 1/48 000 s).
- **Faixas anteriores**: decodificadas do arquivo e agendadas amostra a amostra (`AudioStreamer`),
  e os vídeos seguem esse relógio.
- **Som da faixa nova**: capturado por um `AudioWorklet` com o número exato do quadro de áudio
  e gravado direto no aparelho (OPFS). Esse é o som que fica na faixa.
- **Imagem da faixa nova**: vem do `MediaRecorder` (sem recompressão) e é encaixada no som,
  usando o áudio do próprio gravador como impressão digital (correlação cruzada).
- **Latência do aparelho**: medida pela calibração (bipes que saem pelo fone e voltam pelo
  microfone) e descontada automaticamente.

Resultado medido no teste automatizado (`e2e/run.mjs`, modo "músico perfeito"): **0,00 ms** entre camadas.

## Stack

Vite + React + TypeScript + Tailwind · [Mediabunny](https://mediabunny.dev) (leitura, remux e
exportação de vídeo via WebCodecs) · Appwrite (contas, banco e armazenamento) · Vercel (hospedagem +
função `/api/join`).

## Configuração

- Appwrite: projeto `6ad0293700282c1d0892` em `https://nyc.cloud.appwrite.io/v1` (valores públicos,
  já embutidos em `src/config.ts`; podem ser trocados por `VITE_APPWRITE_ENDPOINT` /
  `VITE_APPWRITE_PROJECT_ID`). Plataformas Web: `*.vercel.app` e `localhost`.
- Vercel: variável secreta `APPWRITE_API_KEY` (usada só pelas funções `/api/join` e `/api/setup`).
- Banco, tabelas e bucket: `GET /api/setup?token=…` na Vercel, ou localmente
  `APPWRITE_API_KEY=… node scripts/setup-appwrite.mjs` (o token sai de `--token`). Idempotente.

## Scripts

```bash
npm run dev      # servidor de desenvolvimento
npm run build    # build de produção
npm test         # testes unitários (DSP, alinhamento, layouts)
npm run e2e      # teste ponta a ponta no Chromium com câmera/microfone simulados (rode o build antes)
```
