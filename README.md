<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/ef6d19b2-0f7e-4ec7-b4be-0dee50e2605c

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Renderização de vídeo

O renderizador exporta vídeos verticais em **1080 × 1920**, priorizando codecs
WebM modernos (VP9/VP8) quando o navegador oferece suporte e usando MP4 como
fallback. A captura é feita a 30 fps para evitar duplicação de quadros de vídeos
comuns de celular, com bitrate de vídeo de até 20 Mbps e áudio de 128 kbps.

A trilha de áudio original é anexada ao fluxo capturado quando disponibilizada
pelo navegador. O cancelamento encerra o `MediaRecorder`, libera as trilhas e
descarta qualquer renderização parcial.

