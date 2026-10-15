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

Variáveis de ambiente (Vercel → Project → Settings → Environment Variables):

| Variável | Onde | Exemplo |
| --- | --- | --- |
| `VITE_APPWRITE_ENDPOINT` | build (público) | `https://nyc.cloud.appwrite.io/v1` |
| `VITE_APPWRITE_PROJECT_ID` | build (público) | `banda-solo` |
| `APPWRITE_API_KEY` | servidor (secreta) | chave de API do projeto Appwrite |

No Appwrite: adicione as plataformas Web `*.vercel.app` e `localhost`. Para criar banco, tabelas e
bucket:

```bash
APPWRITE_ENDPOINT=... APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... npm run setup:appwrite
```

Sem essas variáveis o app funciona no **modo local** (tudo fica só no aparelho).

## Scripts

```bash
npm run dev      # servidor de desenvolvimento
npm run build    # build de produção
npm test         # testes unitários (DSP, alinhamento, layouts)
npm run e2e      # teste ponta a ponta no Chromium com câmera/microfone simulados (rode o build antes)
```
