import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";
import {
  ATTENTION_MS,
  BEEP_FILE,
  CACHE_DIR,
  CACHE_MAX_FILES,
  COMMAND_MAX_SECONDS,
  COOKIES_FILE,
  DUCK_TIMEOUT_MS,
  DUCK_VOLUME,
  FF_FAST,
  FF_OUT,
  GATE_CONCURRENCY,
  GATE_MIN_INTERVAL_BUSY_MS,
  GATE_MIN_INTERVAL_MS,
  GATE_QUEUE_TIMEOUT_MS,
  GATE_SECONDS,
  GATE_STOP,
  GROQ_KEY,
  HOT_USER_MS,
  INFO_DIR,
  INFO_TTL_MS,
  JITTER_BYTES,
  LEAVE_VERBS,
  LOW_PRIO,
  MAX_UTTERANCE_SECONDS,
  PAUSE_VERBS,
  PLAY_VERBS,
  POT_URL,
  PRINT_FLAT,
  PRINT_FULL,
  REMIX_WORDS,
  RESUBSCRIBE_COOLDOWN_MS,
  RESUME_VERBS,
  SKIP_VERBS,
  SOURCE_NAMES,
  STOP_VERBS,
  STT_URL,
  Semaphore,
  WAKE_WORDS,
  YTDLP_BASE,
  avg,
  cacheCleanPartials,
  cacheEvict,
  cacheKey,
  cacheLookup,
  deezerLookup,
  dropTrackFile,
  editDistance,
  ensureBeep,
  execFileP,
  fmtDur,
  gateAllowed,
  gateHasWake,
  gateSem,
  gateStats,
  gateWake,
  groqHits,
  groqSlotFree,
  groqTranscribe,
  hasCookies,
  infoFresh,
  isWakeWord,
  localTranscribe,
  matchVerb,
  norm,
  parseCandidates,
  parseSource,
  prefetch,
  pruneInfo,
  resolveTrack,
  runYtdlp,
  scoreCandidate,
  shortErr,
  sliceSeconds,
  sourceArgs,
  spawnLow,
  sttPending,
  to16kMono,
  transcribe,
  videoIdOf,
  wavFrom,
} from "./core.mjs";

const TOKEN = process.env.DISCORD_TOKEN;

const guilds = new Map();

function getState(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      guildId,
      connection: null,
      player: null,
      queue: [],
      current: null,
      currentResource: null,
      procs: [],
      textChannel: null,
      listening: new Set(),
      attention: new Map(),
      duckTimer: null,
      seqCounter: 0,
      recentEnqueued: new Map(),
      recentCommands: new Map(),
      hotUsers: new Map(),
      lastGateAt: new Map(),
      dead: false,
      radio: false,
      radioFilling: false,
      played: new Set(),
      vetoed: new Set(),
      lastActivity: Date.now(),
      guild: null,
      nowPlayingMessage: null,
    });
  }
  return guilds.get(guildId);
}

function killProcs(gs) {
  for (const p of gs.procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  gs.procs = [];
}

function startPlayback(gs, track, mode) {
  killProcs(gs);
  let ff;
  if (mode === "cache") {
    console.log(`[player] tocando (cache): ${track.title}`);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", ...FF_FAST, "-i", track.file, ...FF_OUT]);
    gs.procs = [ff];
  } else {
    const reusing = mode === "info" && infoFresh(track);
    console.log(`[player] tocando (${reusing ? "info reaproveitado" : "extração completa"}): ${track.title}`);
    const args = reusing ? ["--load-info-json", track.infoFile] : ["--no-playlist", track.url];
    const ytdlp = spawn("yt-dlp", [...YTDLP_BASE, "-f", "bestaudio/best", "-q", "-o", "-", ...args]);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", "-i", "pipe:0", ...FF_OUT]);
    ytdlp.stderr.on("data", (d) => console.log(`[yt-dlp] ${d.toString().trim().slice(0, 200)}`));
    ytdlp.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    ytdlp.on("error", (e) => console.log("[yt-dlp] erro:", e.message));
    gs.procs = [ytdlp, ff];
    prefetch(track, "cache");
  }
  ff.on("error", (e) => console.log("[ffmpeg] erro:", e.message));
  const jitter = new PassThrough({ highWaterMark: JITTER_BYTES });
  jitter.on("error", () => {});
  ff.stdout.pipe(jitter);
  const resource = createAudioResource(jitter, { inputType: StreamType.Raw, inlineVolume: true });
  gs.currentResource = resource;
  gs.player.play(resource);
}

function playNext(gs) {
  killProcs(gs);
  unduck(gs);
  const next = gs.queue.shift();
  gs.current = next ?? null;
  gs.currentResource = null;
  if (!next) {
    if (gs.radio) radioFill(gs, true);
    return;
  }
  gs.played.add(next.url);
  gs.lastActivity = Date.now();
  const cached = next.file && existsSync(next.file) ? next.file : cacheLookup(next.url);
  if (cached) next.file = cached;
  startPlayback(gs, next, cached ? "cache" : "info");
  sendNowPlaying(gs, next);
  if (gs.radio && gs.queue.length === 0) radioFill(gs, false);
}

function radioSeed(gs) {
  const url = [gs.current?.url, ...[...gs.played].reverse()].filter(Boolean).find(videoIdOf);
  return url ? { url } : null;
}

async function radioFill(gs, playNow) {
  if (!gs.radio || gs.radioFilling || gs.dead) return;
  const seed = radioSeed(gs);
  if (!seed) return;
  gs.radioFilling = true;
  try {
    const id = videoIdOf(seed.url);
    const mix = parseCandidates(
      await runYtdlp(["-i", "--flat-playlist", "--playlist-end", "30", ...PRINT_FLAT, `https://www.youtube.com/watch?v=${id}&list=RD${id}`]),
    );
    const pick = mix.find((c) => {
      const t = norm(c.title ?? "");
      if (!c.url || gs.played.has(c.url) || gs.queue.some((q) => q.url === c.url)) return false;
      if ([...gs.vetoed].some((v) => t.includes(v))) return false;
      return !REMIX_WORDS.some((w) => t.includes(w));
    });
    if (!pick) {
      console.log("[radio] nenhuma sugestão nova no mix");
      return;
    }
    console.log(`[radio] sugestão: ${pick.title}`);
    const track = {
      title: pick.title,
      url: pick.url,
      source: "youtube",
      thumb: pick.thumbnail,
      duration: pick.duration,
      by: "Rádio",
      radio: true,
      seq: ++gs.seqCounter,
    };
    gs.queue.push(track);
    prefetch(track, "radio");
    if (playNow && !gs.current) playNext(gs);
  } catch (e) {
    console.log(`[radio] falhou: ${shortErr(e)}`);
  } finally {
    gs.radioFilling = false;
  }
}

const GOLD = 0xd4a017;
const GRAY = 0x4f545c;

function nowPlayingEmbed(track) {
  const fields = [
    { name: track.radio ? "Sugestão do rádio" : "Pedido por", value: track.by, inline: true },
    { name: "Fonte", value: SOURCE_NAMES[track.source] ?? "—", inline: true },
  ];
  const dur = fmtDur(track.duration);
  if (dur) fields.push({ name: "Duração", value: dur, inline: true });
  return {
    author: { name: track.radio ? "Tocando agora · Rádio" : "Tocando agora" },
    title: track.title,
    url: track.url,
    color: track.radio ? 0x5865f2 : GOLD,
    thumbnail: track.thumb ? { url: track.thumb } : undefined,
    fields,
    footer: { text: "Campeão" },
  };
}

const BTN = { PRIMARY: 1, SECONDARY: 2, DANGER: 4 };

function controlRows(gs) {
  const paused = gs.player?.state?.status === AudioPlayerStatus.Paused;
  return [
    {
      type: 1,
      components: [
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:pause", label: paused ? "Retomar" : "Pausar" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:skip", label: "Pular" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:veto", label: "Não curti" },
        { type: 2, style: BTN.DANGER, custom_id: "cmp:stop", label: "Parar" },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: gs.radio ? BTN.PRIMARY : BTN.SECONDARY, custom_id: "cmp:radio", label: gs.radio ? "Rádio ligado" : "Ligar rádio" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:queue", label: "Ver fila" },
      ],
    },
  ];
}

async function sendNowPlaying(gs, track) {
  const previous = gs.nowPlayingMessage;
  gs.nowPlayingMessage = null;
  if (previous) previous.edit({ components: [] }).catch(() => {});
  try {
    gs.nowPlayingMessage = await gs.textChannel?.send({ embeds: [nowPlayingEmbed(track)], components: controlRows(gs) });
  } catch (e) {
    console.log("[discord] falha ao enviar card:", e.message);
  }
}

function refreshControls(gs) {
  gs.nowPlayingMessage?.edit({ components: controlRows(gs) }).catch(() => {});
}

function queueText(gs) {
  const lines = [
    gs.current ? `**Agora** · [${gs.current.title}](${gs.current.url})` : "Nada tocando.",
    ...gs.queue.map((t, i) => `**${i + 1}** · ${t.title}${t.radio ? " · rádio" : ""}`),
  ];
  return lines.join("\n").slice(0, 1900);
}

function queuedEmbed(track, position) {
  return {
    description: `**Na fila #${position}** · [${track.title}](${track.url}) · pedido por ${track.by}`,
    color: GRAY,
    thumbnail: track.thumb ? { url: track.thumb } : undefined,
  };
}

function playBeep(gs) {
  if (gs.current) {
    duck(gs);
    return;
  }
  try {
    const resource = createAudioResource(Readable.from([readFileSync(BEEP_FILE)]), {
      inputType: StreamType.Raw,
    });
    gs.player.play(resource);
  } catch (e) {
    console.log("[beep] falhou:", e.message);
  }
}

function duck(gs) {
  if (!gs.currentResource?.volume) return;
  gs.currentResource.volume.setVolume(DUCK_VOLUME);
  if (gs.duckTimer) clearTimeout(gs.duckTimer);
  gs.duckTimer = setTimeout(() => unduck(gs), DUCK_TIMEOUT_MS);
}

function unduck(gs) {
  if (gs.duckTimer) clearTimeout(gs.duckTimer);
  gs.duckTimer = null;
  gs.currentResource?.volume?.setVolume(1);
}

async function enqueue(gs, rawQuery, by) {
  const { query, source } = parseSource(rawQuery);
  const seq = ++gs.seqCounter;
  const track = await resolveTrack(query, source);
  if (!track) {
    gs.textChannel?.send(`-# Nada encontrado para “${query}”`).catch(() => {});
    return;
  }
  track.by = by;
  track.seq = seq;
  const recentTs = gs.recentEnqueued.get(track.url);
  const isDupe =
    gs.current?.url === track.url ||
    gs.queue.some((t) => t.url === track.url) ||
    (recentTs && Date.now() - recentTs < 60000);
  if (isDupe) {
    console.log(`[fila] duplicata ignorada: ${track.title}`);
    return;
  }
  gs.recentEnqueued.set(track.url, Date.now());
  if (gs.recentEnqueued.size > 50) {
    const oldest = gs.recentEnqueued.keys().next().value;
    gs.recentEnqueued.delete(oldest);
  }
  const idx = gs.queue.findIndex((t) => t.seq > seq);
  if (idx === -1) gs.queue.push(track);
  else gs.queue.splice(idx, 0, track);
  if (gs.player.state.status === AudioPlayerStatus.Idle || !gs.current) {
    playNext(gs);
  } else {
    prefetch(track);
    gs.textChannel?.send({ embeds: [queuedEmbed(track, gs.queue.indexOf(track) + 1)] }).catch(() => {});
  }
}

function stopAll(gs) {
  for (const t of [gs.current, ...gs.queue]) dropTrackFile(t);
  gs.queue = [];
  gs.current = null;
  gs.currentResource = null;
  killProcs(gs);
  unduck(gs);
  gs.player.stop();
  gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
  gs.nowPlayingMessage = null;
}

function setRadio(gs, on, by) {
  gs.radio = on;
  gs.lastActivity = Date.now();
  if (on) {
    gs.textChannel?.send(`-# Rádio ligado por ${by} — quando a fila acabar eu sigo tocando parecidas`).catch(() => {});
    if (!gs.current) radioFill(gs, true);
    else if (gs.queue.length === 0) radioFill(gs, false);
  } else {
    gs.queue = gs.queue.filter((t) => !t.radio);
    gs.textChannel?.send(`-# Rádio desligado por ${by}`).catch(() => {});
  }
}

function vetoCurrent(gs, by) {
  const cur = gs.current;
  if (!cur) return;
  const key = norm(cur.title).split(" ").slice(0, 3).join(" ");
  if (key) gs.vetoed.add(key);
  gs.textChannel?.send(`-# ${by} vetou **${cur.title}** — não repito nesta sessão`).catch(() => {});
  playNext(gs);
}

function humansInChannel(gs) {
  try {
    const chId = gs.connection?.joinConfig?.channelId;
    const ch = gs.guild?.channels?.cache?.get(chId);
    return ch ? ch.members.filter((m) => !m.user.bot).size : 1;
  } catch {
    return 1;
  }
}

const IDLE_MS = 5 * 60 * 1000;
const EMPTY_MS = 60 * 1000;

function checkIdle(gs) {
  if (gs.dead) return;
  const alone = humansInChannel(gs) === 0;
  if (alone) {
    gs.emptySince ??= Date.now();
    if (Date.now() - gs.emptySince > EMPTY_MS) {
      gs.textChannel?.send("-# Canal vazio, saindo").catch(() => {});
      console.log("[idle] canal vazio, saindo");
      leave(gs);
    }
    return;
  }
  gs.emptySince = null;
  const idle = !gs.current && Date.now() - gs.lastActivity > IDLE_MS;
  if (idle) {
    gs.textChannel?.send("-# 5 minutos sem música e sem comando, vou nessa. Chame com `!entra`").catch(() => {});
    console.log("[idle] ocioso 5min, saindo");
    leave(gs);
  }
}

function teardown(gs) {
  if (gs.idleTimer) clearInterval(gs.idleTimer);
  gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
  gs.nowPlayingMessage = null;
  if (guilds.get(gs.guildId) === gs) guilds.delete(gs.guildId);
  gs.dead = true;
  try {
    for (const t of [gs.current, ...gs.queue]) dropTrackFile(t);
    gs.queue = [];
    gs.current = null;
    killProcs(gs);
    gs.player?.stop();
  } catch {}
  try {
    if (gs.connection && gs.connection.state.status !== "destroyed") gs.connection.destroy();
  } catch {}
}

function leave(gs) {
  teardown(gs);
}

const LOOP_TICK_MS = 50;
const LOOP_STALL_MS = 40;
const loopLag = { max: 0, sum: 0, stalls: 0, ticks: 0 };
let loopLastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - loopLastTick - LOOP_TICK_MS;
  loopLastTick = now;
  loopLag.ticks++;
  if (lag <= 0) return;
  loopLag.sum += lag;
  if (lag > loopLag.max) loopLag.max = lag;
  if (lag >= LOOP_STALL_MS) loopLag.stalls++;
}, LOOP_TICK_MS).unref();

setInterval(() => {
  if (loopLag.ticks > 0) {
    console.log(
      `[loop] 5min: lag médio ${(loopLag.sum / loopLag.ticks).toFixed(1)}ms, máx ${loopLag.max}ms, ` +
        `${loopLag.stalls} travadas acima de ${LOOP_STALL_MS}ms`
    );
    loopLag.max = 0;
    loopLag.sum = 0;
    loopLag.stalls = 0;
    loopLag.ticks = 0;
  }
  const { pass, block, busy, throttled, gateMs, groqMs } = gateStats;
  if (pass + block + busy + throttled > 0) {
    console.log(
      `[gate] 5min: ${pass} p/ groq, ${block} barradas, ${throttled} throttled, ${busy} perdidas na fila ` +
        `| porteiro ${avg(gateMs)}ms (máx ${Math.max(0, ...gateMs)}ms) | groq ${avg(groqMs)}ms`
    );
    gateStats.pass = 0;
    gateStats.block = 0;
    gateStats.busy = 0;
    gateStats.throttled = 0;
    gateStats.gateMs = [];
    gateStats.groqMs = [];
  }
}, 5 * 60 * 1000);

function captureUtterance(gs, userId) {
  if (gs.dead || guilds.get(gs.guildId) !== gs) return;
  if (gs.listening.has(userId)) return;
  const user = client.users.cache.get(userId);
  if (user?.bot) return;
  gs.listening.add(userId);
  const startedAt = Date.now();
  const opus = gs.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 600 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  let aborted = false;
  opus.pipe(decoder);
  decoder.on("data", (c) => {
    if (aborted) return;
    bytes += c.length;
    if (bytes > MAX_UTTERANCE_SECONDS * 48000 * 2 * 2) {
      aborted = true;
      chunks.length = 0;
      console.log(`[voz] fala passou de ${MAX_UTTERANCE_SECONDS}s, cortando captura`);
      opus.destroy();
      decoder.destroy();
      setTimeout(() => gs.listening.delete(userId), RESUBSCRIBE_COOLDOWN_MS);
      return;
    }
    chunks.push(c);
  });
  const cleanup = (e) => {
    if (e) console.log("[voz] erro no stream:", e.message);
    if (!aborted) gs.listening.delete(userId);
  };
  decoder.on("end", async () => {
    gs.listening.delete(userId);
    const pcm = Buffer.concat(chunks);
    const secs = pcm.length / (48000 * 2 * 2);
    if (secs < 0.6) return;
    const finishedAt = Date.now();
    const attentive = (gs.attention.get(userId) ?? 0) > startedAt;
    if (attentive) playBeep(gs);
    const hot = (gs.hotUsers.get(userId) ?? 0) > Date.now();
    const priority = attentive || hot;
    const who = user?.username ?? userId;

    if (!priority && GROQ_KEY) {
      if (!gateAllowed(gs, userId)) {
        gateStats.throttled++;
        return;
      }
      const head = to16kMono(sliceSeconds(pcm, GATE_SECONDS));
      if (!(await gateWake(head, who))) return;
    }

    const pcm16 = to16kMono(sliceSeconds(pcm, COMMAND_MAX_SECONDS));
    const text = await transcribe(pcm16, priority);
    console.log(`[stt] ${who}${hot && !attentive ? " (atalho)" : ""}: "${text}" [${Date.now() - finishedAt}ms]`);
    if (text) handleVoice(gs, userId, text, startedAt);
  });
  decoder.on("error", cleanup);
  opus.on("error", cleanup);
}

function handleVoice(gs, userId, raw, startedAt) {
  if (gs.dead || guilds.get(gs.guildId) !== gs) return;
  const text = norm(raw);
  if (!text) return;
  const dupeKey = `${userId}:${text}`;
  if (Date.now() - (gs.recentCommands.get(dupeKey) ?? 0) < 6000) {
    console.log(`[wake] comando repetido ignorado: "${text}"`);
    return;
  }
  gs.recentCommands.set(dupeKey, Date.now());
  if (gs.recentCommands.size > 40) gs.recentCommands.delete(gs.recentCommands.keys().next().value);
  const words = text.split(" ");
  const wakeIdx = words.findIndex(isWakeWord);
  const attentive = (gs.attention.get(userId) ?? 0) > startedAt;
  let rest;
  if (wakeIdx !== -1 && wakeIdx <= 4) {
    rest = words.slice(wakeIdx + 1).join(" ");
  } else if (attentive) {
    rest = text;
  } else {
    return;
  }
  gs.attention.delete(userId);
  gs.lastActivity = Date.now();
  gs.hotUsers.set(userId, Date.now() + HOT_USER_MS);
  console.log(`[wake] comando: "${rest}"`);
  const mention = `<@${userId}>`;

  if (rest === "" || /^(oi|ola|fala|ei)$/.test(rest)) {
    gs.attention.set(userId, Date.now() + ATTENTION_MS);
    playBeep(gs);
    return;
  }

  const restWords = rest.split(" ").filter((w) => !["ai", "ei", "vai", "ow", "o"].includes(w));
  const head = restWords[0] ?? "";
  const tail = restWords.slice(1).join(" ");
  const mentionsRadio = restWords.length <= 2 && restWords.some((w) => matchVerb(w, ["radio"]));

  if (mentionsRadio) {
    const off = ["para", "parar", "desliga", "desligar", "tira", "encerra", "cancela"].some((v) => matchVerb(head, [v]));
    setRadio(gs, !off, mention);
    return;
  }
  if (/^(essa|esta|essa nao|nao gostei|tira essa|veta|odeio)/.test(rest) && /(nao|gostei|tira|veta|odeio)/.test(rest)) {
    vetoCurrent(gs, mention);
    return;
  }

  if (matchVerb(head, PLAY_VERBS)) {
    const query = tail
      .replace(/^(a musica |o som |a |um |uma )/, "")
      .replace(/\s+(ai|por favor|pra mim|pra gente|rapidao|agora)$/, "")
      .trim();
    if (!query) return;
    unduck(gs);
    gs.textChannel?.send(`-# ${mention} pediu “${query}” — buscando…`).catch(() => {});
    enqueue(gs, query, mention);
    return;
  }
  if (matchVerb(head, SKIP_VERBS)) {
    unduck(gs);
    gs.textChannel?.send(`-# Pulada por ${mention}`).catch(() => {});
    playNext(gs);
    return;
  }
  if (matchVerb(head, PAUSE_VERBS)) {
    gs.player.pause();
    gs.textChannel?.send(`-# Pausada por ${mention}`).catch(() => {});
    refreshControls(gs);
    return;
  }
  if (matchVerb(head, RESUME_VERBS)) {
    unduck(gs);
    gs.player.unpause();
    gs.textChannel?.send(`-# Retomada por ${mention}`).catch(() => {});
    refreshControls(gs);
    return;
  }
  if (matchVerb(head, STOP_VERBS) || /^cala/.test(head)) {
    stopAll(gs);
    gs.textChannel?.send(`-# Parada por ${mention} — fila limpa`).catch(() => {});
    return;
  }
  if (LEAVE_VERBS.includes(head)) {
    gs.textChannel?.send(`Até mais! Dispensado por ${mention}.`).catch(() => {});
    leave(gs);
    return;
  }
  if (wakeIdx !== -1) {
    gs.textChannel?.send(`-# Entendi “${rest}” — comando desconhecido`).catch(() => {});
  }
  console.log(`[wake] não entendi: "${rest}"`);
}

function joinFor(member, channel) {
  const gs = getState(member.guild.id);
  gs.textChannel = channel;
  if (gs.connection) return gs;
  const voice = member.voice.channel;
  if (!voice) return null;
  const zombie = getVoiceConnection(member.guild.id);
  if (zombie) {
    console.log("[voz] destruindo conexão órfã antes de entrar");
    try { zombie.destroy(); } catch {}
  }
  gs.connection = joinVoiceChannel({
    channelId: voice.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  gs.connection.on("stateChange", (oldS, newS) => {
    if (oldS.status === newS.status) return;
    console.log(`[voz] conexão: ${oldS.status} -> ${newS.status}`);
    if (newS.status === "destroyed" || newS.status === "disconnected") {
      teardown(gs);
    }
  });
  gs.connection.on("error", (e) => console.log("[voz] erro de conexão:", e.message));
  gs.player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 50 },
  });
  gs.connection.subscribe(gs.player);
  gs.player.on(AudioPlayerStatus.Idle, (oldState) => {
    if (oldState.resource !== gs.currentResource) return;
    const cur = gs.current;
    if (cur && !cur.retried && (oldState.resource.playbackDuration ?? 0) < 1500) {
      cur.retried = true;
      cur.file = null;
      cur.infoFile = null;
      console.log(`[player] áudio não iniciou, refazendo pela via longa: ${cur.title}`);
      startPlayback(gs, cur, "completa");
      return;
    }
    if (cur) playNext(gs);
  });
  gs.player.on("error", (e) => {
    console.log("[player] erro:", e.message);
    playNext(gs);
  });
  gs.connection.receiver.speaking.on("start", (userId) => captureUtterance(gs, userId));
  gs.guild = member.guild;
  gs.lastActivity = Date.now();
  gs.idleTimer = setInterval(() => checkIdle(gs), 30000);
  console.log(`[voz] entrei em "${voice.name}" (${member.guild.name})`);
  return gs;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.guild || !m.content.startsWith("!")) return;
  const [cmd, ...args] = m.content.slice(1).trim().split(/\s+/);
  const query = args.join(" ");
  const command = cmd.toLowerCase();

  if (["entra", "play", "p", "toca"].includes(command)) {
    const gs = joinFor(m.member, m.channel);
    if (!gs) {
      m.reply("-# Entre num canal de voz primeiro").catch(() => {});
      return;
    }
    if (command === "entra") {
      m.reply({
        embeds: [
          {
            author: { name: "Campeão na área" },
            description: [
              'Fale **"Campeão, toca <música>"** — ou use `!play <música>`.',
              "Por voz também: **pula** · **pausa** · **continua** · **para** · **sai**",
              'Fonte específica: *"…no YouTube"* ou *"…no SoundCloud"*. `!ajuda` para o resto.',
            ].join("\n"),
            color: GOLD,
          },
        ],
      }).catch(() => {});
      return;
    }
    if (!query) {
      m.reply("-# Informe a música: `!play wonderwall oasis`").catch(() => {});
      return;
    }
    await enqueue(gs, query, `${m.author}`);
    return;
  }

  const gs = guilds.get(m.guild.id);
  if (!gs) return;
  gs.textChannel = m.channel;
  gs.lastActivity = Date.now();

  if (command === "radio") setRadio(gs, !gs.radio, `${m.author}`);
  else if (["pula", "skip", "proxima"].includes(command)) playNext(gs);
  else if (["para", "stop"].includes(command)) stopAll(gs);
  else if (command === "pausa") gs.player.pause();
  else if (["continua", "resume"].includes(command)) gs.player.unpause();
  else if (command === "fila") {
    m.reply({ embeds: [{ author: { name: "Fila" }, description: queueText(gs), color: GRAY }] }).catch(() => {});
  } else if (["sai", "sair"].includes(command)) leave(gs);
  else if (command === "ajuda") {
    m.reply({
      embeds: [
        {
          author: { name: "Como usar o Campeão" },
          description: [
            '**Por voz** (comigo no canal): *"Campeão, toca <música>"* — e também: pula, pausa, continua, para, sai.',
            'Com música tocando, diga só *"Campeão"*: o som abaixa e eu escuto por 2s.',
            '**Fonte específica**: *"…no YouTube"* ou *"…no SoundCloud"*. Sem indicar, o Deezer identifica a faixa oficial.',
            '**Rádio**: *"Campeão, liga o rádio"* — quando a fila acaba, sigo tocando parecidas. *"Campeão, essa não"* veta a atual.',
            "Saio sozinho após 5 min sem música e sem comando, ou 1 min com o canal vazio.",
            "**Por texto**: `!entra` `!play` `!pula` `!pausa` `!continua` `!para` `!fila` `!radio` `!sai`",
          ].join("\n"),
          color: GOLD,
          footer: { text: "Campeão" },
        },
      ],
    }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith("cmp:")) return;
  const gs = guilds.get(i.guildId);
  if (!gs) {
    i.reply({ content: "-# Não estou mais tocando nada.", flags: 64 }).catch(() => {});
    return;
  }
  const action = i.customId.slice(4);
  gs.lastActivity = Date.now();
  const who = `<@${i.user.id}>`;

  if (action === "queue") {
    i.reply({ content: queueText(gs), flags: 64 }).catch(() => {});
    return;
  }
  await i.deferUpdate().catch(() => {});

  if (action === "pause") {
    const paused = gs.player.state.status === AudioPlayerStatus.Paused;
    if (paused) {
      unduck(gs);
      gs.player.unpause();
      gs.textChannel?.send(`-# Retomada por ${who}`).catch(() => {});
    } else {
      gs.player.pause();
      gs.textChannel?.send(`-# Pausada por ${who}`).catch(() => {});
    }
    refreshControls(gs);
  } else if (action === "skip") {
    gs.textChannel?.send(`-# Pulada por ${who}`).catch(() => {});
    playNext(gs);
  } else if (action === "veto") {
    vetoCurrent(gs, who);
  } else if (action === "stop") {
    stopAll(gs);
    gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    gs.nowPlayingMessage = null;
    gs.textChannel?.send(`-# Parada por ${who} — fila limpa`).catch(() => {});
  } else if (action === "radio") {
    setRadio(gs, !gs.radio, who);
    refreshControls(gs);
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Campeão online como ${client.user.tag}`);
});

async function warmupYoutube() {
  try {
    const t0 = Date.now();
    const raw = await runYtdlp(["--no-playlist", "-f", "bestaudio/best", "-J", "https://www.youtube.com/watch?v=SRXH9AbT280"], { timeout: 90000 });
    const info = JSON.parse(raw.trim().split("\n").filter(Boolean)[0]);
    const file = `${INFO_DIR}/warmup.info.json`;
    writeFileSync(file, JSON.stringify(info));
    const tDl = Date.now();
    const ttfb = await new Promise((resolve) => {
      const p = spawnLow("yt-dlp", [...YTDLP_BASE, "-f", "bestaudio/best", "-q", "-o", "-", "--load-info-json", file]);
      const fin = (v) => { try { p.kill("SIGKILL"); } catch {} resolve(v); };
      p.stdout.once("data", () => fin(Date.now() - tDl));
      p.on("exit", () => resolve(null));
      setTimeout(() => fin(null), 30000);
    });
    console.log(`[aquecimento] youtube ok — extração ${Date.now() - t0 - (Date.now() - tDl)}ms, 1º byte ${ttfb}ms`);
  } catch (e) {
    console.log(`[aquecimento] youtube FALHOU: ${shortErr(e)}`);
  }
}
setTimeout(warmupYoutube, 8000);
setInterval(warmupYoutube, 4 * 60 * 60 * 1000);

try {
  ensureBeep();
} catch (e) {
  console.error("Falha ao gerar bip (seguindo sem):", e.message);
}
client.login(TOKEN).catch((e) => {
  console.error("Falha no login do Discord:", e.message);
  process.exit(1);
});
