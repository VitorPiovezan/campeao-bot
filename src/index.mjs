import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";

const execFileP = promisify(execFile);
const TOKEN = process.env.DISCORD_TOKEN;
const POT_URL = process.env.POT_PROVIDER_URL;
const GROQ_KEY = process.env.GROQ_API_KEY;
const YTDLP_BASE = [
  "--js-runtimes", "node",
  ...(POT_URL ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_URL}`] : []),
];
const STT_URL = "http://127.0.0.1:5005/";
const WAKE_WORDS = ["campeao", "campiao", "capiao", "campeaum", "campeon"];
const ATTENTION_MS = 2500;
const DUCK_VOLUME = 0.15;
const DUCK_TIMEOUT_MS = 8000;
const BEEP_FILE = "/tmp/beep.pcm";

const guilds = new Map();

function ensureBeep() {
  if (existsSync(BEEP_FILE)) return;
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "sine=frequency=740:duration=0.13",
    "-f", "lavfi", "-i", "sine=frequency=988:duration=0.13",
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1,volume=0.35,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo",
    "-f", "s16le", "-y", BEEP_FILE,
  ], { stdio: "ignore" });
}

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
    });
  }
  return guilds.get(guildId);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const isWakeWord = (w) => WAKE_WORDS.includes(w) || (w.length >= 6 && editDistance(w, "campeao") <= 2);

const PLAY_VERBS = ["toca", "tocar", "toque", "coloca", "colocar", "bota", "botar", "poe", "play", "manda", "mandar"];
const SKIP_VERBS = ["pula", "pular", "proxima", "passa", "passar", "skip", "next"];
const PAUSE_VERBS = ["pausa", "pausar", "pause"];
const RESUME_VERBS = ["continua", "continuar", "volta", "voltar", "despausa", "resume"];
const STOP_VERBS = ["para", "parar", "pare", "stop", "chega"];
const LEAVE_VERBS = ["sai", "sair", "vaza", "tchau", "xau", "embora"];
const matchVerb = (w, verbs) =>
  verbs.some((v) => w === v || (w.length >= 4 && v.length >= 4 && editDistance(w, v) <= 1));

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function killProcs(gs) {
  for (const p of gs.procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  gs.procs = [];
}

function parseSource(raw) {
  const m = raw.match(/\s+(?:no|na|do|da|em|pelo|pela)\s+(youtube|you tube|iutubi|soundcloud|sound cloud|saundclaud|deezer|dizer|diser|spotify|spotifai)$/);
  if (!m) return { query: raw, source: "auto" };
  const word = m[1].replace(/\s/g, "");
  const source = word.startsWith("sound") || word.startsWith("saund")
    ? "soundcloud"
    : word.startsWith("you") || word.startsWith("iutu")
      ? "youtube"
      : "deezer";
  return { query: raw.slice(0, m.index).trim(), source };
}

async function deezerLookup(query) {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    const track = (await res.json()).data?.[0];
    if (!track?.title) return null;
    return {
      artist: track.artist?.name ?? "",
      title: track.title,
      label: `${track.artist?.name} - ${track.title}`,
      duration: track.duration || null,
    };
  } catch (e) {
    console.log("[deezer] erro:", e.message);
    return null;
  }
}

async function runYtdlp(args, target) {
  try {
    const { stdout } = await execFileP(
      "yt-dlp",
      [...YTDLP_BASE, ...args, "-f", "bestaudio/best", "--print", "%(title)s\t%(webpage_url)s\t%(channel)s\t%(duration)s", target],
      { timeout: 60000 },
    );
    return stdout;
  } catch (e) {
    if (e.stdout?.trim()) return e.stdout;
    throw e;
  }
}

function parseCandidates(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [title, url, channel, duration] = line.split("\t");
      return { title, url, channel: channel ?? "", duration: Number.parseFloat(duration) || null };
    })
    .filter((c) => c.url);
}

const REMIX_WORDS = [
  "remix", "slowed", "reverb", "sped up", "speed up", "nightcore", "8d",
  "cover", "karaoke", "instrumental", "live", "ao vivo", "mashup",
  "bass boost", "loop", "1 hour", "10 hour", "tiktok",
];

function scoreCandidate(c, want) {
  let score = 0;
  const title = norm(c.title ?? "");
  const channel = norm(c.channel ?? "");
  const query = norm(want.query);
  if (channel.endsWith("topic")) score += 5;
  if (channel.includes("vevo")) score += 4;
  if (channel.length >= 4 && query.includes(channel)) score += 2;
  if (/\b(official|oficial)\b/.test(title)) score += 2;
  for (const w of REMIX_WORDS) {
    if (title.includes(w) && !query.includes(w)) score -= 4;
  }
  if (want.duration && c.duration) {
    const diff = Math.abs(c.duration - want.duration);
    if (diff <= 5) score += 6;
    else if (diff <= 15) score += 3;
    else if (diff > 60) score -= 3;
  }
  for (const w of query.split(" ")) {
    if (w.length >= 3 && title.includes(w)) score += 0.5;
  }
  return score;
}

async function resolveTrack(query, source = "auto") {
  const isUrl = /^https?:\/\//.test(query);
  const tvArgs = ["--extractor-args", "youtube:player_client=tv"];
  const yt = (q) => ({ label: "youtube", args: ["-i", "--no-playlist"], target: `ytsearch5:${q}` });
  const yttv = (q) => ({ label: "youtube-tv", args: ["-i", "--no-playlist", ...tvArgs], target: `ytsearch5:${q}`, extra: tvArgs });
  const sc = (q) => ({ label: "soundcloud", args: ["-i"], target: `scsearch5:${q}` });
  let attempts;
  let forcedTitle = null;
  let want = { query, duration: null };
  if (isUrl) {
    attempts = [{ label: "url", args: ["--no-playlist"], target: query }];
  } else if (source === "youtube") {
    attempts = [yt(query), yttv(query)];
  } else if (source === "soundcloud") {
    attempts = [sc(query)];
  } else {
    const dz = await deezerLookup(query);
    const refined = dz ? `${dz.artist} ${dz.title}` : query;
    if (dz) {
      forcedTitle = dz.label;
      want = { query: refined, duration: dz.duration };
      console.log(`[busca] deezer refinou: "${query}" -> "${refined}" (${dz.duration}s)`);
    }
    attempts = [yt(want.query), yttv(want.query), sc(want.query)];
  }
  for (const attempt of attempts) {
    try {
      const stdout = await runYtdlp(attempt.args, attempt.target);
      const candidates = parseCandidates(stdout)
        .map((c) => ({ ...c, score: scoreCandidate(c, want) }))
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (best) {
        console.log(
          `[busca] ${attempt.label}: ${candidates.map((c) => `${c.score.toFixed(1)} ${c.title?.slice(0, 50)}`).join(" | ")}`,
        );
        return { title: forcedTitle ?? best.title, url: best.url, extra: attempt.extra ?? [] };
      }
    } catch (e) {
      const err = (e.stderr || e.message || "").toString().replace(/\s+/g, " ").slice(0, 250);
      console.log(`[busca] ${attempt.label} falhou: ${err}`);
    }
  }
  return null;
}

function playNext(gs) {
  killProcs(gs);
  unduck(gs);
  const next = gs.queue.shift();
  gs.current = next ?? null;
  gs.currentResource = null;
  if (!next) return;
  console.log(`[player] tocando: ${next.title}`);
  const ytdlp = spawn("yt-dlp", [...YTDLP_BASE, ...(next.extra ?? []), "-f", "bestaudio/best", "--no-playlist", "-q", "-o", "-", next.url]);
  const ff = spawn("ffmpeg", ["-loglevel", "quiet", "-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);
  ytdlp.stderr.on("data", (d) => console.log(`[yt-dlp] ${d.toString().trim().slice(0, 200)}`));
  ytdlp.stdout.pipe(ff.stdin);
  ff.stdin.on("error", () => {});
  ytdlp.on("error", (e) => console.log("[yt-dlp] erro:", e.message));
  ff.on("error", (e) => console.log("[ffmpeg] erro:", e.message));
  gs.procs = [ytdlp, ff];
  const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
  gs.currentResource = resource;
  gs.player.play(resource);
  gs.textChannel?.send(`▶️ Tocando agora: **${next.title}** (pedido por ${next.by})`).catch(() => {});
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
  const track = await resolveTrack(query, source);
  if (!track) {
    gs.textChannel?.send(`😔 Não achei nada pra "${query}"`).catch(() => {});
    return;
  }
  track.by = by;
  gs.queue.push(track);
  if (gs.player.state.status === AudioPlayerStatus.Idle || !gs.current) {
    playNext(gs);
  } else {
    gs.textChannel?.send(`➕ Na fila (#${gs.queue.length}): **${track.title}**`).catch(() => {});
  }
}

function stopAll(gs) {
  gs.queue = [];
  gs.current = null;
  gs.currentResource = null;
  killProcs(gs);
  unduck(gs);
  gs.player.stop();
}

function leave(gs) {
  stopAll(gs);
  try { gs.connection?.destroy(); } catch {}
  guilds.delete(gs.guildId);
}

function to16kMono(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(Math.floor(frames / 3) * 2);
  let o = 0;
  for (let i = 0; i + 2 < frames; i += 3) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), o);
    o += 2;
  }
  return out;
}

let sttPending = 0;

function wavFrom(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function groqTranscribe(pcm) {
  const fd = new FormData();
  fd.append("file", new Blob([wavFrom(pcm)], { type: "audio/wav" }), "audio.wav");
  fd.append("model", "whisper-large-v3-turbo");
  fd.append("language", "pt");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_KEY}` },
    body: fd,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.log("[stt] groq resposta", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  return ((await res.json()).text ?? "").trim() || null;
}

async function transcribe(pcm, priority = false) {
  const limit = GROQ_KEY ? 4 : 1;
  if (!priority && sttPending >= limit) {
    console.log("[stt] ocupado, descartando fala");
    return null;
  }
  sttPending++;
  try {
    if (GROQ_KEY) return await groqTranscribe(pcm);
    const res = await fetch(STT_URL, {
      method: "POST",
      body: pcm,
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.log("[stt] resposta", res.status);
      return null;
    }
    return (await res.json()).text;
  } catch (e) {
    console.log("[stt] erro:", e.message);
    return null;
  } finally {
    sttPending--;
  }
}

function captureUtterance(gs, userId) {
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
  opus.pipe(decoder);
  decoder.on("data", (c) => {
    bytes += c.length;
    if (bytes < 48000 * 2 * 2 * 15) chunks.push(c);
  });
  const cleanup = (e) => {
    if (e) console.log("[voz] erro no stream:", e.message);
    gs.listening.delete(userId);
  };
  decoder.on("end", async () => {
    gs.listening.delete(userId);
    const pcm = Buffer.concat(chunks);
    const secs = pcm.length / (48000 * 2 * 2);
    if (secs < 0.6) return;
    if (secs > 6) {
      console.log(`[voz] descartando fala de ${secs.toFixed(1)}s (longa demais, provável vazamento de música)`);
      return;
    }
    const attentive = (gs.attention.get(userId) ?? 0) > startedAt;
    if (attentive) playBeep(gs);
    const text = await transcribe(to16kMono(pcm), attentive);
    console.log(`[stt] ${user?.username ?? userId}: "${text}"`);
    if (text) handleVoice(gs, userId, text, startedAt);
  });
  decoder.on("error", cleanup);
  opus.on("error", cleanup);
}

function handleVoice(gs, userId, raw, startedAt) {
  const text = norm(raw);
  if (!text) return;
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

  if (matchVerb(head, PLAY_VERBS)) {
    const query = tail
      .replace(/^(a musica |o som |a |um |uma )/, "")
      .replace(/\s+(ai|por favor|pra mim|pra gente|rapidao|agora)$/, "")
      .trim();
    if (!query) return;
    unduck(gs);
    gs.textChannel?.send(`🎤 ${mention} pediu: **${query}**`).catch(() => {});
    enqueue(gs, query, mention);
    return;
  }
  if (matchVerb(head, SKIP_VERBS)) {
    unduck(gs);
    gs.textChannel?.send(`⏭️ ${mention} pulou a música`).catch(() => {});
    playNext(gs);
    return;
  }
  if (matchVerb(head, PAUSE_VERBS)) {
    gs.player.pause();
    gs.textChannel?.send(`⏸️ ${mention} pausou a música`).catch(() => {});
    return;
  }
  if (matchVerb(head, RESUME_VERBS)) {
    unduck(gs);
    gs.player.unpause();
    gs.textChannel?.send(`▶️ ${mention} despausou a música`).catch(() => {});
    return;
  }
  if (matchVerb(head, STOP_VERBS) || /^cala/.test(head)) {
    stopAll(gs);
    gs.textChannel?.send(`⏹️ ${mention} parou a música`).catch(() => {});
    return;
  }
  if (LEAVE_VERBS.includes(head)) {
    gs.textChannel?.send(`👋 Falou, ${mention}!`).catch(() => {});
    leave(gs);
    return;
  }
  if (wakeIdx !== -1) {
    gs.textChannel?.send(`🤔 ${mention}, entendi "${rest}" mas não conheço esse comando`).catch(() => {});
  }
  console.log(`[wake] não entendi: "${rest}"`);
}

function joinFor(member, channel) {
  const gs = getState(member.guild.id);
  gs.textChannel = channel;
  if (gs.connection) return gs;
  const voice = member.voice.channel;
  if (!voice) return null;
  gs.connection = joinVoiceChannel({
    channelId: voice.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  gs.connection.on("stateChange", (oldS, newS) => {
    console.log(`[voz] conexão: ${oldS.status} -> ${newS.status}`);
    if (newS.status === "destroyed" || newS.status === "disconnected") {
      guilds.delete(gs.guildId);
    }
  });
  gs.connection.on("error", (e) => console.log("[voz] erro de conexão:", e.message));
  gs.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  gs.connection.subscribe(gs.player);
  gs.player.on(AudioPlayerStatus.Idle, (oldState) => {
    if (oldState.resource !== gs.currentResource) return;
    if (gs.current) playNext(gs);
  });
  gs.player.on("error", (e) => {
    console.log("[player] erro:", e.message);
    playNext(gs);
  });
  gs.connection.receiver.speaking.on("start", (userId) => captureUtterance(gs, userId));
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
      m.reply("Entra num canal de voz primeiro! 🎧").catch(() => {});
      return;
    }
    if (command === "entra") {
      m.reply('Cheguei! 🏆 Fala "CAMPEÃO, TOCA <música>" ou usa `!play <música>`').catch(() => {});
      return;
    }
    if (!query) {
      m.reply("Fala qual música: `!play wonderwall oasis`").catch(() => {});
      return;
    }
    await enqueue(gs, query, `${m.author}`);
    return;
  }

  const gs = guilds.get(m.guild.id);
  if (!gs) return;
  gs.textChannel = m.channel;

  if (["pula", "skip", "proxima"].includes(command)) playNext(gs);
  else if (["para", "stop"].includes(command)) stopAll(gs);
  else if (command === "pausa") gs.player.pause();
  else if (["continua", "resume"].includes(command)) gs.player.unpause();
  else if (command === "fila") {
    const lines = [
      gs.current ? `▶️ **${gs.current.title}**` : "Nada tocando",
      ...gs.queue.map((t, i) => `${i + 1}. ${t.title}`),
    ];
    m.reply(lines.join("\n").slice(0, 1900)).catch(() => {});
  } else if (["sai", "sair"].includes(command)) leave(gs);
  else if (command === "ajuda") {
    m.reply(
      [
        '**Por voz** (comigo no canal): "CAMPEÃO, TOCA <música>" — também: pula, pausa, continua, para, sai',
        'Com música tocando, fala só "CAMPEÃO" que eu abaixo o som e te escuto por 2s',
        'Fonte específica: "CAMPEÃO, TOCA <música> **no youtube**" (ou no soundcloud). Sem falar, o Deezer acha a faixa certa e eu busco o áudio',
        "**Por texto**: `!entra` `!play <música>` `!pula` `!pausa` `!continua` `!para` `!fila` `!sai`",
      ].join("\n"),
    ).catch(() => {});
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Campeão online como ${client.user.tag}`);
});

try {
  ensureBeep();
} catch (e) {
  console.error("Falha ao gerar bip (seguindo sem):", e.message);
}
client.login(TOKEN).catch((e) => {
  console.error("Falha no login do Discord:", e.message);
  process.exit(1);
});
