import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CACHE_DIR ??= join(tmpdir(), "campeao-demo-tracks");

const { helpCard, noteCard, playerCard, queueCard, queuedCard } = await import("../src/cards.mjs");

const PARROT_URL = (process.env.PARROT_URL ?? "https://parrot.arvore.dev").replace(/\/$/, "");
const BOT_TOKEN = process.env.PARROT_BOT_TOKEN;
const DEMO_CHANNEL = process.env.PARROT_DEMO_CHANNEL ?? "geral";
const STEP_MS = 4000;

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
  for (const action of card.actions ?? []) labels.set(action.id, action.label);
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
const NEXT = { title: "Legião Urbana — Tempo Perdido", url: "https://www.youtube.com/watch?v=nOOHSGmLNXE", duration: 297, by: "Marina", source: "youtube", seq: 2 };
const RADIO = { title: "Skank — É uma Partida de Futebol", url: "https://www.youtube.com/watch?v=n3nrjyNcTFk", duration: 210, by: "Rádio", radio: true, source: "youtube", seq: 3 };

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

socket.addEventListener("message", (event) => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type !== "cardAction") return;
  const label = labels.get(data.actionId) ?? data.actionId;
  log(`cardAction: ${data.actionId} por ${data.user?.name ?? "?"}`);
  post(channel.id, noteCard({ tone: "info", emoji: "👆", title: `${data.user?.name ?? "Alguém"} clicou em ${label}`, text: `actionId: ${data.actionId}` })).catch((e) => log(`falha ao responder: ${e.message}`));
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

log("cards postados. Clique nos botões no app — respondo aqui. Ctrl+C para sair.");

process.on("SIGINT", () => {
  log("saindo");
  try { socket.close(); } catch {}
  process.exit(0);
});
