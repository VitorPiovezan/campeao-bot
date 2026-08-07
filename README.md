# Campeão

Bot de música do Discord controlado por **voz**, estilo Alexa. Ele fica no canal de voz, ouve
a palavra-chave e obedece:

> **"CAMPEÃO, TOCA WONDERWALL DO OASIS"**

Encontra a versão original (não o remix), toca, mostra um card com capa do álbum e ainda
emenda músicas parecidas no modo rádio.

---

## Comandos

### Por voz (com o bot no canal)

Sempre começando com **"Campeão"** — a palavra-chave tolera erros de transcrição
("campeon", "campião", "compião" funcionam).

| Fala | O que faz |
| --- | --- |
| `Campeão, toca <música>` | Busca e toca (também: tocar, coloca, bota, põe, manda) |
| `Campeão, toca <música> no youtube` | Força a fonte (`no youtube` / `no soundcloud`) |
| `Campeão` (sozinho) | Bipa, abaixa o volume e escuta você por 2,5s |
| `Campeão, pula` | Próxima da fila (também: pular, próxima, passa) |
| `Campeão, pausa` / `continua` | Pausa e retoma |
| `Campeão, para` | Para tudo e limpa a fila |
| `Campeão, liga o rádio` | Modo rádio (veja abaixo) |
| `Campeão, essa não` | Veta a música atual pelo resto da sessão |
| `Campeão, sai` | Sai do canal |

### Por texto

`!entra` · `!play <música>` · `!pula` · `!pausa` · `!continua` · `!para` · `!fila` ·
`!radio` · `!sai` · `!ajuda`

### Por botão

O card "Tocando agora" traz controles clicáveis: **Pausar/Retomar**, **Pular**,
**Não curti**, **Parar**, **Ligar rádio** e **Ver fila** (resposta privada).
Os botões refletem o estado atual e somem do card antigo quando entra música nova.

---

## Como funciona

### Ouvido

1. `@discordjs/voice` captura o áudio de cada pessoa no canal (precisa de `>= 0.19` +
   `@snazzah/davey`, senão o Discord não entrega áudio).
2. **Porteiro local**: os primeiros 2,5s da fala são transcritos pelo `faster-whisper`
   local. Se não parecer "campeão", a fala é descartada ali — só o que passa vai adiante.
   Corta ~80-90% das chamadas externas e mantém a conversa da call fora da nuvem.
3. **Transcrição**: `whisper-large-v3-turbo` na API da Groq (~0,3s). Se a Groq
   estiver perto do limite de requisições ou responder 429, cai automaticamente no
   Whisper local.
4. A janela de atenção pós-bip é validada contra o **início** da fala, não o fim da
   transcrição — senão o atraso do reconhecimento expiraria a janela.

### Busca

1. **Deezer** (API pública) identifica a faixa oficial e devolve artista, título,
   duração e capa. É o que corrige "paz e filhos" → *Legião Urbana - Pais e Filhos*.
2. **YouTube**: busca 6 candidatos e pontua cada um — canal `- Topic` ou VEVO, título
   com "official", duração batendo com a do Deezer (±5s), e penalidade forte para
   `remix`, `slowed`, `reverb`, `live`, `cover`, canais com cara de spam. Se você pediu
   "remix" explicitamente, a penalidade é desligada.
3. **SoundCloud** como reserva, ignorando faixas com DRM. Quando o áudio vem daqui, o
   card avisa a fonte.

### Reprodução

Três vias, com fallback automático (se o áudio não começar em 1,5s, refaz pela via longa):

1. **Cache em disco** (`/data/tracks`, 40 músicas, LRU) — instantâneo.
2. **`--load-info-json`** reaproveitando a extração feita na busca — evita a segunda
   extração completa.
3. **Extração completa** — último recurso.

Músicas na fila são **pré-baixadas** durante a atual, então as trocas são instantâneas.
Música nova custa ~8s neste servidor (extração ~3,6s + início do download ~4,4s).

### Modo rádio

Quando a fila esvazia, o Campeão busca o **Mix do YouTube** da última música e emenda
uma sugestão nova, filtrando o que já tocou, o que foi vetado e versões remix/live.
A próxima sugestão é pré-baixada, então a emenda é instantânea. Card em azul.

### Saída automática

- **5 minutos** sem música e sem nenhum comando → sai do canal.
- **1 minuto** com o canal de voz vazio → sai.

### YouTube em servidor

Baixar do YouTube a partir de um IP de datacenter exige quatro peças **juntas**:

- `--js-runtimes node`
- **PO token** — `bgutil-ytdlp-pot-provider` (plugin pip + servidor Node em
  `localhost:4416`, iniciado pelo `start.sh`)
- **Cookies** de uma conta Google descartável (`COOKIES_B64`) — sem eles, vídeos
  populares dão `LOGIN_REQUIRED`
- `--remote-components ejs:github` — resolvedor de assinatura; sem ele dá
  "Requested format is not available"

Um **aquecimento** roda no boot e a cada 4h: a primeira baixada após subir paga ~14s
de mint de token, e o aquecimento absorve esse custo antes de alguém pedir música.

---

## Rodar

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `DISCORD_TOKEN` | sim | Token do bot (Discord Developer Portal → Bot) |
| `GROQ_API_KEY` | não | Chave da Groq. Sem ela, usa só o Whisper local |
| `COOKIES_B64` | não | `cookies.txt` do YouTube em base64 (conta descartável) |
| `POT_PROVIDER_URL` | não | Padrão `http://127.0.0.1:4416` |
| `WHISPER_MODEL` | não | Modelo local, padrão `base` |
| `WHISPER_THREADS` | não | Threads do Whisper local, padrão `4` |

O bot precisa do **Message Content Intent** ligado no portal do Discord, e das
permissões de conectar/falar/enviar mensagens no servidor.

### Docker

```bash
docker build -t campeao .
docker run -d --name campeao \
  -e DISCORD_TOKEN=... \
  -e GROQ_API_KEY=... \
  -e COOKIES_B64="$(base64 -w0 cookies.txt)" \
  -v campeao-data:/data \
  campeao
```

O volume `/data` guarda cache de músicas, cookies e o cache do yt-dlp — vale manter
entre reinícios.

### Local (sem Docker)

Precisa de Node 22+, Python 3.11+, `ffmpeg`, `yt-dlp`, `faster-whisper` e o
`bgutil-ytdlp-pot-provider`. Depois:

```bash
npm install
bash start.sh
```

---

## Deploy

Hospedado no Dokploy (`deploy.arvore.dev`), projeto `campeao-bot`.

**Deploy é automático**: qualquer push na branch `master` dispara um webhook do GitHub
que rebuilda e sobe a nova versão. Não precisa fazer nada além de `git push`.

Deploy manual, se precisar:

```bash
curl -X POST https://deploy.arvore.dev/api/deploy/<refreshToken>
```

Todo deploy reinicia o container, o que **derruba o bot da call** — depois de subir,
chame `!entra` de novo.

### Logs

```bash
curl -H "x-api-key: $DOKPLOY_API_KEY" \
  "https://deploy.arvore.dev/api/application.readLogs?applicationId=<id>&tail=100"
```

Prefixos úteis: `[gate]` (porteiro), `[stt]` (transcrição), `[wake]` (comando
reconhecido), `[busca]` (candidatos e pontuação), `[player]` (via de reprodução),
`[radio]`, `[idle]`, `[aquecimento]`.

---

## Manutenção

- **Cookies expiram** (meses). Sinal: `[aquecimento] youtube FALHOU` com "Sign in to
  confirm you're not a bot". Exporte de novo da conta descartável e atualize
  `COOKIES_B64`. Não faça login nessa conta no navegador depois de exportar — invalida
  os cookies.
- **Limite da Groq**: 20 requisições/min na conta. O porteiro local e o guarda de cota
  já evitam estourar; se estourar mesmo assim, o bot degrada para o Whisper local em vez
  de ficar surdo.
- **Comando não reconhecido**: o canal mostra o que ele entendeu. Se um comando legítimo
  estiver sendo barrado, ajuste `gateHasWake` (porteiro) ou as listas de verbos em
  `src/index.mjs`.
