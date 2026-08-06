# Campeão 🏆

Bot de música do Discord controlado por voz, estilo Alexa. Fica no canal de voz e obedece:

> **"CAMPEÃO, TOCA WONDERWALL DO OASIS"**

## Comandos

**Por voz** (com o bot no canal): `toca <música>`, `pula`, `pausa`, `continua`, `para`, `sai` — sempre precedidos de "Campeão". Falar só "Campeão" toca um bip (ou abaixa a música) e abre uma janela de 10s ouvindo você.

**Por texto**: `!entra`, `!play <música>`, `!pula`, `!pausa`, `!continua`, `!para`, `!fila`, `!sai`, `!ajuda`

## Stack

- Node + discord.js + @discordjs/voice (playback e captura de voz)
- faster-whisper (STT local em português, CPU, sem API paga)
- yt-dlp (busca YouTube com fallback SoundCloud)

## Rodar

```bash
docker build -t campeao .
docker run -e DISCORD_TOKEN=... -e WHISPER_MODEL=small -v campeao-data:/data campeao
```

O bot avisa o que está tocando no canal de texto onde foi chamado (`!entra`/`!play`).
