import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import {
  ATTENTION_MS, BEEP_FILE, COMMAND_MAX_SECONDS, DUCK_TIMEOUT_MS, DUCK_VOLUME, FF_FAST, FF_OUT, GROQ_KEY, HOT_USER_MS, LEAVE_VERBS,
  MAX_UTTERANCE_SECONDS, PAUSE_VERBS, PLAY_VERBS, PRINT_FLAT, REMIX_WORDS, RESUME_VERBS, SKIP_VERBS, SOURCE_NAMES, STOP_VERBS, YTDLP_BASE,
  cacheLookup, dropTrackFile, ensureBeep, fmtDur, gateAllowed, gateWake, infoFresh, isWakeWord, matchVerb, norm, parseCandidates, parseSource,
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

const world = { me: null, users: new Map(), channels: [], voice: [] };
const userName = (id) => world.users.get(id)?.name ?? id;
const isBotUser = (id) => world.users.get(id)?.isBot ?? world.users.get(id)?.email?.includes(BOT_DOMAIN_SUFFIX) ?? false;
const voiceChannelOf = (userId) => world.voice.find((v) => v.userId === userId)?.channelId ?? null;
const humansIn = (channelId) => world.voice.filter((v) => v.channelId === channelId && v.userId !== world.me?.id && !isBotUser(v.userId)).length;

const say = (channelId, content) => {
  if (!channelId) return;
  api(`/channels/${channelId}/messages`, { method: "POST", body: { content: content.slice(0, 3900) } }).catch((e) => log("chat", `falha ao enviar: ${e.message}`));
};

class PcmPlayer {
  constructor(source) {
    this.source = source;
    this.volume = 1;
    this.paused = false;
    this.token = 0;
    this.current = null;
    this.onEnd = null;
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

const nowPlayingText = (track) => {
  const parts = [`🎵 Tocando agora${track.radio ? " · Rádio" : ""}: ${track.title}`, track.url, `${track.radio ? "Sugestão do rádio" : `Pedido por ${track.by}`} · ${SOURCE_NAMES[track.source] ?? "—"}${fmtDur(track.duration) ? ` · ${fmtDur(track.duration)}` : ""}`];
  return parts.join("\n");
};
const queueText = () => [session.current ? `Agora · ${session.current.title}` : "Nada tocando.", ...session.queue.map((t, i) => `${i + 1} · ${t.title}${t.radio ? " · rádio" : ""}`)].join("\n");

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
      playNext();
    },
  }).catch((e) => {
    log("player", `erro: ${e.message}`);
    if (session.current === thisTrack) playNext();
  });
};

const playNext = () => {
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
  say(session.textChannelId, nowPlayingText(next));
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
  if (!track) { say(session.textChannelId, `Nada encontrado para “${query}”`); return; }
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
    say(session.textChannelId, `Na fila #${session.queue.indexOf(track) + 1} · ${track.title} · pedido por ${by}`);
  }
};

const stopAll = () => {
  for (const t of [session.current, ...session.queue]) dropTrackFile(t);
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
    say(session.textChannelId, `Rádio ligado por ${by} — quando a fila acabar eu sigo tocando parecidas`);
    if (!session.current) radioFill(true); else if (session.queue.length === 0) radioFill(false);
  } else {
    session.queue = session.queue.filter((t) => !t.radio);
    say(session.textChannelId, `Rádio desligado por ${by}`);
  }
};

const vetoCurrent = (by) => {
  const cur = session.current;
  if (!cur) return;
  const key = norm(cur.title).split(" ").slice(0, 3).join(" ");
  if (key) session.vetoed.add(key);
  say(session.textChannelId, `${by} vetou ${cur.title} — não repito nesta sessão`);
  playNext();
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
    say(session.textChannelId, `${who} pediu “${query}” — buscando…`);
    enqueue(query, who);
    return;
  }
  if (matchVerb(head, SKIP_VERBS)) { unduck(); say(session.textChannelId, `Pulada por ${who}`); playNext(); return; }
  if (matchVerb(head, PAUSE_VERBS)) { if (session.player) session.player.paused = true; say(session.textChannelId, `Pausada por ${who}`); return; }
  if (matchVerb(head, RESUME_VERBS)) { unduck(); if (session.player) session.player.paused = false; say(session.textChannelId, `Retomada por ${who}`); return; }
  if (matchVerb(head, STOP_VERBS) || /^cala/.test(head)) { stopAll(); say(session.textChannelId, `Parada por ${who} — fila limpa`); return; }
  if (LEAVE_VERBS.includes(head)) { say(session.textChannelId, `Até mais! Dispensado por ${who}.`); leave(); return; }
  if (wakeIdx !== -1) say(session.textChannelId, `Entendi “${rest}” — comando desconhecido`);
  log("wake", `não entendi: "${rest}"`);
};

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
    if (Date.now() - session.emptySince > EMPTY_MS) { say(session.textChannelId, "Sala vazia, saindo"); log("idle", "sala vazia, saindo"); leave(); }
    return;
  }
  session.emptySince = null;
  if (!session.current && Date.now() - session.lastActivity > IDLE_MS) {
    say(session.textChannelId, "5 minutos sem música e sem comando, vou nessa. Chame com !entra");
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
  Object.assign(session, { dead: false, queue: [], current: null, played: new Set(), vetoed: new Set(), radio: false, attention: new Map(), hotUsers: new Map(), recentCommands: new Map(), recentEnqueued: new Map(), emptySince: null });
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

const HELP = [
  "Como usar o Campeão",
  'Por voz (comigo na sala): "Campeão, toca <música>" — e também: pula, pausa, continua, para, sai.',
  'Com música tocando, diga só "Campeão": o som abaixa e eu escuto por 2s.',
  'Fonte específica: "…no YouTube" ou "…no SoundCloud". Sem indicar, o Deezer identifica a faixa oficial.',
  'Rádio: "Campeão, liga o rádio" — quando a fila acaba, sigo tocando parecidas. "Campeão, essa não" veta a atual.',
  "Saio sozinho após 5 min sem música e sem comando, ou 1 min com a sala vazia.",
  "Por texto: !entra !play !pula !pausa !continua !para !fila !radio !sai",
].join("\n");

const handleMessage = async (message) => {
  if (message.author.id === world.me?.id || message.author.isBot || !message.content.startsWith("!")) return;
  const [cmd, ...args] = message.content.slice(1).trim().split(/\s+/);
  const query = args.join(" ");
  const command = (cmd ?? "").toLowerCase();
  const who = message.author.name;
  if (["entra", "play", "p", "toca"].includes(command)) {
    const voiceChannel = voiceChannelOf(message.author.id);
    if (!voiceChannel) { say(message.channelId, "Entre numa sala de voz primeiro"); return; }
    try {
      await join(voiceChannel, message.channelId);
    } catch (e) {
      log("voz", `falha ao entrar: ${e.message}`);
      say(message.channelId, `Não consegui entrar na sala: ${e.message}`);
      return;
    }
    if (command === "entra") {
      say(message.channelId, ['Campeão na área. Fale "Campeão, toca <música>" — ou use !play <música>.', "Por voz também: pula · pausa · continua · para · sai", '"…no YouTube" ou "…no SoundCloud" força a fonte. !ajuda para o resto.'].join("\n"));
      return;
    }
    if (!query) { say(message.channelId, "Informe a música: !play wonderwall oasis"); return; }
    await enqueue(query, who);
    return;
  }
  if (!session.room) { if (command === "ajuda") say(message.channelId, HELP); return; }
  session.textChannelId = message.channelId;
  session.lastActivity = Date.now();
  if (command === "radio") setRadio(!session.radio, who);
  else if (["pula", "skip", "proxima"].includes(command)) playNext();
  else if (["para", "stop"].includes(command)) stopAll();
  else if (command === "pausa") { if (session.player) session.player.paused = true; }
  else if (["continua", "resume"].includes(command)) { if (session.player) session.player.paused = false; }
  else if (command === "fila") say(message.channelId, queueText());
  else if (["sai", "sair"].includes(command)) leave();
  else if (command === "ajuda") say(message.channelId, HELP);
};

const connectSocket = () => {
  const wsUrl = PARROT_URL.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(BOT_TOKEN)}`;
  socket = new WebSocket(wsUrl);
  socket.addEventListener("open", () => log("ws", "conectado"));
  socket.addEventListener("message", (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
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
  });
  socket.addEventListener("close", (event) => {
    log("ws", `fechou (${event.code}), reconectando em 3s`);
    setTimeout(connectSocket, 3000);
  });
  socket.addEventListener("error", () => {});
};

try { ensureBeep(); } catch (e) { log("beep", `falhou (seguindo sem): ${e.message}`); }
api("/me").then((me) => { log("boot", `autenticado como ${me.name} em ${PARROT_URL}`); connectSocket(); }).catch((e) => { console.error(`[parrot] não autenticou em ${PARROT_URL}: ${e.message}`); process.exit(1); });
process.on("SIGTERM", () => leave().finally(() => process.exit(0)));
