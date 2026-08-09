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
| `Campeão, letra` | Busca a letra da música atual |
| `Campeão, sai` | Sai do canal |

### Por slash command

`/tocar <música>` — com **autocomplete**: enquanto você digita, o Deezer sugere
"Artista - Título", então dá pra pedir a faixa certa sem acertar o nome de cabeça.

`/pular` · `/pausar` · `/continuar` · `/parar` · `/fila` · `/radio` · `/vetar` ·
`/letra` · `/sair` · `/ajuda`

### Por texto

`!entra` · `!play <música>` · `!pula` · `!pausa` · `!continua` · `!para` · `!fila` ·
`!radio` · `!veta` · `!letra` · `!sai` · `!ajuda`

### Por botão

O card "Tocando agora" traz controles clicáveis: **Pausar/Retomar**, **Pular**,
**Não curti**, **Parar**, **Ligar rádio**, **Ver fila** e **Letra** (respostas privadas).
Os botões refletem o estado atual e somem do card antigo quando entra música nova.

---

## Como funciona

### Ouvido

1. `@discordjs/voice` captura o áudio de cada pessoa no canal (precisa de `>= 0.19` +
   `@snazzah/davey`, senão o Discord não entrega áudio).
2. **Filtro de duração e de música**: falas acima de `MAX_UTTERANCE_S` são descartadas; entre
   6s e o limite, o bot mede a proporção de pausas no trecho — áudio contínuo demais é
   música vazando pelo microfone, não comando.
3. **Porteiro local**: os primeiros 2,5s da fala são transcritos pelo `faster-whisper`
   local. Se não parecer "campeão", a fala é descartada ali — só o que passa vai adiante.
   Corta ~80-90% das chamadas externas e mantém a conversa da call fora da nuvem.
4. **Transcrição**: `whisper-large-v3-turbo` na API da Groq (~0,3s), com o vocabulário do
   bot passado como `prompt` (melhora "campeão", "pula", "rádio"). Se a Groq estiver perto
   do limite de requisições ou responder 429, cai automaticamente no Whisper local.
5. A janela de atenção pós-bip é validada contra o **início** da fala, não o fim da
   transcrição — senão o atraso do reconhecimento expiraria a janela.

### Busca

1. **Deezer** (API pública) identifica a faixa oficial e devolve artista, título,
   duração e capa. É o que corrige "paz e filhos" → *Legião Urbana - Pais e Filhos*.
2. **YouTube**: busca 6 candidatos e pontua cada um — canal `- Topic` ou VEVO, título
   com "official", duração batendo com a do Deezer (±5s), e penalidade forte para
   `remix`, `slowed`, `reverb`, `live`, `cover`, canais com cara de spam. Se você pediu
   "remix" explicitamente, a penalidade é desligada. Os 3 melhores são **validados em
   paralelo** (não um após o outro), e se a consulta refinada pelo Deezer não der em
   nada, o bot repete a busca com o texto original que você falou.
3. **SoundCloud** como reserva, ignorando faixas com DRM. Quando o áudio vem daqui, o
   card avisa a fonte.
4. **Cache de resolução** em memória (1h): pedir a mesma música de novo pula toda a
   etapa de busca.

### Reprodução

Três vias, com fallback automático (se o áudio não começar em 1,5s, refaz pela via longa):

1. **Cache em disco** (`$DATA_DIR/tracks`, 40 músicas, LRU) — instantâneo.
2. **`--load-info-json`** reaproveitando a extração feita na busca — evita a segunda
   extração completa.
3. **Extração completa** — último recurso.

Músicas na fila são **pré-baixadas** durante a atual, então as trocas são instantâneas.
Música nova custa ~8s neste servidor (extração ~3,6s + início do download ~4,4s).

**Resgate de faixa cortada**: se o stream morre bem antes do fim (comum em faixa do
SoundCloud com problema), o bot reabre a mesma música no YouTube e **retoma do ponto**
em que parou, em vez de pular pra próxima.

### Fila persistente

A fila é gravada em `$DATA_DIR/queue.json` e regravada em cada mudança (com debounce),
além de um flush no `SIGTERM`/`SIGINT`. Quando o bot sobe de novo — deploy, restart,
queda — ele volta ao mesmo canal de voz e retoma de onde parou, desde que ainda tenha
gente lá.

### Status do canal e presença

O nome da música aparece no **status do canal de voz** (`♪ Título`, com `⏸` quando
pausado) e na **presença do bot** ("Ouvindo <título>"), então dá pra ver o que está
tocando sem abrir o canal de texto.

### Modo rádio

Quando a fila esvazia, o Campeão busca o **Mix do YouTube** da última música e emenda
uma sugestão nova, filtrando o que já tocou, o que foi vetado e versões remix/live.
A próxima sugestão é pré-baixada, então a emenda é instantânea. Card em azul.

### Saída automática

- **5 minutos** sem música e sem nenhum comando → sai do canal.
- **1 minuto** com o canal de voz vazio → sai.

Se você chamar o bot de outro canal e o canal antigo estiver **vazio**, ele se muda
sozinho. Se ainda tiver gente ouvindo lá, ele avisa que está ocupado em vez de abandonar.

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

Só `DISCORD_TOKEN` é obrigatória. Todas as outras têm padrão e existem para você
ajustar custo, precisão ou comportamento sem mexer no código.

#### Essenciais

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Obrigatória.** Token do bot (Discord Developer Portal → Bot) |
| `GROQ_API_KEY` | — | Liga a transcrição na nuvem. Sem ela o bot funciona só com o Whisper local: mais lento (~2-4s) e menos preciso, mas de graça e sem sair da máquina |
| `COOKIES_B64` | — | `cookies.txt` do YouTube em base64 (conta descartável). Sem isso, vídeos populares falham com `LOGIN_REQUIRED` no IP de um datacenter |
| `DATA_DIR` | `/data` | Onde ficam cache de músicas, cookies e a fila persistida. Aponte pra uma pasta local (`./data`) pra rodar fora do Docker sem precisar de root |

#### Transcrição na nuvem (Groq)

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `GROQ_MODEL` | `whisper-large-v3-turbo` | Trocar por `whisper-large-v3` dá um pouco mais de precisão em áudio ruim, ao custo de latência |
| `GROQ_RPM` | `18` | Teto de chamadas/min antes de o bot passar a usar o Whisper local por conta própria. A conta free da Groq permite 20 — subir isso só faz sentido em plano pago |
| `STT_PROMPT` | vocabulário do bot | Texto passado como `prompt` pro Whisper. Adicione aqui gírias, nomes de artistas ou apelidos que a transcrição erra sempre |

#### Whisper local

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `WHISPER_MODEL` | `base` | `small`/`medium` melhoram bastante o porteiro (menos falso-negativo na palavra-chave), mas pesam CPU e RAM. `tiny` deixa o porteiro barato num servidor fraco |
| `WHISPER_THREADS` | `4` | Threads de CPU. Suba junto com o modelo, senão a transcrição local vira gargalo |
| `WHISPER_PROMPT` | vocabulário do bot | Mesma ideia do `STT_PROMPT`, só que pro modelo local — é o que mais ajuda o porteiro a reconhecer "campeão" |
| `WHISPER_BEAM_SIZE` | `1` | `3`-`5` melhoram a transcrição local em fala difícil, com custo de CPU proporcional |
| `STT_PORT` | `5005` | Porta do servidor local de transcrição (mude se já estiver em uso) |
| `STT_URL` | `http://127.0.0.1:5005/` | Endereço que o bot chama. Aponte pra outra máquina se quiser rodar o Whisper num host com GPU |

#### Porteiro de wake-word

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `GATE_SECONDS` | `2.5` | Quanto do começo da fala vai pro porteiro. Menor = mais barato e mais rápido, mas quem demora pra dizer "campeão" passa batido |
| `GATE_MAX_CONCURRENT` | `2` | Quantas falas o porteiro analisa ao mesmo tempo. Suba em servidor com CPU sobrando e call cheia; o excesso é descartado, não enfileirado |
| `GATE_DISABLED` | desligado | `1` manda toda fala direto pra Groq. Só use pra depurar por que um comando legítimo está sendo barrado — o custo dispara |

#### Escuta

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `ATTENTION_MS` | `2500` | Janela em que o bot te escuta sem repetir "campeão", depois do bip. Suba se as pessoas demoram pra formular o pedido |
| `DUCK_VOLUME` | `0.15` | Volume da música enquanto o bot escuta. `0` silencia de vez, `0.4` mantém a música audível |
| `DUCK_TIMEOUT_MS` | `8000` | Quanto tempo o volume fica baixo antes de voltar sozinho, caso a busca trave |
| `MAX_UTTERANCE_S` | `12` | Teto de duração de uma fala. Acima disso é quase sempre música vazando; baixar corta custo, subir permite pedidos longos |
| `MUSIC_SILENCE_RATIO` | `0.08` | Proporção mínima de pausas pra um áudio longo ser considerado fala. Suba se música ainda estiver passando pelo filtro; baixe se falas legítimas estão sendo descartadas |

#### Busca e reprodução

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `SEARCH_CANDIDATES` | `6` | Quantos resultados do YouTube entram na pontuação. Mais candidatos = mais chance de achar a versão oficial de faixa obscura, e busca mais lenta |
| `VALIDATE_TOP` | `3` | Quantos dos melhores são validados em paralelo. `1` é o mais rápido; `3` sobrevive a vídeo bloqueado/removido sem refazer a busca |
| `RESOLVE_TTL_MIN` | `60` | Minutos de cache da resolução de busca. Numa call que repete as mesmas músicas, subir isso elimina buscas inteiras |
| `CACHE_MAX_FILES` | `40` | Músicas guardadas em disco (LRU). Cada uma ~4MB — suba se tiver disco e quiser repetição instantânea |
| `RADIO_MIX_SIZE` | `30` | Tamanho do Mix do YouTube lido no modo rádio. Mais = mais variedade, e mais tempo pra escolher a próxima |
| `POT_PROVIDER_URL` | `http://127.0.0.1:4416` | Servidor de PO token. Só mexa se rodar o `bgutil-ytdlp-pot-provider` em outro host/porta |
| `WARMUP_VIDEO_ID` | `SRXH9AbT280` | Vídeo usado no aquecimento. Troque se esse for removido |
| `WARMUP_INTERVAL_H` | `4` | Intervalo do aquecimento. Encurte se o primeiro pedido depois de um tempo parado continua lento |

#### Convivência

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `IDLE_LEAVE_MS` | `300000` (5 min) | Tempo sem música e sem comando até sair do canal |
| `EMPTY_LEAVE_MS` | `60000` (1 min) | Tempo com o canal vazio até sair |

O bot precisa do **Message Content Intent** ligado no portal do Discord, e das
permissões de conectar/falar/enviar mensagens no servidor. Os slash commands são
registrados sozinhos no boot (`applications.commands` no convite).

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

O volume `/data` guarda cache de músicas, cookies, a fila persistida e o cache do
yt-dlp — vale manter entre reinícios: é ele que faz o bot voltar tocando depois de um
deploy.

### Local (sem Docker)

Precisa de Node 22+, Python 3.11+, `ffmpeg`, `yt-dlp`, `faster-whisper` e o
`bgutil-ytdlp-pot-provider`. Depois:

```bash
npm install
DATA_DIR=./data bash start.sh
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

Todo deploy reinicia o container e derruba o bot da call — mas a fila é salva e
retomada sozinha no boot, desde que ainda tenha gente no canal.

### Logs

```bash
curl -H "x-api-key: $DOKPLOY_API_KEY" \
  "https://deploy.arvore.dev/api/application.readLogs?applicationId=<id>&tail=100"
```

Prefixos úteis: `[gate]` (porteiro), `[stt]` (transcrição), `[wake]` (comando
reconhecido), `[busca]` (candidatos e pontuação), `[player]` (via de reprodução),
`[resgate]` (faixa cortada), `[fila]` (persistência), `[radio]`, `[idle]`,
`[aquecimento]`, `[config]` (variável de ambiente inválida).

---

## Manutenção

- **Cookies expiram** (meses). Sinal: `[aquecimento] youtube FALHOU` com "Sign in to
  confirm you're not a bot". Exporte de novo da conta descartável e atualize
  `COOKIES_B64`. Não faça login nessa conta no navegador depois de exportar — invalida
  os cookies.
- **Limite da Groq**: 20 requisições/min na conta. O porteiro local e o `GROQ_RPM`
  já evitam estourar; se estourar mesmo assim, o bot degrada para o Whisper local em vez
  de ficar surdo.
- **Comando não reconhecido**: o canal mostra o que ele entendeu. Se um comando legítimo
  estiver sendo barrado, primeiro tente `WHISPER_PROMPT`/`STT_PROMPT`; depois ajuste
  `gateHasWake` (porteiro) ou as listas de verbos em `src/index.mjs`.
- **Bot voltando pra call errada**: apague `$DATA_DIR/queue.json` e reinicie.
