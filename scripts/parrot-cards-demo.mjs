import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CACHE_DIR ??= join(tmpdir(), "campeao-demo-tracks");

const { helpCard, noteCard, playerCard, queueCard, queuedCard, stageOf } = await import("../src/cards.mjs");

const PARROT_URL = (process.env.PARROT_URL ?? "https://parrot.arvore.dev").replace(/\/$/, "");
const BOT_TOKEN = process.env.PARROT_BOT_TOKEN;
const DEMO_CHANNEL = process.env.PARROT_DEMO_CHANNEL ?? "geral";
const DEMO_VOICE = process.env.PARROT_DEMO_VOICE ?? "Sala 1";
const STEP_MS = 4000;
const STAGE_STEP_MS = 5000;

if (!BOT_TOKEN) {
  console.error("[demo] defina PARROT_BOT_TOKEN (e PARROT_URL, se não for produção)");
  process.exit(1);
}

const log = (msg) => console.log(`[demo] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const res = await fetch(`${PARROT_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}`, ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
};

const labels = new Map();
const remember = (card) => {
  for (const action of card?.actions ?? []) labels.set(action.id, action.label);
};

const post = async (channelId, card) => {
  remember(card);
  const message = await api(`/channels/${channelId}/messages`, { method: "POST", body: { card } });
  return message;
};

const patch = async (channelId, messageId, card) => {
  remember(card);
  return api(`/channels/${channelId}/messages/${messageId}`, { method: "PATCH", body: { card } });
};

const TRACK = {
  title: "Charlie Brown Jr. — Só os Loucos Sabem",
  url: "https://www.youtube.com/watch?v=vc6vs-l5dkc",
  thumb: "https://i.ytimg.com/vi/vc6vs-l5dkc/hqdefault.jpg",
  duration: 186,
  by: "Vitor",
  source: "youtube",
  seq: 1,
};
const NEXT = { title: "Legião Urbana — Tempo Perdido", url: "https://www.youtube.com/watch?v=nOOHSGmLNXE", thumb: "https://i.ytimg.com/vi/nOOHSGmLNXE/hqdefault.jpg", duration: 297, by: "Marina", source: "youtube", seq: 2 };
const RADIO = { title: "Skank — É uma Partida de Futebol", url: "https://www.youtube.com/watch?v=n3nrjyNcTFk", thumb: "https://i.ytimg.com/vi/n3nrjyNcTFk/hqdefault.jpg", duration: 210, by: "Rádio", radio: true, source: "youtube", seq: 3 };
const STAGE_QUEUE = [
  NEXT,
  RADIO,
  { title: "Queen — Bohemian Rhapsody", url: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ", thumb: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg", duration: 355, by: "Bruno", source: "youtube", seq: 4 },
  { title: "Rick Astley — Never Gonna Give You Up", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", thumb: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", duration: 213, by: "Camila", source: "youtube", seq: 5 },
  { title: "Charlie Brown Jr. — Zóio de Lula", url: "https://www.youtube.com/watch?v=BGxJqfTK4Cs", thumb: "https://i.ytimg.com/vi/BGxJqfTK4Cs/hqdefault.jpg", duration: 224, by: "Rádio", radio: true, source: "youtube", seq: 6 },
];

const pickChannel = (channels) => {
  const text = channels.filter((c) => c.kind === "text");
  return text.find((c) => c.id === DEMO_CHANNEL) ?? text.find((c) => c.name === DEMO_CHANNEL) ?? text[0] ?? null;
};

const me = await api("/me").catch((e) => {
  console.error(`[demo] não autenticou em ${PARROT_URL}: ${e.message}`);
  process.exit(1);
});
log(`autenticado como ${me.name} em ${PARROT_URL}`);

const socket = new WebSocket(`${PARROT_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(BOT_TOKEN)}`);

const ready = new Promise((resolve, reject) => {
  socket.addEventListener("message", (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "ready") resolve(data);
  });
  socket.addEventListener("error", () => reject(new Error("websocket caiu")));
  socket.addEventListener("close", (e) => reject(new Error(`websocket fechou (${e.code})`)));
});

const world = await ready;
const channel = pickChannel(world.channels);
if (!channel) {
  console.error("[demo] nenhum canal de texto encontrado");
  process.exit(1);
}
log(`postando em #${channel.name} (${channel.id})`);

const voice = world.channels.find((c) => c.kind === "voice" && (c.id === DEMO_VOICE || c.name === DEMO_VOICE)) ?? null;

const stage = { current: { ...TRACK }, positionMs: 12000, paused: false, radio: false, queue: [...STAGE_QUEUE] };

const stageBody = () => {
  if (!stage.current && stage.queue.length === 0) return null;
  const body = stageOf({ current: stage.current, positionMs: stage.positionMs, paused: stage.paused, queue: stage.queue, radio: stage.radio });
  remember(body);
  remember(body.player);
  for (const item of body.queue) remember(item);
  return body;
};

const pushStage = async () => {
  if (!voice) return;
  await api(`/voice/${voice.id}/stage`, { method: "PUT", body: stageBody() });
};

const applyStageAction = (actionId) => {
  const [verb, arg] = String(actionId ?? "").split(":");
  const seq = Number(arg);
  const durationMs = stage.current?.duration ? Math.round(stage.current.duration * 1000) : 0;
  const seekTo = (ms) => { stage.positionMs = Math.max(0, Math.min(durationMs - 2000, Math.round(ms))); };
  if (verb === "pause") stage.paused = true;
  else if (verb === "resume") stage.paused = false;
  else if (verb === "back10") seekTo(stage.positionMs - 10000);
  else if (verb === "forward10") seekTo(stage.positionMs + 10000);
  else if (verb === "seek") seekTo(Number(arg));
  else if (verb === "skip" || verb === "veto") { stage.current = stage.queue.shift() ?? null; stage.positionMs = 0; stage.paused = false; }
  else if (verb === "replay") { stage.positionMs = 0; stage.paused = false; }
  else if (verb === "stop") { stage.current = null; stage.queue = []; }
  else if (verb === "radio") stage.radio = !stage.radio;
  else if (verb === "clear") stage.queue = [];
  else if (verb === "remove") stage.queue = stage.queue.filter((t) => t.seq !== seq);
  else if (verb === "bump") {
    const index = stage.queue.findIndex((t) => t.seq === seq);
    if (index !== -1) stage.queue.unshift(...stage.queue.splice(index, 1));
  } else return false;
  return true;
};

socket.addEventListener("message", (event) => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type !== "cardAction") return;
  const label = labels.get(data.actionId) ?? data.actionId;
  const who = data.user?.name ?? "?";
  if (String(data.messageId ?? "").startsWith("stage:")) {
    log(`palco: ${who} clicou em ${label} (${data.actionId})`);
    if (applyStageAction(data.actionId)) pushStage().then(() => log(`palco republicado: ${stage.current?.title ?? "sem faixa"}, fila de ${stage.queue.length}`)).catch((e) => log(`falha no palco: ${e.message}`));
    return;
  }
  log(`cardAction: ${data.actionId} por ${who}`);
  post(channel.id, noteCard({ tone: "info", emoji: "👆", title: `${who === "?" ? "Alguém" : who} clicou em ${label}`, text: `actionId: ${data.actionId}` })).catch((e) => log(`falha ao responder: ${e.message}`));
});

const player = await post(channel.id, playerCard({ track: TRACK, state: "playing", positionMs: 12000, radio: false, queueLength: 2 }));
log("player postado, editando a cada 4s");

await sleep(STEP_MS);
await patch(channel.id, player.id, playerCard({ track: TRACK, state: "paused", positionMs: 42000, radio: false, queueLength: 2 }));

await sleep(STEP_MS);
await patch(channel.id, player.id, playerCard({ track: TRACK, state: "playing", positionMs: 74000, radio: true, queueLength: 2 }));

await sleep(STEP_MS);
await patch(channel.id, player.id, playerCard({ track: TRACK, state: "ended", positionMs: 186000, radio: true, queueLength: 1 }));

await post(channel.id, queuedCard(NEXT, 1));
await post(channel.id, queueCard(TRACK, [NEXT, RADIO], true));

for (const tone of ["info", "success", "warn", "error", "muted"]) {
  await post(channel.id, noteCard({ tone, emoji: "🎛️", title: `Aviso ${tone}`, text: "Card de aviso para conferir o tom no app.", actions: tone === "warn" ? [{ id: "enter", label: "Chamar de volta", icon: "enter" }] : [] }));
}

await post(channel.id, helpCard());

log("cards postados. Clique nos botões no app — respondo aqui.");

if (!voice) log(`nenhuma sala de voz "${DEMO_VOICE}" — pulando o palco (defina PARROT_DEMO_VOICE)`);
else {
  const joined = new Promise((resolve) => {
    const onVoice = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== "voice") return;
      if (!data.participants.some((p) => p.userId === world.me?.id && p.channelId === voice.id)) return;
      socket.removeEventListener("message", onVoice);
      resolve(true);
    };
    socket.addEventListener("message", onVoice);
    setTimeout(() => resolve(false), 5000);
  });
  socket.send(JSON.stringify({ type: "voiceState", channelId: voice.id, muted: false, camera: false, screen: false }));
  log(`entrando em 🔊${voice.name} (${voice.id})`);
  if (!(await joined)) log("o servidor não confirmou a entrada na sala; tentando publicar o palco assim mesmo");

  await pushStage();
  log(`palco publicado: tocando com fila de ${stage.queue.length}, editando a cada ${STAGE_STEP_MS / 1000}s`);

  await sleep(STAGE_STEP_MS);
  stage.paused = true;
  stage.positionMs = 42000;
  await pushStage();

  await sleep(STAGE_STEP_MS);
  stage.paused = false;
  stage.radio = true;
  stage.positionMs = 74000;
  await pushStage();

  await sleep(STAGE_STEP_MS);
  const upcoming = stage.queue.shift();
  if (upcoming) {
    stage.current = upcoming;
    stage.positionMs = 0;
  }
  await pushStage();
  log(`trocou de faixa: ${stage.current?.title ?? "sem faixa"}`);

  await sleep(STAGE_STEP_MS);
  stage.queue = [];
  await pushStage();
  log("fila vazia");
}

log(`clique nos botões ${voice ? "dos cards e do palco" : "dos cards"} no app — respondo aqui. Ctrl+C para sair.`);

process.on("SIGINT", () => {
  log("saindo");
  try { if (voice) socket.send(JSON.stringify({ type: "voiceState", channelId: null, muted: false, camera: false, screen: false })); } catch {}
  setTimeout(() => {
    try { socket.close(); } catch {}
    process.exit(0);
  }, 200);
});
