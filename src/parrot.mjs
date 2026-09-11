import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { helpCard, noteCard, playerCard, queueCard, queuedCard } from "./cards.mjs";
import {
  ATTENTION_MS, BEEP_FILE, COMMAND_MAX_SECONDS, DUCK_TIMEOUT_MS, DUCK_VOLUME, FF_FAST, FF_OUT, GROQ_KEY, HOT_USER_MS, LEAVE_VERBS,
  MAX_UTTERANCE_SECONDS, PAUSE_VERBS, PLAY_VERBS, PRINT_FLAT, REMIX_WORDS, RESUME_VERBS, SKIP_VERBS, STOP_VERBS, YTDLP_BASE,
  cacheLookup, dropTrackFile, ensureBeep, gateAllowed, gateWake, infoFresh, isWakeWord, matchVerb, norm, parseCandidates, parseSource,
  prefetch, resolveTrack, runYtdlp, shortErr, sliceSeconds, to16kMono, transcribe, videoIdOf,
} from "./core.mjs";

const PARROT_URL = (process.env.PARROT_URL ?? "https://parrot.arvore.dev").replace(/\/$/, "");
const BOT_TOKEN = process.env.PARROT_BOT_TOKEN;
const BOT_DOMAIN_SUFFIX = "@bots.";
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const SILENCE_MS = 600;
const MIN_UTTERANCE_MS = 600;
const VOICE_RMS = 350;
const IDLE_MS = 5 * 60 * 1000;
const EMPTY_MS = 60 * 1000;

if (!BOT_TOKEN) {
  console.error("[parrot] PARROT_BOT_TOKEN ausente, adapter desligado");
  process.exit(0);
}

const log = (tag, msg) => console.log(`[parrot:${tag}] ${msg}`);

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

const apiForm = async (path, form) => {
  const res = await fetch(`${PARROT_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOT_TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
};

const world = { me: null, users: new Map(), channels: [], voice: [] };
const userName = (id) => world.users.get(id)?.name ?? id;
const isBotUser = (id) => world.users.get(id)?.isBot ?? world.users.get(id)?.email?.includes(BOT_DOMAIN_SUFFIX) ?? false;
const voiceChannelOf = (userId) => world.voice.find((v) => v.userId === userId)?.channelId ?? null;
const humansIn = (channelId) => world.voice.filter((v) => v.channelId === channelId && v.userId !== world.me?.id && !isBotUser(v.userId)).length;

const say = (channelId, content) => {
  if (!channelId) return;
  api(`/channels/${channelId}/messages`, { method: "POST", body: { content: content.slice(0, 3900) } }).catch((e) => log("chat", `falha ao enviar: ${e.message}`));
};

const cardTracks = new Map();
const rememberTrack = (messageId, track) => {
  if (!messageId || !track) return;
  cardTracks.set(messageId, track);
  if (cardTracks.size > 200) cardTracks.delete(cardTracks.keys().next().value);
};

const postCard = async (channelId, card) => {
  if (!channelId) return null;
  try {
    return await api(`/channels/${channelId}/messages`, { method: "POST", body: { card } });
  } catch (e) {
    log("chat", `falha ao enviar card: ${e.message}`);
    return null;
  }
};

const note = (channelId, options) => postCard(channelId, noteCard(options));

const EDIT_MIN_GAP_MS = 1000;
const edits = new Map();

const flushEdit = (messageId) => {
  const entry = edits.get(messageId);
  if (!entry?.pending) return;
  const card = entry.pending;
  entry.pending = null;
  entry.lastAt = Date.now();
  if (entry.final) edits.delete(messageId);
  api(`/channels/${entry.channelId}/messages/${messageId}`, { method: "PATCH", body: { card } }).catch((e) => log("chat", `falha ao editar card: ${e.message}`));
};

const scheduleEdit = (messageId, channelId, card, { delay = 0, final = false } = {}) => {
  if (!messageId || !channelId) return;
  const entry = edits.get(messageId) ?? { channelId, lastAt: 0, timer: null, pending: null, final: false };
  if (entry.final) return;
  entry.channelId = channelId;
  entry.pending = card;
  entry.final = final;
  edits.set(messageId, entry);
  if (entry.timer) clearTimeout(entry.timer);
  const wait = Math.max(delay, entry.lastAt + EDIT_MIN_GAP_MS - Date.now());
  if (wait <= 0) {
    entry.timer = null;
    flushEdit(messageId);
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    flushEdit(messageId);
  }, wait);
};

class PcmPlayer {
  constructor(source) {
    this.source = source;
    this.volume = 1;
    this._paused = false;
    this.pausedAt = null;
    this.playedMs = 0;
    this.token = 0;
    this.current = null;
    this.onEnd = null;
  }

  get paused() {
    return this._paused;
  }

  set paused(value) {
    const on = Boolean(value);
    if (on === this._paused) return;
    this._paused = on;
    this.pausedAt = on ? Date.now() : null;
  }

  get playing() {
    return Boolean(this.current);
  }

  stop() {
    this.token++;
    const cur = this.current;
    this.current = null;
    if (cur) {
      try { cur.stream.destroy(); } catch {}
      this.source.clearQueue();
    }
  }

  async play(stream, { onEnd } = {}) {
    this.stop();
    const token = ++this.token;
    this.current = { stream };
    this.paused = false;
    this.playedMs = 0;
    let leftover = Buffer.alloc(0);
    let played = 0;
    const startedAt = Date.now();
    try {
      for await (const chunk of stream) {
        if (token !== this.token) return;
        let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
        let offset = 0;
        while (buf.length - offset >= FRAME_BYTES) {
          while (this.paused && token === this.token) await new Promise((r) => setTimeout(r, 50));
          if (token !== this.token) return;
          const slice = buf.subarray(offset, offset + FRAME_BYTES);
          const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
          const gain = this.volume;
          for (let i = 0; i < samples.length; i++) samples[i] = gain === 1 ? slice.readInt16LE(i * 2) : Math.max(-32768, Math.min(32767, Math.round(slice.readInt16LE(i * 2) * gain)));
          await this.source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
          played += FRAME_MS;
          this.playedMs = played;
          offset += FRAME_BYTES;
        }
        leftover = Buffer.from(buf.subarray(offset));
      }
      if (token !== this.token) return;
      await this.source.waitForPlayout().catch(() => {});
    } finally {
      if (token === this.token) {
        this.current = null;
        onEnd?.({ playedMs: played, elapsedMs: Date.now() - startedAt });
      }
    }
  }
}

const session = {
  room: null,
  channelId: null,
  textChannelId: null,
  source: null,
  player: null,
  queue: [],
  current: null,
  nowPlaying: null,
  procs: [],
  attention: new Map(),
  hotUsers: new Map(),
  lastGateAt: new Map(),
  recentCommands: new Map(),
  recentEnqueued: new Map(),
  seqCounter: 0,
  radio: false,
  radioFilling: false,
  played: new Set(),
  vetoed: new Set(),
  lastActivity: Date.now(),
  emptySince: null,
  duckTimer: null,
  idleTimer: null,
  listening: new Map(),
  dead: false,
};

const killProcs = () => {
  for (const p of session.procs) { try { p.kill("SIGKILL"); } catch {} }
  session.procs = [];
};

const duck = () => {
  if (!session.player?.playing) return;
  session.player.volume = DUCK_VOLUME;
  if (session.duckTimer) clearTimeout(session.duckTimer);
  session.duckTimer = setTimeout(unduck, DUCK_TIMEOUT_MS);
};
const unduck = () => {
  if (session.duckTimer) clearTimeout(session.duckTimer);
  session.duckTimer = null;
  if (session.player) session.player.volume = 1;
};

const beepFrames = () => {
  if (!existsSync(BEEP_FILE)) return null;
  return readFileSync(BEEP_FILE);
};
const playBeep = async () => {
  if (session.player?.playing) { duck(); return; }
  const pcm = beepFrames();
  if (!pcm || !session.source) return;
  for (let o = 0; o + FRAME_BYTES <= pcm.length; o += FRAME_BYTES) {
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset + o, FRAME_SAMPLES * CHANNELS).slice();
    await session.source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
  }
};

const positionNow = () => session.player?.playedMs ?? 0;

const livePlayerCard = (track) => playerCard({ track, state: session.player?.paused ? "paused" : "playing", positionMs: positionNow(), radio: session.radio, queueLength: session.queue.length });

const refreshPlayer = (delay = 0) => {
  const np = session.nowPlaying;
  if (!np) return;
  scheduleEdit(np.messageId, np.channelId, livePlayerCard(np.track), { delay });
};

const endPlayer = (state) => {
  const np = session.nowPlaying;
  if (!np) return;
  session.nowPlaying = null;
  scheduleEdit(np.messageId, np.channelId, playerCard({ track: np.track, state, positionMs: positionNow(), radio: session.radio, queueLength: session.queue.length }), { final: true });
};

const closeQueuedCard = (track, title, text) => {
  const messageId = track?.queuedMessageId;
  if (!messageId) return;
  track.queuedMessageId = null;
  scheduleEdit(messageId, track.queuedChannelId ?? session.textChannelId, noteCard({ tone: "muted", emoji: "🎵", title, text }), { final: true });
};

const postPlayer = async (track) => {
  const channelId = session.textChannelId;
  if (!channelId) return;
  const message = await postCard(channelId, playerCard({ track, state: "playing", positionMs: 0, radio: session.radio, queueLength: session.queue.length }));
  if (!message?.id) return;
  rememberTrack(message.id, track);
  if (session.current === track) session.nowPlaying = { messageId: message.id, channelId, track };
  else scheduleEdit(message.id, channelId, playerCard({ track, state: "skipped", positionMs: 0, radio: session.radio, queueLength: session.queue.length }), { final: true });
};

const startPlayback = (track, mode) => {
  killProcs();
  let ff;
  if (mode === "cache") {
    log("player", `tocando (cache): ${track.title}`);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", ...FF_FAST, "-i", track.file, ...FF_OUT]);
    session.procs = [ff];
  } else {
    const reusing = mode === "info" && infoFresh(track);
    log("player", `tocando (${reusing ? "info reaproveitado" : "extração completa"}): ${track.title}`);
    const args = reusing ? ["--load-info-json", track.infoFile] : ["--no-playlist", track.url];
    const ytdlp = spawn("yt-dlp", [...YTDLP_BASE, "-f", "bestaudio/best", "-q", "-o", "-", ...args]);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", "-i", "pipe:0", ...FF_OUT]);
    ytdlp.stderr.on("data", (d) => log("yt-dlp", d.toString().trim().slice(0, 200)));
    ytdlp.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    ytdlp.on("error", (e) => log("yt-dlp", `erro: ${e.message}`));
    session.procs = [ytdlp, ff];
    prefetch(track, "cache");
  }
  ff.on("error", (e) => log("ffmpeg", `erro: ${e.message}`));
  const thisTrack = track;
  session.player.play(ff.stdout, {
    onEnd: ({ playedMs }) => {
      if (session.current !== thisTrack) return;
      if (playedMs < 1500 && !thisTrack.retried) {
        thisTrack.retried = true;
        thisTrack.file = null;
        thisTrack.infoFile = null;
        log("player", `áudio não iniciou, refazendo pela via longa: ${thisTrack.title}`);
        startPlayback(thisTrack, "completa");
        return;
      }
      playNext("ended");
    },
  }).catch((e) => {
    log("player", `erro: ${e.message}`);
    if (session.current === thisTrack) playNext("ended");
  });
};

const playNext = (reason = "skipped") => {
  endPlayer(reason);
  killProcs();
  unduck();
  const next = session.queue.shift();
  session.current = next ?? null;
  if (!next) {
    session.player?.stop();
    if (session.radio) radioFill(true);
    return;
  }
  session.played.add(next.url);
  session.lastActivity = Date.now();
  const cached = next.file && existsSync(next.file) ? next.file : cacheLookup(next.url);
  if (cached) next.file = cached;
  startPlayback(next, cached ? "cache" : "info");
  closeQueuedCard(next, "Já tocou", next.title);
  postPlayer(next);
  if (session.radio && session.queue.length === 0) radioFill(false);
};

const radioSeed = () => [session.current?.url, ...[...session.played].reverse()].filter(Boolean).find(videoIdOf) ?? null;
const radioFill = async (playNow) => {
  if (!session.radio || session.radioFilling || session.dead) return;
  const seed = radioSeed();
  if (!seed) return;
  session.radioFilling = true;
  try {
    const id = videoIdOf(seed);
    const mix = parseCandidates(await runYtdlp(["-i", "--flat-playlist", "--playlist-end", "30", ...PRINT_FLAT, `https://www.youtube.com/watch?v=${id}&list=RD${id}`]));
    const pick = mix.find((c) => {
      const t = norm(c.title ?? "");
      if (!c.url || session.played.has(c.url) || session.queue.some((q) => q.url === c.url)) return false;
      if ([...session.vetoed].some((v) => t.includes(v))) return false;
      return !REMIX_WORDS.some((w) => t.includes(w));
    });
    if (!pick) { log("radio", "nenhuma sugestão nova no mix"); return; }
    log("radio", `sugestão: ${pick.title}`);
    const track = { title: pick.title, url: pick.url, source: "youtube", thumb: pick.thumbnail, duration: pick.duration, by: "Rádio", radio: true, seq: ++session.seqCounter };
    session.queue.push(track);
    prefetch(track, "radio");
    refreshPlayer(500);
    if (playNow && !session.current) playNext();
  } catch (e) {
    log("radio", `falhou: ${shortErr(e)}`);
  } finally {
    session.radioFilling = false;
  }
};

const enqueue = async (rawQuery, by) => {
  const { query, source } = parseSource(rawQuery);
  const seq = ++session.seqCounter;
  const track = await resolveTrack(query, source);
  if (!track) { note(session.textChannelId, { tone: "error", emoji: "🤷", title: `Nada encontrado para “${query}”`, text: "Tente outro nome, ou diga a fonte: “…no YouTube”." }); return; }
  track.by = by;
  track.seq = seq;
  const recentTs = session.recentEnqueued.get(track.url);
  const isDupe = session.current?.url === track.url || session.queue.some((t) => t.url === track.url) || (recentTs && Date.now() - recentTs < 60000);
  if (isDupe) { log("fila", `duplicata ignorada: ${track.title}`); return; }
  session.recentEnqueued.set(track.url, Date.now());
  if (session.recentEnqueued.size > 50) session.recentEnqueued.delete(session.recentEnqueued.keys().next().value);
  const idx = session.queue.findIndex((t) => t.seq > seq);
  if (idx === -1) session.queue.push(track); else session.queue.splice(idx, 0, track);
  if (!session.current) playNext();
  else {
    prefetch(track);
    refreshPlayer(500);
    const channelId = session.textChannelId;
    const message = await postCard(channelId, queuedCard(track, session.queue.indexOf(track) + 1));
    if (message?.id) {
      track.queuedMessageId = message.id;
      track.queuedChannelId = channelId;
      rememberTrack(message.id, track);
    }
  }
};

const stopAll = () => {
  endPlayer("stopped");
  for (const t of [session.current, ...session.queue]) {
    closeQueuedCard(t, "Saiu da fila", t?.title ?? "");
    dropTrackFile(t);
  }
  session.queue = [];
  session.current = null;
  killProcs();
  unduck();
  session.player?.stop();
};

const setRadio = (on, by) => {
  session.radio = on;
  session.lastActivity = Date.now();
  if (on) {
    note(session.textChannelId, { tone: "success", emoji: "📻", title: `Rádio ligado por ${by}`, text: "Quando a fila acabar eu sigo tocando parecidas." });
    if (!session.current) radioFill(true); else if (session.queue.length === 0) radioFill(false);
  } else {
    for (const suggestion of session.queue.filter((t) => t.radio)) closeQueuedCard(suggestion, "Saiu da fila", "Rádio desligado.");
    session.queue = session.queue.filter((t) => !t.radio);
    note(session.textChannelId, { tone: "muted", emoji: "📻", title: `Rádio desligado por ${by}`, text: "Tirei as sugestões da fila." });
  }
  refreshPlayer();
};

const vetoCurrent = (by) => {
  const cur = session.current;
  if (!cur) return;
  const key = norm(cur.title).split(" ").slice(0, 3).join(" ");
  if (key) session.vetoed.add(key);
  note(session.textChannelId, { tone: "muted", emoji: "👎", title: `${by} vetou ${cur.title}`, text: "Não repito nesta sessão." });
  playNext();
};

const skipBy = (by) => {
  note(session.textChannelId, { tone: "muted", emoji: "⏭️", title: `Pulada por ${by}`, text: session.current?.title ?? "" });
  playNext();
};

const pauseBy = (by) => {
  if (session.player) session.player.paused = true;
  note(session.textChannelId, { tone: "muted", emoji: "⏸️", title: `Pausada por ${by}`, text: session.current?.title ?? "" });
  refreshPlayer();
};

const resumeBy = (by) => {
  unduck();
  if (session.player) session.player.paused = false;
  note(session.textChannelId, { tone: "muted", emoji: "▶️", title: `Retomada por ${by}`, text: session.current?.title ?? "" });
  refreshPlayer();
};

const stopBy = (by) => {
  stopAll();
  note(session.textChannelId, { tone: "muted", emoji: "⏹️", title: `Parada por ${by}`, text: "Fila limpa." });
};

const takeFromQueue = (seq, channelId) => {
  const index = session.queue.findIndex((t) => t.seq === seq);
  if (index === -1) {
    note(channelId, { tone: "muted", emoji: "🤷", title: "Essa já saiu da fila", text: "" });
    return null;
  }
  return session.queue.splice(index, 1)[0];
};

const bumpBy = (seq, by, channelId) => {
  const track = takeFromQueue(seq, channelId);
  if (!track) return;
  session.queue.unshift(track);
  if (track.queuedMessageId) scheduleEdit(track.queuedMessageId, track.queuedChannelId ?? channelId, queuedCard(track, 1));
  note(channelId, { tone: "muted", emoji: "⏫", title: `${by} puxou pra frente`, text: track.title });
  refreshPlayer(500);
};

const removeBy = (seq, by, channelId) => {
  const track = takeFromQueue(seq, channelId);
  if (!track) return;
  dropTrackFile(track);
  closeQueuedCard(track, `Tirada da fila por ${by}`, track.title);
  refreshPlayer(500);
};

const handleVoice = (userId, raw, startedAt) => {
  if (session.dead) return;
  const text = norm(raw);
  if (!text) return;
  const dupeKey = `${userId}:${text}`;
  if (Date.now() - (session.recentCommands.get(dupeKey) ?? 0) < 6000) { log("wake", `comando repetido ignorado: "${text}"`); return; }
  session.recentCommands.set(dupeKey, Date.now());
  if (session.recentCommands.size > 40) session.recentCommands.delete(session.recentCommands.keys().next().value);
  const words = text.split(" ");
  const wakeIdx = words.findIndex(isWakeWord);
  const attentive = (session.attention.get(userId) ?? 0) > startedAt;
  let rest;
  if (wakeIdx !== -1 && wakeIdx <= 4) rest = words.slice(wakeIdx + 1).join(" ");
  else if (attentive) rest = text;
  else return;
  session.attention.delete(userId);
  session.lastActivity = Date.now();
  session.hotUsers.set(userId, Date.now() + HOT_USER_MS);
  log("wake", `comando: "${rest}"`);
  const who = userName(userId);
  if (rest === "" || /^(oi|ola|fala|ei)$/.test(rest)) { session.attention.set(userId, Date.now() + ATTENTION_MS); playBeep(); return; }
  const restWords = rest.split(" ").filter((w) => !["ai", "ei", "vai", "ow", "o"].includes(w));
  const head = restWords[0] ?? "";
  const tail = restWords.slice(1).join(" ");
  const mentionsRadio = restWords.length <= 2 && restWords.some((w) => matchVerb(w, ["radio"]));
  if (mentionsRadio) {
    const off = ["para", "parar", "desliga", "desligar", "tira", "encerra", "cancela"].some((v) => matchVerb(head, [v]));
    setRadio(!off, who);
    return;
  }
  if (/^(essa|esta|essa nao|nao gostei|tira essa|veta|odeio)/.test(rest) && /(nao|gostei|tira|veta|odeio)/.test(rest)) { vetoCurrent(who); return; }
  if (matchVerb(head, PLAY_VERBS)) {
    const query = tail.replace(/^(a musica |o som |a |um |uma )/, "").replace(/\s+(ai|por favor|pra mim|pra gente|rapidao|agora)$/, "").trim();
    if (!query) return;
    unduck();
    note(session.textChannelId, { tone: "info", emoji: "🔎", title: `${who} pediu “${query}”`, text: "Buscando…" });
    enqueue(query, who);
    return;
  }
  if (matchVerb(head, SKIP_VERBS)) { unduck(); skipBy(who); return; }
  if (matchVerb(head, PAUSE_VERBS)) { pauseBy(who); return; }
  if (matchVerb(head, RESUME_VERBS)) { unduck(); resumeBy(who); return; }
  if (matchVerb(head, STOP_VERBS) || /^cala/.test(head)) { stopBy(who); return; }
  if (LEAVE_VERBS.includes(head)) { note(session.textChannelId, { tone: "muted", emoji: "👋", title: "Até mais!", text: `Dispensado por ${who}.` }); leave(); return; }
  if (wakeIdx !== -1) note(session.textChannelId, { tone: "muted", emoji: "🤔", title: `Entendi “${rest}”`, text: "Comando desconhecido." });
  log("wake", `não entendi: "${rest}"`);
};

const CALL_BACK_ACTION = { id: "enter", label: "Chamar de volta", icon: "enter" };

const rmsOf = (frame) => {
  let sum = 0;
  const data = frame.data;
  const step = Math.max(1, Math.floor(data.length / 480));
  let n = 0;
  for (let i = 0; i < data.length; i += step) { sum += data[i] * data[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
};

const listenTo = async (track, participant) => {
  const userId = participant.identity;
  if (session.listening.has(userId)) return;
  const state = { chunks: [], bytes: 0, speaking: false, silentMs: 0, startedAt: 0, aborted: false };
  session.listening.set(userId, state);
  const stream = new AudioStream(track, SAMPLE_RATE, CHANNELS);
  const finish = async () => {
    const pcm = Buffer.concat(state.chunks);
    state.chunks = [];
    state.bytes = 0;
    state.speaking = false;
    const secs = pcm.length / (SAMPLE_RATE * CHANNELS * 2);
    if (secs < MIN_UTTERANCE_MS / 1000) return;
    const startedAt = state.startedAt;
    const finishedAt = Date.now();
    const attentive = (session.attention.get(userId) ?? 0) > startedAt;
    if (attentive) playBeep();
    const hot = (session.hotUsers.get(userId) ?? 0) > Date.now();
    const priority = attentive || hot;
    const who = userName(userId);
    if (!priority && GROQ_KEY) {
      if (!gateAllowed(session, userId)) return;
      const head = to16kMono(sliceSeconds(pcm, 1.5));
      if (!(await gateWake(head, who))) return;
    }
    const pcm16 = to16kMono(sliceSeconds(pcm, COMMAND_MAX_SECONDS));
    const text = await transcribe(pcm16, priority);
    log("stt", `${who}${hot && !attentive ? " (atalho)" : ""}: "${text}" [${Date.now() - finishedAt}ms]`);
    if (text) handleVoice(userId, text, startedAt);
  };
  try {
    for await (const frame of stream) {
      if (session.dead || session.listening.get(userId) !== state) break;
      const loud = rmsOf(frame) > VOICE_RMS;
      const frameMs = (frame.samplesPerChannel / frame.sampleRate) * 1000;
      if (loud) {
        if (!state.speaking) { state.speaking = true; state.startedAt = Date.now(); state.aborted = false; }
        state.silentMs = 0;
      } else if (state.speaking) {
        state.silentMs += frameMs;
      }
      if (state.speaking && !state.aborted) {
        const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        state.chunks.push(Buffer.from(buf));
        state.bytes += buf.length;
        if (state.bytes > MAX_UTTERANCE_SECONDS * SAMPLE_RATE * CHANNELS * 2) {
          state.aborted = true;
          state.chunks = [];
          state.bytes = 0;
          log("voz", `fala de ${userName(userId)} passou de ${MAX_UTTERANCE_SECONDS}s, cortando captura`);
        }
        if (state.silentMs >= SILENCE_MS) {
          const done = finish();
          done.catch((e) => log("voz", `erro: ${e.message}`));
        }
      } else if (state.speaking && state.silentMs >= SILENCE_MS) {
        state.speaking = false;
        state.aborted = false;
      }
    }
  } catch (e) {
    log("voz", `stream de ${userName(userId)} caiu: ${e.message}`);
  } finally {
    if (session.listening.get(userId) === state) session.listening.delete(userId);
  }
};

const checkIdle = () => {
  if (session.dead || !session.channelId) return;
  if (humansIn(session.channelId) === 0) {
    session.emptySince ??= Date.now();
    if (Date.now() - session.emptySince > EMPTY_MS) { note(session.textChannelId, { tone: "warn", emoji: "👋", title: "Sala vazia, saindo", text: "Me chame de volta quando quiser som.", actions: [CALL_BACK_ACTION] }); log("idle", "sala vazia, saindo"); leave(); }
    return;
  }
  session.emptySince = null;
  if (!session.current && Date.now() - session.lastActivity > IDLE_MS) {
    note(session.textChannelId, { tone: "warn", emoji: "💤", title: "5 minutos sem música e sem comando", text: "Vou nessa — me chame com !entra.", actions: [CALL_BACK_ACTION] });
    log("idle", "ocioso 5min, saindo");
    leave();
  }
};

const leave = async () => {
  if (session.dead) return;
  session.dead = true;
  if (session.idleTimer) clearInterval(session.idleTimer);
  stopAll();
  const room = session.room;
  session.room = null;
  session.channelId = null;
  session.listening.clear();
  try { await room?.disconnect(); } catch {}
  sendVoiceState(null);
  Object.assign(session, { dead: false, queue: [], current: null, nowPlaying: null, played: new Set(), vetoed: new Set(), radio: false, attention: new Map(), hotUsers: new Map(), recentCommands: new Map(), recentEnqueued: new Map(), emptySince: null });
  log("voz", "saí da sala");
};

const join = async (channelId, textChannelId) => {
  session.textChannelId = textChannelId;
  if (session.room && session.channelId === channelId) return true;
  if (session.room) await leave();
  const { url, token } = await api(`/voice/${channelId}/token`);
  const room = new Room();
  session.room = room;
  session.channelId = channelId;
  session.dead = false;
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    if (publication.name === "soundboard" || isBotUser(participant.identity)) return;
    listenTo(track, participant).catch((e) => log("voz", `escuta falhou: ${e.message}`));
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => session.listening.delete(participant.identity));
  room.on(RoomEvent.Disconnected, () => { if (session.room === room) { log("voz", "desconectado pelo servidor"); leave(); } });
  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  session.source = new AudioSource(SAMPLE_RATE, CHANNELS);
  session.player = new PcmPlayer(session.source);
  const localTrack = LocalAudioTrack.createAudioTrack("campeao", session.source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(localTrack, options);
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track && publication.kind === TrackKind.KIND_AUDIO && publication.name !== "soundboard" && !isBotUser(participant.identity)) listenTo(publication.track, participant).catch(() => {});
    }
  }
  session.lastActivity = Date.now();
  session.idleTimer = setInterval(checkIdle, 30000);
  sendVoiceState(channelId);
  const channel = world.channels.find((c) => c.id === channelId);
  log("voz", `entrei em "${channel?.name ?? channelId}"`);
  return true;
};

let socket = null;
const sendVoiceState = (channelId) => {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "voiceState", channelId, muted: false, camera: false, screen: false }));
};

const enterVoice = async (userId, textChannelId) => {
  const voiceChannel = voiceChannelOf(userId);
  if (!voiceChannel) {
    note(textChannelId, { tone: "warn", emoji: "🎧", title: "Entre numa sala de voz primeiro", text: "Depois me chame com !entra." });
    return false;
  }
  try {
    await join(voiceChannel, textChannelId);
    return true;
  } catch (e) {
    log("voz", `falha ao entrar: ${e.message}`);
    note(textChannelId, { tone: "error", emoji: "⚠️", title: "Não consegui entrar na sala", text: e.message });
    return false;
  }
};

const handleMessage = async (message) => {
  if (message.author.id === world.me?.id || message.author.isBot || !message.content.startsWith("!")) return;
  const [cmd, ...args] = message.content.slice(1).trim().split(/\s+/);
  const query = args.join(" ");
  const command = (cmd ?? "").toLowerCase();
  const who = message.author.name;
  if (["entra", "play", "p", "toca"].includes(command)) {
    if (!(await enterVoice(message.author.id, message.channelId))) return;
    if (command === "entra") { postCard(message.channelId, helpCard("Campeão na área")); return; }
    if (!query) { note(message.channelId, { tone: "warn", emoji: "🎧", title: "Informe a música", text: "Exemplo: !play wonderwall oasis" }); return; }
    await enqueue(query, who);
    return;
  }
  if (!session.room) { if (command === "ajuda") postCard(message.channelId, helpCard()); return; }
  session.textChannelId = message.channelId;
  session.lastActivity = Date.now();
  if (command === "radio") setRadio(!session.radio, who);
  else if (["pula", "skip", "proxima"].includes(command)) playNext();
  else if (["para", "stop"].includes(command)) stopAll();
  else if (command === "pausa") { if (session.player) session.player.paused = true; refreshPlayer(); }
  else if (["continua", "resume"].includes(command)) { if (session.player) session.player.paused = false; refreshPlayer(); }
  else if (command === "fila") postCard(message.channelId, queueCard(session.current, session.queue, session.radio));
  else if (["sai", "sair"].includes(command)) leave();
  else if (command === "ajuda") postCard(message.channelId, helpCard());
};

const handleCardAction = async ({ messageId, channelId, actionId, user }) => {
  const who = user?.name ?? "alguém";
  session.lastActivity = Date.now();
  const [verb, arg] = String(actionId ?? "").split(":");
  log("card", `${who} clicou em ${actionId}`);
  if (verb === "enter") {
    if (await enterVoice(user?.id, channelId)) postCard(channelId, helpCard("Campeão na área"));
    return;
  }
  if (verb === "replay") {
    const track = cardTracks.get(messageId);
    if (!track?.url) { note(channelId, { tone: "muted", emoji: "🤷", title: "Perdi essa faixa", text: "Peça de novo com !play." }); return; }
    if (!session.room && !(await enterVoice(user?.id, channelId))) return;
    session.textChannelId = channelId;
    await enqueue(track.url, who);
    return;
  }
  if (!session.room || session.dead) {
    note(channelId, { tone: "muted", emoji: "🎧", title: "Não estou tocando nada", text: "Me chame com !entra de dentro da sala de voz." });
    return;
  }
  session.textChannelId = channelId;
  if (verb === "pause") pauseBy(who);
  else if (verb === "resume") resumeBy(who);
  else if (verb === "skip") skipBy(who);
  else if (verb === "veto") vetoCurrent(who);
  else if (verb === "stop") stopBy(who);
  else if (verb === "radio") setRadio(!session.radio, who);
  else if (verb === "queue") postCard(channelId, queueCard(session.current, session.queue, session.radio));
  else if (verb === "bump") bumpBy(Number(arg), who, channelId);
  else if (verb === "remove") removeBy(Number(arg), who, channelId);
};

const WS_CONNECT_TIMEOUT_MS = 10000;
const WS_RETRY_MIN_MS = 3000;
const WS_RETRY_MAX_MS = 30000;
const WS_WATCHDOG_MS = 15000;
let reconnectTimer = null;
let retryMs = WS_RETRY_MIN_MS;
let connectingSince = 0;

const scheduleReconnect = (why) => {
  if (reconnectTimer) return;
  log("ws", `${why}, reconectando em ${Math.round(retryMs / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, retryMs);
  retryMs = Math.min(WS_RETRY_MAX_MS, retryMs * 2);
};

const handleSocketEvent = (data) => {
  if (data.type === "ready") {
    world.me = data.me;
    world.users = new Map(data.users.map((u) => [u.id, u]));
    world.channels = data.channels;
    world.voice = data.voice;
    log("ws", `pronto como ${data.me.name}; ${data.channels.length} canais, ${data.users.size ?? data.users.length} usuários`);
    if (session.channelId) sendVoiceState(session.channelId);
  } else if (data.type === "user") world.users.set(data.user.id, data.user);
  else if (data.type === "channel") world.channels = [...world.channels.filter((c) => c.id !== data.channel.id), data.channel];
  else if (data.type === "channelDeleted") world.channels = world.channels.filter((c) => c.id !== data.channelId);
  else if (data.type === "voice") { world.voice = data.participants; if (session.channelId) checkIdle(); }
  else if (data.type === "message") handleMessage(data.message).catch((e) => log("chat", `erro: ${e.message}`));
  else if (data.type === "cardAction") handleCardAction(data).catch((e) => log("card", `erro: ${e.message}`));
};

const connectSocket = () => {
  const wsUrl = PARROT_URL.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(BOT_TOKEN)}`;
  const ws = new WebSocket(wsUrl);
  socket = ws;
  connectingSince = Date.now();
  const connectTimer = setTimeout(() => {
    if (socket !== ws || ws.readyState !== WebSocket.CONNECTING) return;
    log("ws", `conexão travou por ${WS_CONNECT_TIMEOUT_MS / 1000}s, desistindo dela`);
    try { ws.close(); } catch {}
    if (socket === ws) {
      socket = null;
      scheduleReconnect("conexão abandonada");
    }
  }, WS_CONNECT_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    clearTimeout(connectTimer);
    retryMs = WS_RETRY_MIN_MS;
    log("ws", "conectado");
  });
  ws.addEventListener("message", (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleSocketEvent(data);
  });
  ws.addEventListener("close", (event) => {
    clearTimeout(connectTimer);
    if (socket !== ws) return;
    socket = null;
    scheduleReconnect(`fechou (${event.code})`);
  });
  ws.addEventListener("error", () => {});
};

setInterval(() => {
  if (reconnectTimer) return;
  if (!socket) { scheduleReconnect("sem conexão"); return; }
  if (socket.readyState === WebSocket.CONNECTING && Date.now() - connectingSince > WS_CONNECT_TIMEOUT_MS + WS_WATCHDOG_MS) {
    const stuck = socket;
    socket = null;
    try { stuck.close(); } catch {}
    scheduleReconnect("conexão presa");
  }
}, WS_WATCHDOG_MS).unref();

const AVATAR_HASH_FILE = `${existsSync("/data") ? "/data" : tmpdir()}/parrot-avatar.hash`;

const discordProfile = async () => {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 80)}`);
    return await res.json();
  } catch (e) {
    log("perfil", `não li o perfil do Discord: ${e.message}`);
    return null;
  }
};

const syncAvatar = async (me, profile) => {
  if (!profile?.avatar) return;
  try {
    const stored = existsSync(AVATAR_HASH_FILE) ? readFileSync(AVATAR_HASH_FILE, "utf8").trim() : null;
    if (me.avatarUrl && stored === profile.avatar) return;
    const ext = profile.avatar.startsWith("a_") ? "gif" : "png";
    const res = await fetch(`https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${ext}?size=512`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`cdn -> ${res.status}`);
    const form = new FormData();
    form.append("file", new Blob([await res.arrayBuffer()], { type: ext === "gif" ? "image/gif" : "image/png" }), `avatar.${ext}`);
    await apiForm("/me/avatar", form);
    writeFileSync(AVATAR_HASH_FILE, profile.avatar);
    log("perfil", "avatar do Discord enviado");
  } catch (e) {
    log("perfil", `falha no avatar: ${e.message}`);
  }
};

const syncIdentity = async (me) => {
  const profile = await discordProfile();
  const name = process.env.PARROT_BOT_NAME ?? profile?.global_name ?? profile?.username ?? "Campeão";
  try {
    if (name && name !== me.name) {
      await api("/me", { method: "PATCH", body: { name } });
      log("perfil", `nome ajustado para ${name}`);
    }
  } catch (e) {
    log("perfil", `falha ao ajustar o nome: ${e.message}`);
  }
  await syncAvatar(me, profile);
};

try { ensureBeep(); } catch (e) { log("beep", `falhou (seguindo sem): ${e.message}`); }
api("/me")
  .then(async (me) => {
    log("boot", `autenticado como ${me.name} em ${PARROT_URL}`);
    await syncIdentity(me).catch((e) => log("perfil", `falhou: ${e.message}`));
    connectSocket();
  })
  .catch((e) => { console.error(`[parrot] não autenticou em ${PARROT_URL}: ${e.message}`); process.exit(1); });
process.on("SIGTERM", () => leave().finally(() => process.exit(0)));
