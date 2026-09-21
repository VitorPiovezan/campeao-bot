import { SOURCE_NAMES, videoIdOf } from "./core.mjs";

const TERMINAL_STATES = new Set(["ended", "skipped", "stopped"]);

const thumbOf = (track) => {
  if (track?.thumb) return track.thumb;
  const id = videoIdOf(track?.url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
};

const radioAction = (on) => ({ id: "radio", label: "Rádio", icon: "radio", ...(on ? { active: true } : {}) });

const queueItemActions = (track) => [
  { id: `bump:${track?.seq ?? 0}`, label: "Tocar agora", icon: "up" },
  { id: `remove:${track?.seq ?? 0}`, label: "Tirar da fila", icon: "trash" },
];

const STAGE_MAX_QUEUE = 50;

export const trackCard = (track) => ({
  title: track?.title ?? "",
  url: track?.url ?? null,
  thumbUrl: thumbOf(track),
  durationMs: track?.duration ? Math.round(track.duration * 1000) : null,
  by: track?.by ?? "",
  radio: Boolean(track?.radio),
  source: SOURCE_NAMES[track?.source] ?? "",
});

export const playerCard = ({ track, state = "playing", positionMs = 0, radio = false, queueLength = 0, paused = false }) => {
  const resolved = paused && state === "playing" ? "paused" : state;
  const live = !TERMINAL_STATES.has(resolved);
  const seekable = live && Boolean(track?.duration);
  const actions = live
    ? [
        resolved === "paused" ? { id: "resume", label: "Retomar", icon: "play" } : { id: "pause", label: "Pausar", icon: "pause" },
        ...(seekable
          ? [
              { id: "back10", label: "Voltar 10s", icon: "back10" },
              { id: "forward10", label: "Avançar 10s", icon: "forward10" },
            ]
          : []),
        { id: "skip", label: "Pular", icon: "skip" },
        { id: "veto", label: "Não curti", icon: "thumbsDown" },
        { id: "stop", label: "Parar", icon: "stop", style: "danger" },
        radioAction(radio),
        { id: "queue", label: "Fila", icon: "queue" },
      ]
    : [{ id: "replay", label: "Tocar de novo", icon: "replay" }, ...(radio ? [radioAction(true)] : [])];
  return {
    kind: "player",
    track: trackCard(track),
    state: resolved,
    positionMs: Math.max(0, Math.round(positionMs || 0)),
    at: new Date().toISOString(),
    radio: Boolean(radio),
    queueLength: Math.max(0, Math.round(queueLength || 0)),
    seekable,
    actions,
  };
};

export const queuedCard = (track, position) => ({
  kind: "queued",
  track: trackCard(track),
  position: Math.max(1, Math.round(position || 1)),
  actions: queueItemActions(track),
});

export const stageOf = ({ current, state = "playing", positionMs = 0, paused = false, queue = [], radio = false }) => {
  const items = (queue ?? []).slice(0, STAGE_MAX_QUEUE);
  return {
    player: current ? playerCard({ track: current, state, positionMs, radio, queueLength: items.length, paused }) : null,
    queue: items.map((track) => ({ track: trackCard(track), actions: queueItemActions(track) })),
    radio: Boolean(radio),
    actions: [radioAction(radio), ...(items.length ? [{ id: "clear", label: "Limpar fila", icon: "trash", style: "danger" }] : [])],
  };
};

export const queueCard = (current, items, radio) => ({
  kind: "queue",
  current: current ? trackCard(current) : null,
  items: (items ?? []).map(trackCard),
  radio: Boolean(radio),
  actions: [radioAction(radio)],
});

export const noteCard = ({ tone = "info", emoji = "", title, text = "", actions = [] }) => ({
  kind: "note",
  tone,
  emoji,
  title,
  text,
  actions,
});

export const helpCard = (title = "Como usar o Campeão") => ({
  kind: "help",
  title,
  sections: [
    {
      title: "Por voz",
      lines: [
        '"Campeão, toca <música>" — e também: pula, pausa, continua, para, sai.',
        'Com música tocando, diga só "Campeão": o som abaixa e eu escuto por 2s.',
        'Fonte específica: "…no YouTube" ou "…no SoundCloud". Sem indicar, o Deezer identifica a faixa oficial.',
      ],
    },
    { title: "Por texto", lines: ["!entra !play !pula !pausa !continua !volta10 !avanca10 !para !fila !radio !ajuda !sai"] },
    {
      title: "Rádio",
      lines: ['"Campeão, liga o rádio" — quando a fila acaba, sigo tocando parecidas.', '"Campeão, essa não" veta a atual e eu não repito nesta sessão.'],
    },
    { title: "Saída automática", lines: ["Saio sozinho após 5 min sem música e sem comando, ou 1 min com a sala vazia."] },
  ],
  actions: [{ id: "enter", label: "Chamar pra minha sala", icon: "enter" }],
});
