const DATA = window.BOLAO_DATA;
const EXACT_SCORE_POINTS = Number.isFinite(Number(DATA.settings.exactScorePoints))
  ? Number(DATA.settings.exactScorePoints)
  : 3;
const RESULT_POINTS = Number.isFinite(Number(DATA.settings.resultPoints))
  ? Number(DATA.settings.resultPoints)
  : 1;
const BACKEND_ENVIRONMENT = String(DATA.settings.environment || "").trim();
const DRAFT_KEY = "bolao-copa-2026-drafts-v1";
const BASE_STATE_CACHE_KEY = `bolao-base-state-cache-v9-${BACKEND_ENVIRONMENT || "default"}`;
const BASE_STATE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKEND_TIMEOUT_MS = 25000;
const LIVE_REFRESH_MS = 15000;
const BASE_STATE_STALE_MS = 5 * 60 * 1000;
const UPCOMING_FEATURE_WINDOW_MS = 30 * 60 * 1000;
const ACTIVE_MATCH_GRACE_MS = 4 * 60 * 60 * 1000;
const LIVE_SOURCE_FRESH_MS = 10 * 60 * 1000;
const RECENT_FINISHED_DETAILS_MS = 8 * 60 * 60 * 1000;
const HISTORY_REQUEST_TIMEOUT_MS = 30000;
const SIMULATED_COMPETITION_BASE_MS = new Date(DATA.settings.simulatedNow || "").getTime();
const SIMULATED_COMPETITION_REAL_ANCHOR_MS = Date.now();


const state = {
  view: "inicio",
  picks: {},
  drafts: {},
  selectedPlayer: localStorage.getItem("bolao-player") || "",
  playerCode: localStorage.getItem("bolao-player-code") || "",
  betRound: localStorage.getItem("bolao-bet-round") || "Rodada 1",
  picksRound: localStorage.getItem("bolao-picks-round") || "Rodada 1",
  homePicksMatchId: "",
  homePicksManual: false,
  loadedBackend: false,
  loadedLive: false,
  resultSyncPending: 0,
  detailSyncPending: 0,
  roundDeadlines: {},
  serverTimeOffsetMs: 0,
  saveInFlight: false,
  rankingRange: localStorage.getItem("bolao-ranking-range") || "last10",
  picksStage: "",
  officialStage: "",
  closingRoundAlertShown: false,
  baseLoadError: "",
  betRoundManuallySelected: false,
  picksRoundManuallySelected: false
};

const $ = (selector) => document.querySelector(selector);
const app = $("#app");
let liveRefreshTimer = null;
let homeMatchTransitionTimer = null;
let deadlineRefreshTimer = null;
let deadlineLockTimer = null;
let lastBetRoundLocked = null;
let baseRequestPromise = null;
let baseRetryTimer = null;
let liveRequestPromise = null;
let deferredBackendRender = false;
let lastBackendVisualSignature = "";
let lastLiveVisualSignature = "";
let lastBaseLoadAt = 0;
let picksWriteRevision = 0;
const rounds = [...new Set(DATA.matches.map((m) => m.round))];
const groupStageRounds = ["Rodada 1", "Rodada 2", "Rodada 3"];
const knockoutRounds = ["Rodada 4", "Rodada 5", "Rodada 6", "Rodada 7", "Rodada 8"];
const detailRequests = new Map();
const detailRetryAfter = new Map();
const detailsLoadedMatchIds = new Set();
let bestThirdAssignmentCache = { signature: "", assignments: new Map() };

// As quatro combinações ainda possíveis para os oito melhores terceiros,
// conforme a matriz oficial da FIFA (Anexo C). Os valores indicam o grupo
// do terceiro colocado destinado a cada jogo dos 16 avos.
const FIFA_ACTIVE_THIRD_PLACE_OPTIONS = Object.freeze({
  BDEFIJKL: Object.freeze({ 74: "D", 77: "F", 79: "E", 80: "K", 81: "B", 82: "I", 85: "J", 87: "L" }),
  BDEFGIKL: Object.freeze({ 74: "D", 77: "F", 79: "E", 80: "K", 81: "B", 82: "I", 85: "G", 87: "L" }),
  BDEFGIJL: Object.freeze({ 74: "D", 77: "F", 79: "E", 80: "I", 81: "B", 82: "J", 85: "G", 87: "L" }),
  ABDEFGIL: Object.freeze({ 74: "D", 77: "F", 79: "E", 80: "I", 81: "B", 82: "A", 85: "G", 87: "L" })
});

const ROUND_LABELS = {
  "Rodada 1": "Rodada 1",
  "Rodada 2": "Rodada 2",
  "Rodada 3": "Rodada 3",
  "Rodada 4": "16 avos",
  "Rodada 5": "Oitavas de final",
  "Rodada 6": "Quartas de final",
  "Rodada 7": "Semifinais",
  "Rodada 8": "Final e 3º lugar"
};

const SHORT_COUNTRY_NAMES = {
  "República Tcheca": "Rep. Tcheca",
  "África do Sul": "África Sul",
  "Coreia do Sul": "Coreia Sul",
  "Estados Unidos": "EUA",
  "Costa do Marfim": "C. do Marfim",
  "Arábia Saudita": "Arábia Saud.",
  "Nova Zelândia": "N. Zelândia"
};

const FLAG_POSITIONS = {
  "África do Sul": [0, 0],
  "Coreia do Sul": [1, 0],
  "México": [2, 0],
  "República Tcheca": [3, 0],
  "Bósnia": [4, 0],
  "Canadá": [5, 0],
  "Catar": [6, 0],
  "Suíça": [7, 0],
  "Brasil": [0, 1],
  "Escócia": [1, 1],
  "Haiti": [2, 1],
  "Marrocos": [3, 1],
  "Austrália": [4, 1],
  "Estados Unidos": [5, 1],
  "Paraguai": [6, 1],
  "Turquia": [7, 1],
  "Alemanha": [0, 2],
  "Costa do Marfim": [1, 2],
  "Curaçao": [2, 2],
  "Equador": [3, 2],
  "Holanda": [4, 2],
  "Japão": [5, 2],
  "Suécia": [6, 2],
  "Tunísia": [7, 2],
  "Bélgica": [0, 3],
  "Egito": [1, 3],
  "Irã": [2, 3],
  "Nova Zelândia": [3, 3],
  "Arábia Saudita": [4, 3],
  "Cabo Verde": [5, 3],
  "Espanha": [6, 3],
  "Uruguai": [7, 3],
  "França": [0, 4],
  "Iraque": [1, 4],
  "Noruega": [2, 4],
  "Senegal": [3, 4],
  "Argélia": [4, 4],
  "Argentina": [5, 4],
  "Áustria": [6, 4],
  "Jordânia": [7, 4],
  "Colômbia": [0, 5],
  "RD Congo": [1, 5],
  "Portugal": [2, 5],
  "Uzbequistão": [3, 5],
  "Croácia": [4, 5],
  "Gana": [5, 5],
  "Inglaterra": [6, 5],
  "Panamá": [7, 5],
};







function init() {
  state.view = "inicio";
  localStorage.setItem("bolao-view", "inicio");
  const siteTitle = $("#site-title");
  if (siteTitle) siteTitle.textContent = DATA.settings.title;
  bindHeaderSponsorLink();
  sanitizeStoredMatchEvents();
  mergePicks(DATA.initialPicks || []);
  loadDrafts();
  restoreCachedBaseState();
  bindMainTabs();
  setupAutoRefresh();
  render();
  scheduleInitialBackendLoad();
}

function bindHeaderSponsorLink() {
  const hero = document.querySelector(".hero");

  if (!hero || hero.dataset.sponsorLinkReady === "1") {
    return;
  }

  hero.dataset.sponsorLinkReady = "1";
  hero.setAttribute("role", "link");
  hero.setAttribute("tabindex", "0");
  hero.setAttribute("aria-label", "Abrir site da IA Pro Contato");

  const openSponsor = () => {
    window.open("https://www.iaprocontato.com.br/", "_blank", "noopener,noreferrer");
  };

  hero.addEventListener("click", openSponsor);
  hero.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSponsor();
    }
  });
}

function bindMainTabs() {
  document.querySelectorAll(".main-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      localStorage.setItem("bolao-view", state.view);
      render();
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
  });
}

function setActiveTab() {
  document.querySelectorAll(".main-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function scheduleInitialBackendLoad() {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });

      const liveRequest = hasRelevantLiveWindow()
        ? loadLiveState(true).catch(() => null)
        : Promise.resolve(null);
      const baseRequest = loadBaseState().catch(() => null);

      Promise.allSettled([liveRequest, baseRequest]).finally(() => {
        scheduleLiveRefresh();
      });
    }, 0);
  });
}

function hasRelevantLiveWindow() {
  const now = currentCompetitionTimeMs();

  return DATA.matches.some((match) => {
    if (!match || isFinishedStatus(match)) return false;

    const kickoff = makeDate(match).getTime();
    return Number.isFinite(kickoff) &&
      now >= kickoff - UPCOMING_FEATURE_WINDOW_MS &&
      now <= kickoff + ACTIVE_MATCH_GRACE_MS;
  });
}

function hasLiveMatches() {
  return DATA.matches.some((match) => isLiveMatch(match));
}

function hasPotentiallyActiveMatch() {
  const now = currentCompetitionTimeMs();

  return DATA.matches.some((match) => {
    if (!match || isFinishedStatus(match)) return false;

    const kickoff = makeDate(match).getTime();
    return Number.isFinite(kickoff) &&
      now >= kickoff &&
      now <= kickoff + ACTIVE_MATCH_GRACE_MS;
  });
}

function hasDelayedMatches() {
  return DATA.matches.some((match) => isDelayedScheduledMatch(match));
}

function shouldUseLiveRefresh() {
  return hasLiveMatches() || hasPotentiallyActiveMatch() || hasDelayedMatches();
}

function hasRecentFinishedMatch() {
  const match = getLastFinishedMatch();

  if (!match) {
    return false;
  }

  const finishedAt = makeDate(match).getTime() + ACTIVE_MATCH_GRACE_MS;
  return Number.isFinite(finishedAt) && currentCompetitionTimeMs() - finishedAt <= RECENT_FINISHED_DETAILS_MS;
}


function loadDrafts() {
  try {
    state.drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  } catch (_) {
    state.drafts = {};
  }
}

function saveDrafts() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(state.drafts || {}));
}

function restoreCachedBaseState() {
  try {
    const cached = JSON.parse(localStorage.getItem(BASE_STATE_CACHE_KEY) || "null");
    const cachedAt = Number(cached?.cachedAt || 0);
    const payload = cached?.payload;

    if (
      !payload ||
      payload.ok === false ||
      String(payload.environment || "") !== BACKEND_ENVIRONMENT ||
      !Number.isFinite(cachedAt) ||
      Date.now() - cachedAt > BASE_STATE_CACHE_MAX_AGE_MS
    ) {
      return;
    }

    // Palpites não são restaurados do cache local. O ranking só é exibido
    // depois que os dados atuais forem confirmados pelo backend.
    mergeMatches(payload.matches || [], "base");
    if (payload.homeMatch) {
      mergeMatches([payload.homeMatch], "details");
    }
    state.resultSyncPending = Math.max(0, Number(payload.resultSyncPending || 0));
    state.detailSyncPending = Math.max(0, Number(payload.detailSyncPending || 0));
    state.roundDeadlines = Object.assign({}, payload.roundDeadlines || {});

    const cachedServerTime = new Date(payload.serverNow || "").getTime();
    if (Number.isFinite(cachedServerTime)) {
      state.serverTimeOffsetMs = cachedServerTime - cachedAt;
    }

    // Mantém o backend como não carregado para impedir ranking baseado em cache antigo.
  } catch (_) {
    localStorage.removeItem(BASE_STATE_CACHE_KEY);
  }
}

function cacheBaseState(payload) {
  try {
    const cachePayload = Object.assign({}, payload);
    delete cachePayload.picks;

    localStorage.setItem(BASE_STATE_CACHE_KEY, JSON.stringify({
      cachedAt: Date.now(),
      payload: cachePayload
    }));
  } catch (_) {
    // O cache local é apenas uma aceleração e não pode impedir o carregamento normal.
  }
}

function getDraftPick(playerId, round, matchId) {
  return state.drafts?.[playerId]?.[round]?.[matchId] || null;
}

function setDraftPick(playerId, round, matchId, g1, g2) {
  if (!playerId || !round || !matchId) return;
  if (!state.drafts[playerId]) state.drafts[playerId] = {};
  if (!state.drafts[playerId][round]) state.drafts[playerId][round] = {};

  state.drafts[playerId][round][matchId] = {
    g1,
    g2,
    updatedAt: new Date().toISOString()
  };

  saveDrafts();
}

function setDraftRoundPicks(playerId, round, picks) {
  if (!playerId || !round || !Array.isArray(picks)) return;
  if (!state.drafts[playerId]) state.drafts[playerId] = {};
  if (!state.drafts[playerId][round]) state.drafts[playerId][round] = {};

  const updatedAt = new Date().toISOString();

  picks.forEach((pick) => {
    if (!pick || !pick.matchId) return;

    state.drafts[playerId][round][pick.matchId] = {
      g1: String(pick.g1 ?? ""),
      g2: String(pick.g2 ?? ""),
      updatedAt
    };
  });

  saveDrafts();
}

function clearDraftRound(playerId, round) {
  if (!state.drafts?.[playerId]?.[round]) return;
  delete state.drafts[playerId][round];
  saveDrafts();
}

function mergePicks(list) {
  list.forEach((pick) => {
    if (!pick) return;

    const compact = Array.isArray(pick);
    const playerId = compact ? pick[0] : (pick.playerId || pick.p);
    const matchId = compact ? pick[1] : (pick.matchId || pick.m);
    const rawG1 = compact ? pick[2] : (pick.g1 ?? pick.goals1 ?? pick.a);
    const rawG2 = compact ? pick[3] : (pick.g2 ?? pick.goals2 ?? pick.b);
    const submittedAt = compact ? pick[4] : (pick.submittedAt || pick.createdAt);
    const updatedAt = compact ? pick[5] : pick.updatedAt;

    if (!playerId || !matchId) return;
    if (!state.picks[playerId]) state.picks[playerId] = {};

    state.picks[playerId][matchId] = {
      g1: Number(rawG1),
      g2: Number(rawG2),
      submittedAt: submittedAt || updatedAt || new Date().toISOString(),
      updatedAt: updatedAt || submittedAt || ""
    };
  });
}

function normalizeRemoteMatch(remote) {
  if (!Array.isArray(remote)) {
    const normalizedObject = Object.assign({}, remote || {});

    if (Object.prototype.hasOwnProperty.call(normalizedObject, "events")) {
      normalizedObject.events = goalOnlyEvents(normalizedObject.events);
    }

    return normalizedObject;
  }

  const normalized = {
    id: remote[0],
    score1: remote[1],
    score2: remote[2],
    status: remote[3]
  };

  if (remote.length > 4) normalized.elapsed = remote[4];
  if (remote.length > 5) normalized.homeScorers = remote[5];
  if (remote.length > 6) normalized.awayScorers = remote[6];
  if (remote.length > 7) normalized.events = goalOnlyEvents(remote[7]);
  if (remote.length > 8) normalized.injuryTime = remote[8];
  if (remote.length > 9) normalized.source = remote[9];
  if (remote.length > 10) normalized.sourceStatus = remote[10];
  if (remote.length > 11) normalized.sourceUpdatedAt = remote[11];
  if (remote.length > 12) normalized.statistics = remote[12];

  return normalized;
}

function sanitizeStoredMatchEvents() {
  DATA.matches.forEach((match) => {
    if (!Object.prototype.hasOwnProperty.call(match, "events")) return;
    match.events = goalOnlyEvents(match.events);
  });
}

function goalOnlyEvents(value) {
  const deduplicated = [];
  const indexByKey = new Map();

  normalizeGoalList(value, "")
    .filter((event) => isGoalEvent(event))
    .map((event) => Object.assign({}, event, {
      kind: "goal",
      icon: "⚽"
    }))
    .forEach((event) => {
      const minute = cleanGoalMinute(event.minute);
      const player = goalEventPlayerKey(event.player || "");
      const team = normalizeEventTeamName(event.team);
      const side = String(event.side || "").trim().toLowerCase();
      const fallbackLabel = goalEventPlayerKey(event.label || event.type || "goal");
      const key = player
        ? `${minute}|${player}`
        : `${minute}|${side}|${team}|${fallbackLabel}`;
      const existingIndex = indexByKey.get(key);

      if (existingIndex === undefined) {
        indexByKey.set(key, deduplicated.length);
        deduplicated.push(event);
        return;
      }

      if (goalEventDetailWeight(event) > goalEventDetailWeight(deduplicated[existingIndex])) {
        deduplicated[existingIndex] = event;
      }
    });

  return deduplicated;
}

function goalEventPlayerKey(value) {
  return cleanGoalPlayer(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*\((?:og|gc|own goal|gol contra|p|penalty|penalti)\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function goalEventDetailWeight(event) {
  const goalType = String(event && event.goalType || "").toLowerCase();
  let weight = 0;

  if (goalType === "own_goal") weight += 20;
  if (goalType === "penalty") weight += 10;
  if (event && event.assist) weight += 4;
  if (event && event.team) weight += 2;
  if (event && event.side) weight += 1;

  return weight;
}

function isGoalEvent(event) {
  if (!event) return false;

  const explicitKind = String(event.kind || "").trim().toLowerCase();
  const description = [event.type, event.label]
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const saysGoal = /(?:^|\s)(?:goal|gol|scoring play)(?:$|\s)/.test(description) &&
    !/(?:disallowed|anulado|cancelado|missed|saved|defendido)/.test(description);

  if (explicitKind === "goal" || saysGoal) return true;

  if (["card", "substitution", "penalty", "var", "other"].includes(explicitKind)) {
    return false;
  }

  return false;
}

function matchHasScore(match) {
  return match?.score1 !== null &&
    match?.score1 !== undefined &&
    match?.score1 !== "" &&
    match?.score2 !== null &&
    match?.score2 !== undefined &&
    match?.score2 !== "";
}

function remoteFinishedStatus(match) {
  const text = [match?.status, match?.sourceStatus, match?.elapsed]
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /(?:^|\s)(?:ft|aet|final|finished|encerrado|finalizado|full time|after extra time)(?:$|\s)/.test(text);
}

function remoteTimestamp(match) {
  const values = [match?.sourceUpdatedAt, match?.finalizedAt, match?.detailsSyncedAt];

  for (const value of values) {
    const timestamp = new Date(value || "").getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }

  return 0;
}

function meaningfulDetailValues(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + meaningfulDetailValues(item), 0);
  }

  if (value && typeof value === "object") {
    return Object.values(value).reduce((total, item) => total + meaningfulDetailValues(item), 0);
  }

  return value !== null && value !== undefined && value !== "" ? 1 : 0;
}

function matchDetailsWeight(match) {
  const events = goalOnlyEvents(match?.events).length;
  const statistics = meaningfulDetailValues(match?.statistics);
  return events * 10000 + statistics;
}

function mergeMatches(list, origin = "base") {
  if (!Array.isArray(list)) return false;

  const priority = { base: 1, history: 2, details: 2, live: 3 }[origin] || 1;
  let changed = false;

  list.forEach((item) => {
    const remote = normalizeRemoteMatch(item);
    const match = DATA.matches.find((candidate) => {
      return candidate.id === remote.id || candidate.id === remote.matchId;
    });

    if (!match) return;

    const before = JSON.stringify({
      score1: match.score1,
      score2: match.score2,
      status: match.status,
      elapsed: match.elapsed,
      sourceStatus: match.sourceStatus,
      sourceUpdatedAt: match.sourceUpdatedAt,
      sourceDate: match.sourceDate,
      sourceTime: match.sourceTime,
      sourceDateIso: match.sourceDateIso,
      sourceState: match.sourceState,
      finalizedAt: match.finalizedAt,
      detailsSyncedAt: match.detailsSyncedAt,
      events: match.events,
      statistics: match.statistics
    });
    const sourceStatus = String(remote.sourceStatus || "").toLowerCase();
    const sourceState = String(remote.sourceState || "").toLowerCase();
    const status = String(remote.status || "").toLowerCase();
    const elapsed = String(remote.elapsed || "").toLowerCase();
    const notStarted = sourceState === "pre" ||
      status.includes("pendente") ||
      status.includes("scheduled") ||
      status.includes("timed") ||
      status.includes("atrasado") ||
      status.includes("adiado") ||
      sourceStatus.includes("not_started") ||
      sourceStatus.includes("not started") ||
      sourceStatus.includes("scheduled") ||
      sourceStatus.includes("timed") ||
      sourceStatus.includes("delayed") ||
      sourceStatus.includes("postponed") ||
      elapsed === "notstarted" ||
      elapsed === "not_started" ||
      elapsed === "scheduled" ||
      elapsed === "ns";
    const currentFinished = isFinishedStatus(match) && matchHasScore(match);
    const incomingFinished = remoteFinishedStatus(remote) && matchHasScore(remote);
    const currentPriority = Number(match._mergePriority || 0);
    const currentTimestamp = remoteTimestamp(match);
    const incomingTimestamp = remoteTimestamp(remote);
    const authoritativeReset = origin === "base" &&
      currentPriority <= priority &&
      !incomingFinished &&
      !matchHasScore(remote);
    const protectsCurrent = !authoritativeReset && (
      (currentFinished && !incomingFinished) ||
      (currentFinished && incomingFinished && currentPriority > priority && currentTimestamp > 0 && currentTimestamp >= incomingTimestamp) ||
      (!currentFinished && !incomingFinished && currentPriority > priority && currentTimestamp >= incomingTimestamp)
    );

    if (!protectsCurrent) {
      if (remote.score1 !== undefined) {
        match.score1 = notStarted || remote.score1 === null || remote.score1 === ""
          ? null
          : Number(remote.score1);
      }

      if (remote.score2 !== undefined) {
        match.score2 = notStarted || remote.score2 === null || remote.score2 === ""
          ? null
          : Number(remote.score2);
      }

      if (remote.status !== undefined) match.status = remote.status;
      if (remote.elapsed !== undefined) match.elapsed = notStarted ? "" : remote.elapsed;
      if (remote.source !== undefined) match.source = remote.source;
      if (remote.sourceStatus !== undefined) match.sourceStatus = remote.sourceStatus;
      if (remote.sourceUpdatedAt !== undefined) match.sourceUpdatedAt = remote.sourceUpdatedAt;
      if (remote.sourceDate !== undefined && remote.sourceDate !== "") match.sourceDate = remote.sourceDate;
      if (remote.sourceTime !== undefined && remote.sourceTime !== "") match.sourceTime = remote.sourceTime;
      if (remote.sourceDateIso !== undefined && remote.sourceDateIso !== "") match.sourceDateIso = remote.sourceDateIso;
      if (remote.sourceState !== undefined && remote.sourceState !== "") match.sourceState = remote.sourceState;
      match._mergePriority = Math.max(currentPriority, priority);
    }

    if (remote.homeScorers !== undefined) match.homeScorers = remote.homeScorers;
    if (remote.awayScorers !== undefined) match.awayScorers = remote.awayScorers;
    if (remote.injuryTime !== undefined) match.injuryTime = remote.injuryTime;
    if (remote.espnId !== undefined && remote.espnId !== "") match.espnId = remote.espnId;
    if (remote.finalizedAt !== undefined && remote.finalizedAt !== "") match.finalizedAt = remote.finalizedAt;
    if (remote.detailsSyncedAt !== undefined && remote.detailsSyncedAt !== "") match.detailsSyncedAt = remote.detailsSyncedAt;
    if (remote.team1 !== undefined && remote.team1 !== "") match.team1 = remote.team1;
    if (remote.team2 !== undefined && remote.team2 !== "") match.team2 = remote.team2;

    const hasEventsField = Object.prototype.hasOwnProperty.call(remote, "events");
    const hasStatisticsField = Object.prototype.hasOwnProperty.call(remote, "statistics");
    const incomingEvents = hasEventsField ? goalOnlyEvents(remote.events) : [];
    const incomingStatistics = hasStatisticsField && remote.statistics && typeof remote.statistics === "object"
      ? remote.statistics
      : {};
    const detailsConfirmed = Boolean(remote.detailsSyncedAt) && (hasEventsField || hasStatisticsField);

    if (detailsConfirmed) {
      detailsLoadedMatchIds.add(String(match.id));
    }

    if (hasEventsField) {
      match.events = incomingEvents;
    } else if (Object.prototype.hasOwnProperty.call(match, "events")) {
      match.events = goalOnlyEvents(match.events);
    }

    if (hasStatisticsField) {
      if (matchDetailsWeight({ statistics: incomingStatistics }) >= matchDetailsWeight({ statistics: match.statistics })) {
        match.statistics = incomingStatistics;
      }
    }

    [
      "scoreAfterExtraTime1",
      "scoreAfterExtraTime2",
      "scoreBeforePenalties1",
      "scoreBeforePenalties2",
      "regulationPlusExtraTime1",
      "regulationPlusExtraTime2",
      "betScore1",
      "betScore2",
      "penaltyScore1",
      "penaltyScore2",
      "penalties1",
      "penalties2",
      "shootoutScore1",
      "shootoutScore2"
    ].forEach((field) => {
      if (remote[field] !== undefined && remote[field] !== "") {
        match[field] = remote[field];
      }
    });

    const after = JSON.stringify({
      score1: match.score1,
      score2: match.score2,
      status: match.status,
      elapsed: match.elapsed,
      sourceStatus: match.sourceStatus,
      sourceUpdatedAt: match.sourceUpdatedAt,
      sourceDate: match.sourceDate,
      sourceTime: match.sourceTime,
      sourceDateIso: match.sourceDateIso,
      sourceState: match.sourceState,
      finalizedAt: match.finalizedAt,
      detailsSyncedAt: match.detailsSyncedAt,
      events: match.events,
      statistics: match.statistics
    });
    if (before !== after) changed = true;
  });

  return changed;
}

function backendActionUrl(action) {
  const separator = DATA.settings.apiUrl.includes("?") ? "&" : "?";
  return `${DATA.settings.apiUrl}${separator}action=${encodeURIComponent(action)}&environment=${encodeURIComponent(BACKEND_ENVIRONMENT)}`;
}

function validateBackendEnvironment(payload) {
  const responseEnvironment = String(payload?.environment || "").trim();

  if (!BACKEND_ENVIRONMENT || responseEnvironment !== BACKEND_ENVIRONMENT) {
    throw new Error("Ambiente de dados incorreto. Atualize a página antes de continuar.");
  }
}

function updateBackendTiming(payload, requestStartedAt = Date.now()) {
  const serverTimestamp = new Date(payload?.serverNow || "").getTime();
  const receivedAt = Date.now();

  if (Number.isFinite(serverTimestamp)) {
    const midpoint = (Number(requestStartedAt) + receivedAt) / 2;
    state.serverTimeOffsetMs = serverTimestamp - midpoint;
  }

  if (payload?.roundDeadlines && typeof payload.roundDeadlines === "object") {
    state.roundDeadlines = Object.assign({}, payload.roundDeadlines);
  }
}

function currentServerTimeMs() {
  return Date.now() + Number(state.serverTimeOffsetMs || 0);
}

function currentCompetitionTimeMs() {
  if (state.loadedBackend) {
    return currentServerTimeMs();
  }

  if (Number.isFinite(SIMULATED_COMPETITION_BASE_MS)) {
    return SIMULATED_COMPETITION_BASE_MS + (Date.now() - SIMULATED_COMPETITION_REAL_ANCHOR_MS);
  }

  return Date.now();
}

function loadBaseState() {
  if (!DATA.settings.apiUrl) {
    return Promise.resolve(null);
  }

  if (baseRequestPromise) {
    return baseRequestPromise;
  }

  const requestPicksRevision = picksWriteRevision;
  const requestStartedAt = Date.now();
  state.baseLoadError = "";

  baseRequestPromise = jsonp(backendActionUrl("statefast"))
    .then((payload) => {
      if (!payload || payload.ok === false) {
        throw new Error(payload?.error || "Falha ao carregar.");
      }

      validateBackendEnvironment(payload);
      updateBackendTiming(payload, requestStartedAt);
      persistFocusedBetDraft();

      const signaturePayload = Object.assign({}, payload, {
        matches: payload.homeMatch
          ? [...(payload.matches || []), payload.homeMatch]
          : (payload.matches || [])
      });
      const visualSignature = backendVisualSignature(signaturePayload);
      const shouldRender = !state.loadedBackend || visualSignature !== lastBackendVisualSignature;

      if (
        Array.isArray(payload.picks) &&
        requestPicksRevision === picksWriteRevision
      ) {
        state.picks = {};
        mergePicks(payload.picks);
      }

      mergeMatches(payload.matches || [], "base");
      if (payload.homeMatch) {
        mergeMatches([payload.homeMatch], "details");
      }
      state.resultSyncPending = Math.max(0, Number(payload.resultSyncPending || 0));
      state.detailSyncPending = Math.max(0, Number(payload.detailSyncPending || 0));

      state.loadedBackend = true;
      lastBaseLoadAt = Date.now();
      lastBackendVisualSignature = visualSignature;
      cacheBaseState(payload);

      if (shouldRender) {
        if (isBetInputFocused()) {
          deferredBackendRender = true;
        } else {
          deferredBackendRender = false;
          render();
        }
      }

      requestCurrentHomeMatchDetails();
      window.setTimeout(showClosingRoundAlertIfNeeded, 0);
      return payload;
    })
    .catch((error) => {
      state.baseLoadError = String(error?.message || "Não foi possível carregar os dados.");

      if (!state.loadedBackend && state.view === "inicio") {
        renderHome();
      }

      scheduleBaseStateRetry();
      throw error;
    })
    .finally(() => {
      baseRequestPromise = null;
    });

  return baseRequestPromise;
}

function scheduleBaseStateRetry() {
  if (baseRetryTimer || state.loadedBackend || document.hidden) return;

  baseRetryTimer = window.setTimeout(() => {
    baseRetryTimer = null;
    loadBaseState().catch(() => null);
  }, 4000);
}

function loadLiveState(force = false) {
  if (!DATA.settings.apiUrl || (!force && !shouldUseLiveRefresh())) {
    scheduleLiveRefresh();
    return Promise.resolve(null);
  }

  if (liveRequestPromise) {
    return liveRequestPromise;
  }

  const requestStartedAt = Date.now();
  liveRequestPromise = jsonp(backendActionUrl("live"))
    .then((payload) => {
      if (!payload || payload.ok === false) {
        throw new Error(payload?.error || "Falha ao atualizar o jogo ao vivo.");
      }

      validateBackendEnvironment(payload);
      updateBackendTiming(payload, requestStartedAt);
      state.loadedLive = true;
      const signature = backendVisualSignature({ matches: payload.matches || [] });

      if (signature === lastLiveVisualSignature) {
        return payload;
      }

      persistFocusedBetDraft();
      mergeMatches(payload.matches || [], "live");
      lastLiveVisualSignature = signature;
      refreshAfterLiveUpdate();
      requestCurrentHomeMatchDetails();
      return payload;
    })
    .finally(() => {
      liveRequestPromise = null;
      scheduleLiveRefresh();
    });

  return liveRequestPromise;
}

function loadMatchDetails(matchId) {
  const id = String(matchId || "");
  const retryAt = Number(detailRetryAfter.get(id) || 0);

  if (
    !id ||
    detailsLoadedMatchIds.has(id) ||
    detailRequests.has(id) ||
    retryAt > Date.now() ||
    !DATA.settings.apiUrl
  ) {
    return detailRequests.get(id) || Promise.resolve(null);
  }

  const requestStartedAt = Date.now();
  const request = jsonp(`${backendActionUrl("matchDetails")}&matchId=${encodeURIComponent(id)}`, HISTORY_REQUEST_TIMEOUT_MS)
    .then((payload) => {
      if (!payload || payload.ok === false) {
        throw new Error(payload?.error || "Falha ao carregar os detalhes do jogo.");
      }

      validateBackendEnvironment(payload);
      updateBackendTiming(payload, requestStartedAt);
      if (payload.match) {
        mergeMatches([payload.match], "details");
      }

      const detailsConfirmed = detailsLoadedMatchIds.has(id);
      if (detailsConfirmed) {
        detailRetryAfter.delete(id);
      } else {
        detailRetryAfter.set(id, Date.now() + 60000);
      }

      if (detailsConfirmed && state.view === "inicio" && getHomePicksMatch().match?.id === id) {
        const slot = $("#home-picks-slot");
        if (slot) {
          slot.innerHTML = renderHomeMatchPicksSection();
          bindHomeEvents();
        }
      }

      return payload.match || null;
    })
    .finally(() => {
      detailRequests.delete(id);
    });

  detailRequests.set(id, request);
  return request;
}

function requestCurrentHomeMatchDetails() {
  if (state.view !== "inicio" || !state.loadedBackend) return;
  const match = getHomePicksMatch().match;

  if (match && isFinishedStatus(match) && matchHasScore(match)) {
    loadMatchDetails(match.id).catch(() => null);
  }
}

function refreshAfterLiveUpdate() {
  if (state.view === "inicio") {
    const liveSlot = $("#home-live-slot");
    const picksSlot = $("#home-picks-slot");

    if (!liveSlot || !picksSlot) {
      renderHome();
      return;
    }

    liveSlot.innerHTML = renderLiveSection();
    picksSlot.innerHTML = renderHomeMatchPicksSection();
    bindHomeEvents();
    scheduleHomeMatchTransition();
    return;
  }

  if (state.view === "ranking") {
    renderRanking();
    return;
  }

  if (state.view === "oficial") {
    renderOfficial();
    return;
  }

  if (state.view === "palpites") {
    if (isBetInputFocused()) {
      deferredBackendRender = true;
      return;
    }

    renderPicksArea();
  }
}

function backendVisualSignature(payload) {
  const signature = {};

  if (Array.isArray(payload.matches)) {
    signature.matches = payload.matches.map((item) => {
      const match = normalizeRemoteMatch(item);
      return {
        id: match.id || match.matchId || "",
        score1: match.score1 ?? null,
        score2: match.score2 ?? null,
        status: match.status || "",
        elapsed: match.elapsed || "",
        injuryTime: match.injuryTime || "",
        team1: match.team1 || "",
        team2: match.team2 || "",
        homeScorers: match.homeScorers || [],
        awayScorers: match.awayScorers || [],
        events: match.events || [],
        statistics: match.statistics || {},
        sourceUpdatedAt: match.sourceUpdatedAt || "",
        sourceDate: match.sourceDate || "",
        sourceTime: match.sourceTime || "",
        sourceDateIso: match.sourceDateIso || "",
        sourceState: match.sourceState || "",
        finalizedAt: match.finalizedAt || "",
        detailsSyncedAt: match.detailsSyncedAt || "",
        espnId: match.espnId || "",
        scoreAfterExtraTime1: match.scoreAfterExtraTime1 ?? null,
        scoreAfterExtraTime2: match.scoreAfterExtraTime2 ?? null,
        scoreBeforePenalties1: match.scoreBeforePenalties1 ?? null,
        scoreBeforePenalties2: match.scoreBeforePenalties2 ?? null,
        penaltyScore1: match.penaltyScore1 ?? match.penalties1 ?? match.shootoutScore1 ?? null,
        penaltyScore2: match.penaltyScore2 ?? match.penalties2 ?? match.shootoutScore2 ?? null
      };
    });
  }

  if (Array.isArray(payload.picks)) signature.picks = payload.picks;

  return JSON.stringify(signature);
}

function isBetInputFocused() {
  return state.view === "palpites" &&
    document.activeElement instanceof HTMLInputElement &&
    document.activeElement.matches('input[data-match][data-side]');
}

function persistFocusedBetDraft() {
  if (!isBetInputFocused() || !state.selectedPlayer) return;

  const activeInput = document.activeElement;
  const matchId = activeInput.dataset.match;
  const g1 = document.querySelector(`input[data-match="${matchId}"][data-side="g1"]`)?.value ?? "";
  const g2 = document.querySelector(`input[data-match="${matchId}"][data-side="g2"]`)?.value ?? "";

  setDraftPick(state.selectedPlayer, state.betRound, matchId, g1, g2);
}

function flushDeferredBackendRender() {
  window.setTimeout(() => {
    if (!deferredBackendRender || isBetInputFocused()) return;
    deferredBackendRender = false;
    render();
  }, 0);
}

function setupAutoRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (liveRefreshTimer) {
        window.clearTimeout(liveRefreshTimer);
        liveRefreshTimer = null;
      }
      return;
    }

    const baseIsStale = Date.now() - lastBaseLoadAt >= BASE_STATE_STALE_MS;
    const baseRefresh = baseIsStale
      ? loadBaseState().catch(() => null)
      : Promise.resolve(null);

    baseRefresh.finally(() => {
      if (shouldUseLiveRefresh() || hasRecentFinishedMatch()) {
        loadLiveState().catch(() => null);
      } else {
        scheduleLiveRefresh();
      }
    });
  });

  window.addEventListener("pagehide", persistFocusedBetDraft);
}

function scheduleLiveRefresh() {
  if (liveRefreshTimer) {
    window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  if (document.hidden || !shouldUseLiveRefresh()) {
    return;
  }

  liveRefreshTimer = window.setTimeout(() => {
    liveRefreshTimer = null;
    loadLiveState().catch(() => null);
  }, LIVE_REFRESH_MS);
}

function jsonp(url, timeoutMs = BACKEND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const callbackName = `bolaoCallback_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const script = document.createElement("script");
    const sep = url.includes("?") ? "&" : "?";
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    };

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    const timeoutId = window.setTimeout(() => {
      finish(reject, new Error("Tempo limite excedido ao carregar dados."));
    }, timeoutMs);

    window[callbackName] = (payload) => {
      finish(resolve, payload);
    };

    script.async = true;
    script.onerror = () => {
      finish(reject, new Error("Erro ao carregar dados."));
    };

    script.src = `${url}${sep}callback=${callbackName}`;
    document.body.appendChild(script);
  });
}

function submitBackend(payload) {
  if (!DATA.settings.apiUrl) return Promise.resolve({ ok: true });

  const compact = {
    action: "savePicks",
    environment: BACKEND_ENVIRONMENT,
    playerId: payload.playerId,
    playerCode: payload.playerCode,
    round: payload.round,
    deadline: roundDeadline(payload.round).toISOString(),
    lockMinutesBeforeRound: Number(DATA.settings.lockMinutesBeforeRound ?? 15),
    picks: payload.picks.map((pick) => ({
      m: pick.matchId,
      a: pick.g1,
      b: pick.g2
    }))
  };

  const url = `${DATA.settings.apiUrl}?payload=${encodeURIComponent(JSON.stringify(compact))}`;
  return jsonp(url);
}

function render() {
  setActiveTab();

  if (deadlineRefreshTimer && state.view !== "inicio" && state.view !== "palpites") {
    window.clearInterval(deadlineRefreshTimer);
    deadlineRefreshTimer = null;
  }

  if (deadlineLockTimer && state.view !== "palpites") {
    window.clearTimeout(deadlineLockTimer);
    deadlineLockTimer = null;
  }

  if (state.view === "ranking") {
    renderRanking();
    return;
  }

  if (state.view === "oficial") {
    renderOfficial();
    return;
  }

  if (state.view === "palpites") {
    renderPicksArea();
    return;
  }

  renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="stack">
      <div id="home-live-slot">${renderLiveSection()}</div>
      ${renderNextRoundDeadlineSection()}
      <div id="home-picks-slot">${renderHomeMatchPicksSection()}</div>
      ${renderUpcomingGamesSection()}
      ${renderSponsorBlock(true)}
    </div>
  `;

  bindHomeEvents();
  scheduleHomeMatchTransition();
  scheduleDeadlineRefresh();
}

function renderRanking() {
  const allowedRanges = ["last10", "all", "groups", "knockout"];
  if (!allowedRanges.includes(state.rankingRange)) {
    state.rankingRange = "last10";
  }

  app.innerHTML = `
    <div class="stack">
      <section class="card ranking-current-card">
        <div class="title-row">
          <h2>🏆 Ranking dos players</h2>
          <span class="kicker">Classificação atual</span>
        </div>
        ${!state.loadedBackend
          ? `<div class="info-box">Carregando classificação...</div>`
          : rankingTable(calculateRanking())}
      </section>

      <section class="card ranking-page-card">
        <div class="title-row">
          <h2>📈 Variação de posições</h2>
          <span class="kicker">Por jogo</span>
        </div>

        <div class="ranking-filter-buttons" role="group" aria-label="Período do gráfico de ranking">
          ${rankingFilterButton("last10", "Últimos 10 jogos")}
          ${rankingFilterButton("all", "Desde sempre")}
          ${rankingFilterButton("groups", "Apenas grupos")}
          ${rankingFilterButton("knockout", "Apenas Mata-mata")}
        </div>

        ${!state.loadedBackend
          ? `<div class="info-box ranking-chart-empty">Carregando histórico do ranking...</div>`
          : renderRankingEvolutionChart(state.rankingRange)}
      </section>

      ${renderSponsorBlock(true)}
    </div>
  `;

  bindRankingEvents();
}

function rankingFilterButton(value, label) {
  const active = state.rankingRange === value;
  return `
    <button
      type="button"
      class="ranking-filter-button ${active ? "active" : ""}"
      data-ranking-range="${value}"
      aria-pressed="${active ? "true" : "false"}"
    >${label}</button>
  `;
}

function bindRankingEvents() {
  document.querySelectorAll("[data-ranking-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const range = button.dataset.rankingRange || "last10";
      state.rankingRange = range;
      localStorage.setItem("bolao-ranking-range", range);
      renderRanking();
      setActiveTab();
    });
  });
}

function getCompletedRankedMatches(range) {
  let completed = DATA.matches
    .filter((match) => {
      const score = getPredictionScore(match);
      return isFinishedStatus(match) && score.home !== null && score.away !== null;
    })
    .sort(compareFinishedMatches);

  if (range === "groups") {
    completed = completed.filter((match) => groupStageRounds.includes(match.round));
  } else if (range === "knockout") {
    completed = completed.filter((match) => !groupStageRounds.includes(match.round));
  } else if (range === "last10") {
    completed = completed.slice(-10);
  }

  return completed;
}

function buildRankingAtMatches(matches) {
  const matchIds = new Set(matches.map((match) => match.id));

  return DATA.players.map((player) => {
    let points = 0;
    let exacts = 0;

    DATA.matches.forEach((match) => {
      if (!matchIds.has(match.id)) return;
      const scored = scorePick(state.picks[player.id]?.[match.id], match);
      points += scored.points;
      exacts += scored.exact ? 1 : 0;
    });

    return { id: player.id, name: player.name, points, exacts };
  }).sort((first, second) => {
    return second.points - first.points ||
      second.exacts - first.exacts ||
      first.name.localeCompare(second.name);
  });
}

function renderRankingEvolutionChart(range) {
  const matches = getCompletedRankedMatches(range);

  if (!matches.length) {
    const message = range === "knockout"
      ? "O gráfico do Mata-mata aparecerá após o primeiro jogo finalizado."
      : "O gráfico aparecerá após o primeiro jogo finalizado.";
    return `<div class="info-box ranking-chart-empty">${message}</div>`;
  }

  const allCompletedMatches = getCompletedRankedMatches("all");
  const snapshots = matches.map((match) => {
    const absoluteIndex = allCompletedMatches.findIndex((item) => item.id === match.id);
    const ranking = buildRankingAtMatches(
      allCompletedMatches.slice(0, Math.max(0, absoluteIndex) + 1)
    );

    return {
      match,
      positions: new Map(ranking.map((player, position) => [player.id, position + 1]))
    };
  });

  const chartHeight = 500;
  const top = 30;
  const bottom = 62;
  const left = 54;
  const right = 128;
  const pointGap = range === "all" ? 54 : 86;
  const chartWidth = Math.max(760, left + right + Math.max(1, matches.length - 1) * pointGap);
  const plotHeight = chartHeight - top - bottom;
  const plotWidth = chartWidth - left - right;
  const xFor = (index) => matches.length === 1
    ? left + plotWidth / 2
    : left + index * (plotWidth / (matches.length - 1));
  const yFor = (position) => top + ((position - 1) / Math.max(1, DATA.players.length - 1)) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(matches.length / 10));

  const grid = DATA.players.map((_, index) => {
    const position = index + 1;
    const y = yFor(position);
    return `
      <line class="ranking-chart-grid-line" x1="${left}" y1="${y}" x2="${chartWidth - right}" y2="${y}"></line>
      <text class="ranking-chart-rank-label" x="${left - 14}" y="${y + 4}" text-anchor="end">${position}º</text>
    `;
  }).join("");

  const series = DATA.players.map((player, playerIndex) => {
    const points = snapshots.map((snapshot, index) => ({
      x: xFor(index),
      y: yFor(snapshot.positions.get(player.id) || DATA.players.length),
      position: snapshot.positions.get(player.id) || DATA.players.length,
      match: snapshot.match
    }));
    const hue = Math.round((playerIndex * 360) / DATA.players.length);
    const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");
    const last = points[points.length - 1];

    return `
      <g class="ranking-chart-player" style="--ranking-player-color:hsl(${hue} 82% 62%)">
        <polyline class="ranking-chart-line" points="${pointString}"></polyline>
        ${points.map((point) => `
          <circle class="ranking-chart-point" cx="${point.x}" cy="${point.y}" r="4">
            <title>${escapeHtml(player.name)}: ${point.position}º após o Jogo ${point.match.number}</title>
          </circle>
        `).join("")}
        <text class="ranking-chart-end-label" x="${last.x + 10}" y="${last.y + 4}">${escapeHtml(player.name)}</text>
      </g>
    `;
  }).join("");

  const xLabels = matches.map((match, index) => {
    const shouldShow = index === 0 || index === matches.length - 1 || index % labelEvery === 0;
    if (!shouldShow) return "";
    const x = xFor(index);
    return `
      <text class="ranking-chart-game-label" x="${x}" y="${chartHeight - 28}" text-anchor="middle">J${match.number}</text>
    `;
  }).join("");

  return `
    <div class="ranking-chart-summary">
      <strong>${matches.length} jogo${matches.length === 1 ? "" : "s"}</strong>
      <span>Posição 1 no topo; passe o cursor ou toque nos pontos para ver o jogo.</span>
    </div>
    <div class="ranking-chart-scroll" tabindex="0" aria-label="Gráfico de variação do ranking por jogo">
      <svg class="ranking-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" width="${chartWidth}" height="${chartHeight}" role="img" aria-label="Variação da posição de cada jogador no ranking">
        ${grid}
        ${series}
        ${xLabels}
      </svg>
    </div>
  `;
}

function getRoundSchedule() {
  return rounds
    .map((round) => {
      const matches = DATA.matches
        .filter((match) => match.round === round)
        .sort((first, second) => makeDate(first) - makeDate(second));

      return {
        round,
        matches,
        firstKickoff: matches.length ? makeDate(matches[0]).getTime() : Number.NaN,
        lastKickoff: matches.length ? makeDate(matches[matches.length - 1]).getTime() : Number.NaN
      };
    })
    .filter((item) => item.matches.length)
    .sort((first, second) => first.firstKickoff - second.firstKickoff);
}

function getCurrentRoundIndex() {
  const schedule = getRoundSchedule();

  if (!schedule.length) {
    return -1;
  }

  const liveRound = DATA.matches
    .filter((match) => isLiveMatch(match))
    .sort((first, second) => makeDate(first) - makeDate(second))[0]?.round;

  if (liveRound) {
    const liveIndex = schedule.findIndex((item) => item.round === liveRound);
    if (liveIndex >= 0) return liveIndex;
  }

  const now = currentCompetitionTimeMs();
  let latestStartedIndex = -1;

  schedule.forEach((item, index) => {
    if (Number.isFinite(item.firstKickoff) && item.firstKickoff <= now) {
      latestStartedIndex = index;
    }
  });

  if (latestStartedIndex < 0) {
    return 0;
  }

  if (latestStartedIndex < schedule.length - 1) {
    const currentRound = schedule[latestStartedIndex];
    const allMatchesFinished = currentRound.matches.every((match) => isFinishedStatus(match));
    const scheduledWindowEnded = Number.isFinite(currentRound.lastKickoff) &&
      now > currentRound.lastKickoff + ACTIVE_MATCH_GRACE_MS;

    if (allMatchesFinished || scheduledWindowEnded) {
      return latestStartedIndex + 1;
    }
  }

  return latestStartedIndex;
}

function getCurrentRoundName() {
  const schedule = getRoundSchedule();
  const index = getCurrentRoundIndex();
  return schedule[index]?.round || schedule[0]?.round || rounds[0] || "";
}

function getNextRoundInfo() {
  const now = currentCompetitionTimeMs();

  return getRoundSchedule().find((item) => {
    return Number.isFinite(item.firstKickoff) && item.firstKickoff > now;
  }) || null;
}

function renderNextRoundDeadlineSection() {
  const nextRound = getNextRoundInfo();

  if (!nextRound) {
    return "";
  }

  const deadline = roundDeadline(nextRound.round);

  if (Number.isNaN(deadline.getTime())) {
    return "";
  }

  return `
    <section class="card next-round-deadline-card" data-deadline-round="${escapeHtml(nextRound.round)}">
      <div class="next-round-deadline-icon" aria-hidden="true">⏰</div>
      <div class="next-round-deadline-content">
        <span class="next-round-deadline-label">Fechamento dos palpites</span>
        <strong class="next-round-deadline-round">${escapeHtml(displayRound(nextRound.round))}</strong>
        <div class="next-round-deadline-highlight">
          <div class="next-round-deadline-countdown-block">
            <span class="next-round-deadline-block-label">Tempo restante</span>
            <strong class="round-deadline-countdown" data-deadline-time="${deadline.getTime()}">${formatDeadlineCountdown(deadline)}</strong>
          </div>
          <div class="next-round-deadline-date-block">
            <span class="next-round-deadline-block-label">Data e horário limite</span>
            <strong class="next-round-deadline-date">${formatDateTime(deadline)}</strong>
          </div>
        </div>
      </div>
    </section>
  `;
}

function formatDeadlineCountdown(deadline) {
  const remaining = deadline.getTime() - currentCompetitionTimeMs();

  if (!Number.isFinite(remaining) || remaining <= 0) {
    return "Prazo encerrado";
  }

  const totalMinutes = Math.max(1, Math.ceil(remaining / 60000));

  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return `Faltam ${days} dia${days === 1 ? "" : "s"}${hours ? ` e ${hours}h` : ""}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `Faltam ${hours}h${minutes ? ` ${minutes}min` : ""}`;
  }

  return `Faltam ${minutes} minuto${minutes === 1 ? "" : "s"}`;
}

function updateDeadlineCountdowns() {
  document.querySelectorAll(".round-deadline-countdown[data-deadline-time]").forEach((element) => {
    const timestamp = Number(element.dataset.deadlineTime);
    element.textContent = formatDeadlineCountdown(new Date(timestamp));
  });

  if (state.view === "palpites") {
    const locked = isRoundLocked(state.betRound);

    if (lastBetRoundLocked === false && locked) {
      persistFocusedBetDraft();
      state.betRoundManuallySelected = false;
      state.picksRoundManuallySelected = false;
      renderPicksArea();
      return;
    }

    lastBetRoundLocked = locked;
  }
}

function scheduleDeadlineRefresh() {
  if (deadlineRefreshTimer) {
    window.clearInterval(deadlineRefreshTimer);
    deadlineRefreshTimer = null;
  }

  if (deadlineLockTimer) {
    window.clearTimeout(deadlineLockTimer);
    deadlineLockTimer = null;
  }

  updateDeadlineCountdowns();
  deadlineRefreshTimer = window.setInterval(updateDeadlineCountdowns, 30000);

  if (state.view !== "palpites") return;

  const deadline = roundDeadline(state.betRound);
  const delay = deadline.getTime() - currentCompetitionTimeMs();

  if (!Number.isFinite(delay) || delay <= 0) {
    lastBetRoundLocked = true;
    return;
  }

  deadlineLockTimer = window.setTimeout(() => {
    deadlineLockTimer = null;
    persistFocusedBetDraft();

    if (state.view === "palpites") {
      state.betRoundManuallySelected = false;
      state.picksRoundManuallySelected = false;
      renderPicksArea();
    }
  }, Math.min(delay + 50, 2147483647));
}

function playerHasCompleteRoundPicks(playerId, round) {
  const matches = DATA.matches.filter((match) => match.round === round);

  if (!playerId || !matches.length) {
    return false;
  }

  return matches.every((match) => {
    const pick = state.picks?.[playerId]?.[match.id];
    return Number.isInteger(Number(pick?.g1)) && Number.isInteger(Number(pick?.g2));
  });
}

function ensureClosingRoundModalStyles() {
  if (document.getElementById("closing-round-modal-critical-styles")) return;

  const style = document.createElement("style");
  style.id = "closing-round-modal-critical-styles";
  style.textContent = `
    body.modal-open{overflow:hidden!important}
    .closing-round-modal{position:fixed!important;inset:0!important;z-index:99999!important;display:grid!important;place-items:center!important;padding:18px!important}
    .closing-round-modal-backdrop{position:absolute!important;inset:0!important;background:rgba(0,3,10,.86)!important;backdrop-filter:blur(7px)!important}
    .closing-round-modal-card{position:relative!important;z-index:1!important;width:min(100%,440px)!important;border:1px solid rgba(255,255,255,.72)!important;border-top:4px solid #ff1738!important;border-radius:20px!important;padding:22px 18px 18px!important;background:linear-gradient(180deg,rgba(11,22,41,.99),rgba(3,8,18,.99))!important;box-shadow:0 26px 70px rgba(0,0,0,.58)!important;text-align:center!important;color:#f8fbff!important}
    .closing-round-modal-icon{font-size:34px!important;line-height:1!important}
    .closing-round-modal-card h2{margin:10px 0 8px!important;font-size:22px!important}
    .closing-round-modal-countdown{display:block!important;margin-top:5px!important;color:#ffcf3a!important;font-size:29px!important;line-height:1.05!important;font-weight:1000!important}
    .closing-round-modal-date{margin-top:8px!important;color:#fff!important;font-size:17px!important;font-weight:950!important}
    .closing-round-modal-card p{margin:14px 0 18px!important;color:#aeb8c7!important;line-height:1.45!important;font-weight:800!important}
    .closing-round-modal-ok{width:100%!important;min-height:44px!important}
  `;
  document.head.appendChild(style);
}

function closeClosingRoundAlert() {
  document.querySelector(".closing-round-modal")?.remove();
  document.body.classList.remove("modal-open");
}

function showClosingRoundAlertIfNeeded() {
  if (state.closingRoundAlertShown || !state.loadedBackend || !state.selectedPlayer) {
    return;
  }

  const nextRound = getNextRoundInfo();

  if (!nextRound) {
    return;
  }

  const deadline = roundDeadline(nextRound.round);
  const remaining = deadline.getTime() - currentCompetitionTimeMs();

  if (!Number.isFinite(remaining) || remaining <= 0 || remaining >= 24 * 60 * 60 * 1000) {
    return;
  }

  if (playerHasCompleteRoundPicks(state.selectedPlayer, nextRound.round)) {
    return;
  }

  state.closingRoundAlertShown = true;
  ensureClosingRoundModalStyles();
  const modal = document.createElement("div");
  modal.className = "closing-round-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "closing-round-modal-title");
  modal.innerHTML = `
    <div class="closing-round-modal-backdrop"></div>
    <div class="closing-round-modal-card">
      <div class="closing-round-modal-icon" aria-hidden="true">⏰</div>
      <h2 id="closing-round-modal-title">Fechamento de ${escapeHtml(displayRound(nextRound.round))}</h2>
      <strong class="closing-round-modal-countdown">${formatDeadlineCountdown(deadline)}</strong>
      <div class="closing-round-modal-date">Fecha em ${formatDateTime(deadline)}</div>
      <p>Você ainda não preencheu todos os palpites desta rodada. Preencha antes do fechamento.</p>
      <button type="button" class="btn closing-round-modal-ok">OK</button>
    </div>
  `;

  document.body.appendChild(modal);
  document.body.classList.add("modal-open");
  const okButton = modal.querySelector(".closing-round-modal-ok");
  okButton?.addEventListener("click", closeClosingRoundAlert);
  window.setTimeout(() => okButton?.focus(), 0);
}

function getNextScheduledMatch() {
  return DATA.matches
    .filter((match) => isFutureScheduledMatch(match))
    .sort((a, b) => makeDate(a) - makeDate(b))[0] || null;
}

function getFeaturedPendingMatches() {
  const now = currentCompetitionTimeMs();
  const candidates = DATA.matches
    .filter((match) => {
      if (!match || isLiveMatch(match) || isFinishedStatus(match)) return false;

      const kickoff = makeDate(match).getTime();
      return Number.isFinite(kickoff) && (
        (kickoff >= now && kickoff <= now + UPCOMING_FEATURE_WINDOW_MS) ||
        isDelayedScheduledMatch(match)
      );
    })
    .sort((first, second) => {
      return makeDate(first).getTime() - makeDate(second).getTime() ||
        Number(first.number || 0) - Number(second.number || 0);
    });

  if (!candidates.length) {
    return [];
  }

  const anchorKickoff = makeDate(candidates[0]).getTime();

  return candidates.filter((match) => makeDate(match).getTime() === anchorKickoff);
}

function scheduleHomeMatchTransition() {
  if (homeMatchTransitionTimer) {
    window.clearTimeout(homeMatchTransitionTimer);
    homeMatchTransitionTimer = null;
  }

  const nextMatch = getNextScheduledMatch();

  if (!nextMatch || hasLiveMatches()) {
    return;
  }

  const now = currentCompetitionTimeMs();
  const kickoffAt = makeDate(nextMatch).getTime();
  const featureAt = kickoffAt - UPCOMING_FEATURE_WINDOW_MS;
  const transitionAt = now < featureAt ? featureAt : kickoffAt;
  const delay = transitionAt - now;

  if (delay <= 0) {
    return;
  }

  homeMatchTransitionTimer = window.setTimeout(() => {
    homeMatchTransitionTimer = null;

    if (currentCompetitionTimeMs() >= kickoffAt) {
      loadLiveState().catch(() => null);
      scheduleLiveRefresh();
    } else if (state.view === "inicio") {
      render();
    }

    scheduleHomeMatchTransition();
  }, Math.min(delay, 2147483647));
}

function getHomeReferenceMatch() {
  if (!state.loadedBackend) return null;
  return getLastFinishedMatch() || getChronologicalMatches()[0] || null;
}

function getChronologicalMatches() {
  return DATA.matches
    .slice()
    .sort((first, second) => {
      const timeDiff = makeDate(first).getTime() - makeDate(second).getTime();
      return timeDiff || Number(first.number || 0) - Number(second.number || 0);
    });
}

function getHomePicksMatch() {
  const matches = getChronologicalMatches();

  if (!matches.length) {
    return { match: null, matches, index: -1 };
  }

  let match = null;

  if (state.homePicksManual && state.homePicksMatchId) {
    match = matches.find((item) => item.id === state.homePicksMatchId) || null;
  }

  if (!match) {
    match = getHomeReferenceMatch();

    if (!match) {
      return { match: null, matches, index: -1 };
    }

    state.homePicksMatchId = match.id;
    state.homePicksManual = false;
  }

  return {
    match,
    matches,
    index: matches.findIndex((item) => item.id === match.id)
  };
}

function renderHomeMatchPicksSection() {
  const navigation = getHomePicksMatch();
  const match = navigation.match;

  if (!match) {
    return `
      <section class="card home-match-picks-section">
        <div class="title-row home-picks-title-row">
          <h2>🎯 Palpites</h2>
          <span class="kicker">Histórico</span>
        </div>
        ${state.baseLoadError
          ? `<div class="info-box load-error-box">Não foi possível carregar os jogos finalizados.<button type="button" class="btn retry-base-load" id="retryBaseLoad">Tentar novamente</button></div>`
          : `<div class="info-box">Carregando o último jogo finalizado...</div>`
        }
      </section>
    `;
  }

  const isLive = isLiveMatch(match);
  const isFinished = isFinishedStatus(match);
  const isDelayed = isDelayedScheduledMatch(match);
  const isUpcoming = !isLive && !isFinished && isFutureScheduledMatch(match);
  const statusLabel = isLive
    ? "Jogo ao vivo"
    : isFinished
      ? "Jogo finalizado"
      : isDelayed
        ? "Jogo atrasado"
        : isUpcoming
          ? "Próximo jogo"
          : "Aguardando atualização";
  const roundClosed = isRoundLocked(match.round);
  const activeIndex = navigation.index;
  const total = navigation.matches.length;

  return `
    <section class="card home-match-picks-section">
      <div class="title-row home-picks-title-row">
        <h2>🎯 Palpites</h2>
        <span class="kicker">${statusLabel}</span>
      </div>

      <div class="home-picks-navigation" aria-label="Navegação entre os jogos">
        <button
          type="button"
          class="home-picks-nav-button"
          id="previousHomePicksGame"
          aria-label="Mostrar palpites do jogo anterior"
          ${activeIndex <= 0 ? "disabled" : ""}
        >←</button>

        <span class="home-picks-position" aria-live="polite">
          Jogo ${activeIndex + 1} de ${total}
        </span>

        <button
          type="button"
          class="home-picks-nav-button"
          id="nextHomePicksGame"
          aria-label="Mostrar palpites do próximo jogo"
          ${activeIndex >= total - 1 ? "disabled" : ""}
        >→</button>
      </div>

      <div class="pick-card">
        <div class="pick-top">
          <span>${match.group} · Jogo ${match.number}</span>
          <span>${formatMatchDate(match)} · ${formatMatchTime(match)}</span>
        </div>

        ${matchLine(match)}
        ${renderHomeFinishedMatchDetails(match)}

        ${roundClosed
          ? `<div class="player-picks">
              ${DATA.players.map((player) => {
                const pick = state.picks[player.id]?.[match.id];

                return `
                  <div class="player-pick ${playerPickClass(pick, match)}">
                    <span class="player-pick-name">${player.name}</span>
                    <span class="player-pick-score">${formatPick(pick)}</span>
                    <span class="player-pick-date">${formatPickLastSaved(pick)}</span>
                    ${playerPickResultBadge(pick, match)}
                  </div>
                `;
              }).join("")}
            </div>`
          : `<div class="notice picks-locked-notice">🔒 Os palpites serão exibidos após o fechamento da rodada.</div>`
        }
      </div>
    </section>
  `;
}

function renderHomeFinishedMatchDetails(match) {
  if (!isFinishedStatus(match)) {
    if (isDelayedScheduledMatch(match)) {
      return `<div class="info-box historical-result-pending">Partida atrasada. Aguardando o novo horário informado pela ESPN.</div>`;
    }

    if (isPastMatchAwaitingResult(match)) {
      return `<div class="info-box historical-result-pending">Aguardando atualização da ESPN sobre o início ou encerramento deste jogo.</div>`;
    }

    return "";
  }

  const events = liveMatchEvents(match);
  const statistics = liveMatchStatistics(match);
  const detailsPending = !match.detailsSyncedAt;

  if (!events.length && !statistics && !detailsPending) {
    return "";
  }

  return `
    <div class="home-finished-match-details">
      ${detailsPending
        ? `<div class="info-box historical-result-pending">Sincronizando os gols e as estatísticas deste jogo finalizado...</div>`
        : ""}
      ${events.length ? `
        <div class="finished-events-title">Gols</div>
        <div class="live-event-list finished-goals-aligned">
          ${events.map((event) => liveEventRow(event, match)).join("")}
        </div>
      ` : ""}
      ${statistics}
    </div>
  `;
}

function bindHomeEvents() {
  const retryButton = $("#retryBaseLoad");
  if (retryButton) {
    retryButton.addEventListener("click", () => {
      state.baseLoadError = "";
      renderHome();
      loadBaseState().catch(() => null);
    });
  }

  const navigation = getHomePicksMatch();
  const previous = $("#previousHomePicksGame");
  const next = $("#nextHomePicksGame");

  const selectByOffset = (offset) => {
    const targetIndex = Math.max(
      0,
      Math.min(navigation.matches.length - 1, navigation.index + offset)
    );
    const target = navigation.matches[targetIndex];

    if (!target || target.id === navigation.match?.id) return;

    state.homePicksMatchId = target.id;
    state.homePicksManual = true;
    renderHome();
  };

  previous?.addEventListener("click", () => selectByOffset(-1));
  next?.addEventListener("click", () => selectByOffset(1));
  requestCurrentHomeMatchDetails();
}

function getDisplayedLiveMatches() {
  const liveMatches = DATA.matches
    .filter((match) => isLiveMatch(match))
    .sort((first, second) => {
      return makeDate(first).getTime() - makeDate(second).getTime() ||
        Number(first.number || 0) - Number(second.number || 0);
    });

  if (!liveMatches.length) {
    return getFeaturedPendingMatches();
  }

  const liveKickoffs = new Set(liveMatches.map((match) => makeDate(match).getTime()));
  const now = currentCompetitionTimeMs();
  const pairedPendingMatches = DATA.matches.filter((match) => {
    if (!match || isLiveMatch(match) || isFinishedStatus(match)) return false;

    const kickoff = makeDate(match).getTime();
    return liveKickoffs.has(kickoff) &&
      kickoff <= now &&
      kickoff >= now - ACTIVE_MATCH_GRACE_MS;
  });

  return [...liveMatches, ...pairedPendingMatches]
    .filter((match, index, list) => list.findIndex((item) => item.id === match.id) === index)
    .sort((first, second) => {
      return makeDate(first).getTime() - makeDate(second).getTime() ||
        Number(first.number || 0) - Number(second.number || 0);
    });
}

function renderLiveSection() {
  const displayedMatches = getDisplayedLiveMatches();

  if (!displayedMatches.length) {
    return "";
  }

  return `
    <div class="live-match-panels ${displayedMatches.length > 1 ? "has-simultaneous-games" : ""}">
      ${displayedMatches.map((match) => renderLiveMatchPanel(match, displayedMatches.length)).join("")}
    </div>
  `;
}

function renderLiveMatchPanel(match, totalMatches) {
  const live = isLiveMatch(match);
  const delayed = isDelayedScheduledMatch(match);
  const interrupted = isInterruptedMatch(match);
  const kickoff = makeDate(match).getTime();
  const kicker = delayed
    ? "Aguardando novo horário"
    : live
      ? interrupted
        ? "Jogo interrompido"
        : totalMatches > 1
          ? `Jogo ${match.number} em andamento`
          : "Atualização ESPN"
      : kickoff <= currentCompetitionTimeMs()
        ? "Aguardando atualização ESPN"
        : "Começa em até 30 minutos";
  const title = delayed ? "⏳ Jogo atrasado" : "🔴 Ao vivo";

  return `
    <section class="card live-section live-match-panel ${live ? "" : "upcoming-featured-section"}" data-match-id="${escapeHtml(match.id)}">
      <div class="title-row">
        <h2>${title}</h2>
        <span class="kicker">${escapeHtml(kicker)}</span>
      </div>

      ${liveGameCard(match, live)}
    </section>
  `;
}

function liveGameCard(match, includePicks) {
  const live = isLiveMatch(match);

  return `
    <div class="live-game-card ${live ? "" : "upcoming-featured-card"}" data-match-id="${escapeHtml(match.id)}">
      <div class="game-top">
        <span>${displayRound(match.round)} · Jogo ${match.number}</span>
        <span>${formatMatchDate(match)} · ${formatMatchTime(match)}</span>
      </div>

      ${live ? liveMatchLine(match) : matchLine(match)}
      ${live ? liveMatchDetails(match) : ""}
      ${includePicks ? renderLiveMatchPicks(match) : ""}

      <div class="muted live-venue">${escapeHtml(match.venue || "")}</div>
    </div>
  `;
}

function renderLiveMatchPicks(match) {
  if (!isRoundLocked(match.round)) {
    return `<div class="notice picks-locked-notice live-picks-locked">🔒 Os palpites serão exibidos após o fechamento da rodada.</div>`;
  }

  return `
    <div class="live-match-picks-block">
      <div class="live-match-picks-title">Palpites</div>
      <div class="player-picks live-player-picks">
        ${DATA.players.map((player) => {
          const pick = state.picks[player.id]?.[match.id];

          return `
            <div class="player-pick ${playerPickClass(pick, match)}">
              <span class="player-pick-name">${player.name}</span>
              <span class="player-pick-score">${formatPick(pick)}</span>
              <span class="player-pick-date">${formatPickLastSaved(pick)}</span>
              ${playerPickResultBadge(pick, match)}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function liveMatchLine(match) {
  const homeScore = match.score1 === null || match.score1 === undefined
    ? "0"
    : String(match.score1);
  const awayScore = match.score2 === null || match.score2 === undefined
    ? "0"
    : String(match.score2);
  const liveStatus = formatLiveStatus(match);

  return `
    <div class="live-scoreboard">
      <div class="live-score-team live-score-home">
        ${country(matchTeamName(match, "home"))}
      </div>

      <strong class="live-score-number">${homeScore}</strong>

      <div class="live-score-center">
        <div class="live-score-divider" aria-hidden="true">×</div>
        ${liveStatus ? `<span class="live-clock">${escapeHtml(liveStatus)}</span>` : ""}
      </div>

      <strong class="live-score-number">${awayScore}</strong>

      <div class="live-score-team live-score-away">
        ${country(matchTeamName(match, "away"))}
      </div>
    </div>
  `;
}

function formatLiveStatus(match) {
  const elapsed = String(match && match.elapsed || "").trim();

  if (!elapsed) {
    return "";
  }

  if (/^\d{1,3}(?:\+\d{1,2})?$/.test(elapsed)) {
    return `${elapsed}'`;
  }

  return elapsed;
}

function finishedMatchTimestamp(match) {
  const kickoff = makeDate(match).getTime();
  const earliest = kickoff - 10 * 60 * 1000;
  const latest = kickoff + 8 * 60 * 60 * 1000;
  const timestamps = [match?.finalizedAt, match?.sourceUpdatedAt]
    .map((value) => new Date(value || "").getTime())
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= earliest && timestamp <= latest);

  if (timestamps.length) {
    return Math.max(...timestamps);
  }

  return Number.isFinite(kickoff) ? kickoff + ACTIVE_MATCH_GRACE_MS : 0;
}

function compareFinishedMatches(first, second) {
  return finishedMatchTimestamp(first) - finishedMatchTimestamp(second) ||
    Number(first.number || 0) - Number(second.number || 0);
}

function getLastFinishedMatch() {
  return DATA.matches
    .filter((match) => isFinishedStatus(match) && matchHasScore(match))
    .sort((first, second) => compareFinishedMatches(second, first))[0] || null;
}

function getUpcomingGamesLimit() {
  const currentRound = getCurrentRoundName();

  if (currentRound === "Rodada 1") return 4;
  if (currentRound === "Rodada 2") return 5;
  if (currentRound === "Rodada 3") return 8;
  return 2;
}

function renderUpcomingGamesSection() {
  const limit = getUpcomingGamesLimit();
  const upcoming = DATA.matches
    .filter((match) => isFutureScheduledMatch(match))
    .sort((first, second) => {
      return makeDate(first).getTime() - makeDate(second).getTime() ||
        Number(first.number || 0) - Number(second.number || 0);
    })
    .slice(0, limit);

  return `
    <section class="card upcoming-card">
      <div class="title-row">
        <h2>⏭️ Próximos jogos</h2>
        <span class="kicker">${upcoming.length} próximo${upcoming.length === 1 ? "" : "s"}</span>
      </div>

      ${upcoming.length
        ? `<div class="compact-games">${upcoming.map(compactGameCard).join("")}</div>`
        : `<div class="info-box">Sem próximos jogos cadastrados.</div>`
      }
    </section>
  `;
}

function resolvedTeamName(label) {
  const value = String(label || "").trim();
  const candidates = resolveTeamCandidates(value);
  return candidates.length === 1 ? candidates[0] : value;
}

function matchTeamName(match, side) {
  const key = side === "away" ? "team2" : "team1";
  return resolvedTeamName(match?.[key]);
}

function matchTeamDisplay(match, side) {
  const key = side === "away" ? "team2" : "team1";
  const label = String(match?.[key] || "").trim();
  const candidates = resolveTeamCandidates(label);

  if (candidates.length === 1) {
    return country(candidates[0]);
  }

  if (candidates.length > 1) {
    return compactPossibleTeams(label);
  }

  return country(label);
}

function isKnownTeamName(name) {
  return Boolean(FLAG_POSITIONS[String(name || "")]);
}

function uniqueTeamNames(names) {
  return [...new Set((names || []).filter((name) => isKnownTeamName(name)))];
}

function groupPositionCandidate(label) {
  const match = String(label || "").match(/^(1|2|3)o Grupo ([A-L])$/i);

  if (!match) {
    return [];
  }

  const position = Number(match[1]);
  const groupId = match[2].toUpperCase();
  const standings = calculateGroupStandings()[groupId] || [];
  const hasCurrentTable = standings.some((row) => Number(row.j || 0) > 0);

  if (hasCurrentTable && standings[position - 1]) {
    return [standings[position - 1].team];
  }

  const group = DATA.groups.find((item) => item.id === groupId);
  return uniqueTeamNames(group?.teams || []);
}

function groupStageResolutionSignature() {
  return DATA.matches
    .filter((match) => groupStageRounds.includes(match.round))
    .map((match) => {
      const score = getPredictionScore(match);
      return `${match.id}:${score.home ?? ""}:${score.away ?? ""}:${match.status || ""}`;
    })
    .join("|");
}

function qualifiedThirdPlacedRows() {
  const standings = calculateGroupStandings();

  return DATA.groups
    .map((group) => {
      const rows = standings[group.id] || [];
      const groupStarted = rows.some((row) => Number(row.j || 0) > 0);
      const row = groupStarted ? rows[2] : null;
      return row ? { ...row, groupId: group.id } : null;
    })
    .filter(Boolean)
    .sort((first, second) =>
      second.pts - first.pts ||
      second.sg - first.sg ||
      second.gp - first.gp ||
      first.team.localeCompare(second.team)
    )
    .slice(0, 8);
}

function bestThirdSlotAssignments() {
  const signature = groupStageResolutionSignature();

  if (bestThirdAssignmentCache.signature === signature) {
    return bestThirdAssignmentCache.assignments;
  }

  const assignments = new Map();
  const qualifiedRows = qualifiedThirdPlacedRows();

  if (qualifiedRows.length !== 8) {
    bestThirdAssignmentCache = { signature, assignments };
    return assignments;
  }

  const optionKey = qualifiedRows
    .map((row) => row.groupId)
    .sort((first, second) => first.localeCompare(second))
    .join("");
  const officialOption = FIFA_ACTIVE_THIRD_PLACE_OPTIONS[optionKey];

  if (!officialOption) {
    bestThirdAssignmentCache = { signature, assignments };
    return assignments;
  }

  const standings = calculateGroupStandings();

  DATA.matches
    .filter((match) => match.round === "Rodada 4")
    .forEach((match) => {
      const groupId = officialOption[Number(match.number)];
      if (!groupId) return;

      const label = [match.team1, match.team2].find((value) =>
        /^3o melhor [A-L](?:\/[A-L])+$/i.test(String(value || ""))
      );
      const team = standings[groupId]?.[2]?.team;

      if (label && isKnownTeamName(team)) {
        assignments.set(String(label), team);
      }
    });

  bestThirdAssignmentCache = { signature, assignments };
  return assignments;
}

function bestThirdCandidates(label) {
  const match = String(label || "").match(/^3o melhor ([A-L](?:\/[A-L])+)$/i);

  if (!match) {
    return [];
  }

  const assignedTeam = bestThirdSlotAssignments().get(String(label));
  if (assignedTeam) {
    return [assignedTeam];
  }

  const standings = calculateGroupStandings();
  return uniqueTeamNames(
    match[1].split("/").map((groupId) => standings[groupId.toUpperCase()]?.[2]?.team)
  );
}

function knockoutOutcomeTeam(sourceMatch, outcomeType) {
  if (!sourceMatch || !isFinishedStatus(sourceMatch)) {
    return "";
  }

  const score = getPredictionScore(sourceMatch);

  if (score.home === null || score.away === null) {
    return "";
  }

  let homeWon = score.home > score.away;
  let awayWon = score.away > score.home;

  if (!homeWon && !awayWon) {
    const homePenalties = numericMatchValue(sourceMatch, ["penaltyScore1", "penalties1", "shootoutScore1"]);
    const awayPenalties = numericMatchValue(sourceMatch, ["penaltyScore2", "penalties2", "shootoutScore2"]);

    if (homePenalties !== null && awayPenalties !== null) {
      homeWon = homePenalties > awayPenalties;
      awayWon = awayPenalties > homePenalties;
    }
  }

  if (!homeWon && !awayWon) {
    return "";
  }

  const homeTeam = resolvedTeamName(sourceMatch.team1);
  const awayTeam = resolvedTeamName(sourceMatch.team2);

  if (outcomeType === "winner") {
    return homeWon ? homeTeam : awayTeam;
  }

  return homeWon ? awayTeam : homeTeam;
}

function resolveTeamCandidates(label, visited = new Set()) {
  const value = String(label || "").trim();

  if (!value || visited.has(value)) {
    return [];
  }

  if (isKnownTeamName(value)) {
    return [value];
  }

  const groupCandidates = groupPositionCandidate(value);
  if (groupCandidates.length) {
    return groupCandidates;
  }

  const thirdCandidates = bestThirdCandidates(value);
  if (thirdCandidates.length) {
    return thirdCandidates;
  }

  const sourceReference = value.match(/^(Vencedor|Perdedor) Jogo (\d+)$/i);

  if (!sourceReference) {
    return [];
  }

  visited.add(value);
  const sourceMatch = DATA.matches.find((match) => Number(match.number) === Number(sourceReference[2]));
  const outcomeType = sourceReference[1].toLowerCase().startsWith("v") ? "winner" : "loser";
  const resolvedOutcome = knockoutOutcomeTeam(sourceMatch, outcomeType);

  if (isKnownTeamName(resolvedOutcome)) {
    return [resolvedOutcome];
  }

  return uniqueTeamNames([
    ...resolveTeamCandidates(sourceMatch?.team1, new Set(visited)),
    ...resolveTeamCandidates(sourceMatch?.team2, new Set(visited))
  ]);
}

function compactPossibleTeams(label) {
  const candidates = resolveTeamCandidates(label);

  if (isKnownTeamName(label)) {
    return compactCountry(label);
  }

  if (candidates.length === 1) {
    return compactCountry(candidates[0]);
  }

  if (!candidates.length) {
    return `<span class="possible-flags"><span class="flag-fallback" aria-label="Adversário a definir">?</span></span>`;
  }

  return `
    <span class="possible-flags" aria-label="Possíveis adversários">
      ${candidates.map((team, index) => `
        ${index ? `<span class="possible-separator">ou</span>` : ""}
        ${flagMarkup(team)}
      `).join("")}
    </span>
  `;
}

function compactGameCard(match) {
  const delayedLabel = isDelayedScheduledMatch(match)
    ? `<span class="compact-game-delay">Atrasado</span>`
    : "";

  return `
    <div class="compact-game" data-match-id="${escapeHtml(match.id)}">
      <div class="compact-game-main">
        <span>${compactPossibleTeams(match.team1)}</span>
        <strong>x</strong>
        <span>${compactPossibleTeams(match.team2)}</span>
      </div>
      <div class="compact-game-meta">
        <span>${formatMatchDate(match)} · ${formatMatchTime(match)} ${delayedLabel}</span>
        <span>${compactVenue(match.venue)}</span>
      </div>
    </div>
  `;
}


function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getDefaultCompetitionStage() {
  return isRoundLocked("Rodada 3") ? "knockout" : "groups";
}

function getPicksStage() {
  if (state.picksStage !== "groups" && state.picksStage !== "knockout") {
    state.picksStage = getDefaultCompetitionStage();
  }

  return state.picksStage;
}

function getOfficialStage() {
  if (state.officialStage !== "groups" && state.officialStage !== "knockout") {
    state.officialStage = getDefaultCompetitionStage();
  }

  return state.officialStage;
}

function renderCompetitionStageSwitch(context, stage) {
  const dataAttribute = context === "official" ? "data-official-stage" : "data-picks-stage";
  const ariaLabel = context === "official" ? "Fase da tabela oficial" : "Fase dos palpites";

  return `
    <section class="picks-stage-switch" role="group" aria-label="${ariaLabel}">
      <button type="button" class="picks-stage-button ${stage === "groups" ? "active" : ""}" ${dataAttribute}="groups">Grupos</button>
      <button type="button" class="picks-stage-button ${stage === "knockout" ? "active" : ""}" ${dataAttribute}="knockout">Mata-mata</button>
    </section>
  `;
}

function renderOfficial() {
  const stage = getOfficialStage();

  app.innerHTML = `
    <div class="stack">
      ${renderCompetitionStageSwitch("official", stage)}
      ${stage === "knockout" ? renderKnockoutBracket("official") : renderGroupsSection()}
      ${renderSponsorBlock(true)}
    </div>
  `;
  bindEvents();
}

function getPicksStageRounds() {
  return getPicksStage() === "knockout" ? knockoutRounds : groupStageRounds;
}

function getAutomaticPicksRound(allowedRounds) {
  if (!Array.isArray(allowedRounds) || !allowedRounds.length) return "";
  return allowedRounds.find((round) => !isRoundLocked(round)) || allowedRounds[allowedRounds.length - 1];
}

function normalizePicksRoundSelection() {
  const allowedRounds = getPicksStageRounds();
  const automaticRound = getAutomaticPicksRound(allowedRounds);

  if (!allowedRounds.includes(state.betRound) || !state.betRoundManuallySelected) {
    state.betRound = automaticRound;
    localStorage.setItem("bolao-bet-round", state.betRound);
  }

  if (!allowedRounds.includes(state.picksRound) || !state.picksRoundManuallySelected) {
    state.picksRound = automaticRound;
    localStorage.setItem("bolao-picks-round", state.picksRound);
  }
}

function bracketTeamDisplay(match, side) {
  const key = side === "away" ? "team2" : "team1";
  const label = String(match?.[key] || "").trim();
  const candidates = resolveTeamCandidates(label);

  if (candidates.length === 1) {
    return compactCountry(candidates[0]);
  }

  return `<span class="bracket-team-pending">A definir</span>`;
}

function formatBracketDate(value) {
  const [, month, day] = String(value || "").split("-");
  return day && month ? `${day}/${month}` : "";
}

function bracketTeamValue(match, side) {
  const score = getPredictionScore(match);
  return side === "away" ? score.away : score.home;
}

function bracketPickInput(match, side, locked) {
  const playerId = state.selectedPlayer;
  const savedPick = state.picks[playerId]?.[match.id] || null;
  const draftPick = getDraftPick(playerId, match.round, match.id);
  const pick = draftPick || savedPick || {};
  const dataSide = side === "away" ? "g2" : "g1";
  const value = dataSide === "g2" ? pick.g2 : pick.g1;

  return `
    <input
      class="bracket-pick-input"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      maxlength="2"
      autocomplete="off"
      data-match="${match.id}"
      data-side="${dataSide}"
      aria-label="Palpite para ${escapeHtml(matchTeamName(match, side))}"
      value="${value ?? ""}"
      ${locked ? "disabled" : ""}
    >
  `;
}

function bracketTeamPrefix(match, side, context, selectedRound) {
  if (context === "picks" && selectedRound === match.round) {
    return bracketPickInput(match, side, isRoundLocked(match.round));
  }

  const value = bracketTeamValue(match, side);

  if (!isFinishedStatus(match) || value === null) {
    return "";
  }

  return `<strong class="bracket-team-score">${value}</strong>`;
}

function renderBracketTeamRow(match, side, context, selectedRound) {
  return `
    <div class="bracket-team-row">
      <span class="bracket-team-entry">
        ${bracketTeamPrefix(match, side, context, selectedRound)}
        <span class="bracket-team-name">${bracketTeamDisplay(match, side)}</span>
      </span>
    </div>
  `;
}

function renderBracketMatch(matchNumber, context, selectedRound) {
  const match = DATA.matches.find((item) => Number(item.number) === Number(matchNumber));

  if (!match) return "";

  const selected = selectedRound === match.round;
  const interaction = context === "picks" && !selected
    ? `data-knockout-round="${match.round}" role="button" tabindex="0" aria-label="Selecionar ${escapeHtml(displayRound(match.round))}"`
    : "";

  return `
    <div class="bracket-match ${selected ? "selected-phase" : ""} ${isFinishedStatus(match) ? "finished" : ""}" ${interaction}>
      <div class="bracket-match-meta">
        <span>J${String(match.number).padStart(3, "0")}</span>
        <span>${formatBracketDate(matchDisplayDate(match))} · ${formatMatchTime(match)}</span>
      </div>
      ${renderBracketTeamRow(match, "home", context, selectedRound)}
      ${renderBracketTeamRow(match, "away", context, selectedRound)}
    </div>
  `;
}

function renderBracketSlot(matchNumber, context, selectedRound, options) {
  const { column, row, span = 1, side, source = false, centerLink = false } = options;
  const classes = [
    "bracket-slot",
    `bracket-slot-${side}`,
    source ? `bracket-source-${side}` : `bracket-merge-${side}`,
    centerLink ? `bracket-center-link-${side}` : ""
  ].filter(Boolean).join(" ");

  return `
    <div class="${classes}" style="grid-column:${column};grid-row:${row} / span ${span};">
      ${renderBracketMatch(matchNumber, context, selectedRound)}
    </div>
  `;
}

function renderBracketSide(side, context, selectedRound) {
  const isLeft = side === "left";
  const round32 = isLeft
    ? [74, 77, 73, 75, 83, 84, 81, 82]
    : [76, 78, 79, 80, 86, 88, 85, 87];
  const round16 = isLeft ? [89, 90, 93, 94] : [91, 92, 95, 96];
  const quarterfinals = isLeft ? [97, 98] : [99, 100];
  const semifinal = isLeft ? 101 : 102;
  const outerColumn = isLeft ? 1 : 4;
  const round16Column = isLeft ? 2 : 3;
  const quarterColumn = isLeft ? 3 : 2;
  const semifinalColumn = isLeft ? 4 : 1;

  return `
    <div class="bracket-side bracket-side-${side}">
      <div class="bracket-side-labels bracket-side-labels-${side}">
        ${isLeft
          ? `<span>16 avos</span><span>Oitavas</span><span>Quartas</span><span>Semifinal</span>`
          : `<span>Semifinal</span><span>Quartas</span><span>Oitavas</span><span>16 avos</span>`
        }
      </div>
      <div class="bracket-grid bracket-grid-${side}">
        ${round32.map((number, index) => renderBracketSlot(number, context, selectedRound, {
          column: outerColumn,
          row: index + 1,
          side,
          source: true
        })).join("")}
        ${round16.map((number, index) => renderBracketSlot(number, context, selectedRound, {
          column: round16Column,
          row: index * 2 + 1,
          span: 2,
          side
        })).join("")}
        ${quarterfinals.map((number, index) => renderBracketSlot(number, context, selectedRound, {
          column: quarterColumn,
          row: index * 4 + 1,
          span: 4,
          side
        })).join("")}
        ${renderBracketSlot(semifinal, context, selectedRound, {
          column: semifinalColumn,
          row: 1,
          span: 8,
          side,
          centerLink: true
        })}
      </div>
    </div>
  `;
}

function renderKnockoutBracket(context = "official", embedded = false) {
  const selectedRound = context === "picks" ? state.betRound : "";
  const bracketContent = `
    <div class="title-row knockout-bracket-title-row">
      <h2>🏆 Chaveamento do mata-mata</h2>
      <span class="kicker">Caminho até a final</span>
    </div>
    <div class="knockout-bracket-scroll">
      <div class="tournament-bracket">
        ${renderBracketSide("left", context, selectedRound)}
        <div class="bracket-center-column">
          <span class="bracket-center-label">Final</span>
          ${renderBracketMatch(104, context, selectedRound)}
          <span class="bracket-center-label bracket-third-label">3º lugar</span>
          ${renderBracketMatch(103, context, selectedRound)}
        </div>
        ${renderBracketSide("right", context, selectedRound)}
      </div>
    </div>
  `;

  if (embedded) {
    return `<div class="knockout-bracket-embedded">${bracketContent}</div>`;
  }

  return `<section class="card knockout-bracket-card">${bracketContent}</section>`;
}

function renderPicksArea() {
  normalizePicksRoundSelection();
  lastBetRoundLocked = isRoundLocked(state.betRound);
  const stage = getPicksStage();

  app.innerHTML = `
    <div class="stack">
      ${renderCompetitionStageSwitch("picks", stage)}
      ${renderNextRoundDeadlineSection()}
      ${renderBetSection()}
      ${renderPicksSection()}
      ${renderSponsorBlock(true)}
    </div>
  `;
  bindEvents();
  scheduleDeadlineRefresh();
}

function renderSponsorBlock(compact = false) {
  return `
    <a
      class="card sponsor-card sponsor-card-link ${compact ? "compact" : ""}"
      href="https://www.iaprocontato.com.br/"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Abrir site da IA Pro Contato"
    >
      <div class="sponsor-wrap">
        <div class="sponsor-logo"><img src="logo-ia-pro-contato.webp?v=20260626-logo-v7" alt="IA Pro Contato" width="768" height="256" loading="lazy" decoding="async"></div>
        <div class="sponsor-text">
          <div class="sponsor-label">Patrocínio</div>
          <div class="sponsor-name">IA Pro Contato</div>
          <div class="sponsor-copy">Atendimento automatizado e ERP</div>
        </div>
      </div>
    </a>
  `;
}

function renderGroupsSection() {
  const standings = calculateGroupStandings();
  const qualifyingTeams = calculateCurrentGroupQualifiers(standings);

  return `
    <section>
      <div class="title-row">
        <h2>🌎 Grupos</h2>
        <span class="kicker">Tabela + jogos</span>
      </div>
      <div class="group-grid">
        ${DATA.groups.map((group) => groupCard(group, standings[group.id] || [], qualifyingTeams)).join("")}
      </div>
    </section>
  `;
}

function calculateCurrentGroupQualifiers(standings) {
  const startedGroups = new Set();

  DATA.matches.forEach((match) => {
    const score = getPredictionScore(match);
    if (
      groupStageRounds.includes(match.round) &&
      !isFutureScheduledMatch(match) &&
      score.home !== null &&
      score.away !== null
    ) {
      startedGroups.add(String(match.group || "").replace("Grupo ", ""));
    }
  });

  const directQualifiers = new Set();
  const thirdPlaced = [];

  startedGroups.forEach((groupId) => {
    const rows = standings[groupId] || [];
    rows.slice(0, 2).forEach((row) => directQualifiers.add(row.team));

    if (rows[2]) {
      thirdPlaced.push({
        ...rows[2],
        groupId
      });
    }
  });

  thirdPlaced.sort((first, second) =>
    second.pts - first.pts ||
    second.sg - first.sg ||
    second.gp - first.gp ||
    first.team.localeCompare(second.team)
  );

  const bestThirdQualifiers = new Set(
    thirdPlaced.slice(0, 8).map((row) => row.team)
  );

  return new Set([...directQualifiers, ...bestThirdQualifiers]);
}

function groupCard(group, rows, qualifyingTeams) {
  const matches = DATA.matches.filter((match) => match.group === group.name && groupStageRounds.includes(match.round));

  return `
    <div class="card group-card">
      <div class="group-head">
        <h3>${group.name}</h3>
      </div>

      <div class="table-wrap group-table">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th class="center">Pts</th>
              <th class="center">V</th>
              <th class="center">E</th>
              <th class="center">D</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, index) => `
              <tr class="${qualifyingTeams.has(row.team) ? "group-qualified-row" : ""}">
                <td>${index + 1}</td>
                <td>${country(row.team)}</td>
                <td class="center strong">${row.pts}</td>
                <td class="center">${row.v}</td>
                <td class="center">${row.e}</td>
                <td class="center">${row.d}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div class="group-games">
        ${matches.map(groupGameCard).join("")}
      </div>
    </div>
  `;
}

function groupGameCard(match) {
  return `
    <div class="game-card">
      <div class="game-top">
        <span>${displayRound(match.round)} · Jogo ${match.number}</span>
        <span>${formatMatchDate(match)} · ${formatMatchTime(match)}</span>
      </div>
      ${matchLine(match)}
    </div>
  `;
}

function liveMatchDetails(match) {
  const events = liveMatchEvents(match);
  const eventBlock = events.length
    ? `
      <div class="live-match-events-block">
        <div class="finished-events-title">Gols</div>
        <div class="live-event-list">
          ${events.map((event) => liveEventRow(event, match)).join('')}
        </div>
      </div>
    `
    : '';

  return `${eventBlock}${liveMatchStatistics(match)}`;
}

function liveMatchEvents(match) {
  return goalOnlyEvents(match && match.events)
    .filter((event) => eventBelongsToMatch(event, match))
    .map((event) => {
      const side = event.side === "away" || event.side === "home"
        ? event.side
        : eventTeamSide(event.team, match);

      return Object.assign({}, event, {
        kind: "goal",
        side,
        team: event.team || (side === "away" ? match.team2 : match.team1),
        icon: "⚽",
        label: event.label || event.type || ""
      });
    })
    .sort((first, second) => {
      return goalMinuteSortValue(first.minute) - goalMinuteSortValue(second.minute) ||
        Number(first.sequence || 0) - Number(second.sequence || 0);
    });
}

function eventBelongsToMatch(event, match) {
  if (!event || !match) return false;

  const eventMatchId = String(event.matchId || "").trim();
  if (eventMatchId && eventMatchId !== String(match.id || "")) {
    return false;
  }

  const eventHome = normalizeEventTeamName(event.homeTeam);
  const eventAway = normalizeEventTeamName(event.awayTeam);

  if (eventHome && eventAway) {
    const homeAliases = eventTeamAliases(match.team1);
    const awayAliases = eventTeamAliases(match.team2);
    const homeMatches = homeAliases.some((alias) => eventHome === alias || eventHome.includes(alias) || alias.includes(eventHome));
    const awayMatches = awayAliases.some((alias) => eventAway === alias || eventAway.includes(alias) || alias.includes(eventAway));
    if (!homeMatches || !awayMatches) return false;
  }

  return true;
}

function inferEventKind(event) {
  const type = String(event && event.type || "").toLowerCase();
  const card = String(event && event.card || "").toUpperCase();

  if (card || type.includes("cartão") || type.includes("card")) return "card";
  if (type.includes("substit")) return "substitution";
  if (type.includes("pênalti") || type.includes("penalty")) return "penalty";
  if (type.includes("var")) return "var";
  return "goal";
}

function eventIcon(kind, card) {
  if (kind === "goal") return "⚽";
  if (kind === "substitution") return "🔄";
  if (kind === "penalty") return "❌";
  if (kind === "var") return "📺";
  if (String(card || "").toUpperCase() === "YELLOW") return "🟨";
  return "🟥";
}

function liveMatchStatistics(match) {
  const statistics = match && match.statistics && typeof match.statistics === "object"
    ? match.statistics
    : {};
  const home = statistics.home || {};
  const away = statistics.away || {};
  const rows = [
    ["Posse de bola", home.possession, away.possession, "%"],
    ["Finalizações", home.shots, away.shots, ""],
    ["No gol", home.shotsOnTarget, away.shotsOnTarget, ""],
    ["Escanteios", home.corners, away.corners, ""],
    ["Faltas", home.fouls, away.fouls, ""]
  ].filter((row) => row[1] !== undefined && row[1] !== "" && row[2] !== undefined && row[2] !== "");

  if (!rows.length) {
    return "";
  }

  return `
    <div class="live-match-stats">
      <div class="live-match-stats-title">Estatísticas</div>
      ${rows.map(([label, homeValue, awayValue, suffix]) => `
        <div class="live-match-stat-row">
          <strong>${escapeHtml(String(homeValue))}${suffix}</strong>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(awayValue))}${suffix}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function liveEventRow(event, match) {
  const side = event.side === 'away' || event.side === 'home'
    ? event.side
    : eventTeamSide(event.team, match);
  const minute = event.minute
    ? `${escapeHtml(String(event.minute))}'`
    : "";
  const kind = String(event.kind || inferEventKind(event)).toLowerCase();
  const icon = event.icon || eventIcon(kind, event.card);
  let content = "";

  if (kind === "substitution") {
    content = `
      <div class="live-event-person">
        <strong>${icon} ${escapeHtml(event.playerIn || event.player || "Substituição")}</strong>
        ${event.playerOut ? `<small>Saiu: ${escapeHtml(event.playerOut)}</small>` : ""}
      </div>
    `;
  } else {
    const ownGoal = String(event.goalType || "") === "own_goal"
      ? " (GC)"
      : "";
    const penalty = String(event.goalType || "") === "penalty"
      ? " (P)"
      : "";
    const mainLabel = event.player || event.label || event.type || "Evento";
    const detail = event.assist
      ? `Assistência: ${event.assist}`
      : kind === "card" || kind === "var"
        ? event.label || event.type || ""
        : "";

    content = `
      <div class="live-event-person">
        <strong>${icon} ${escapeHtml(mainLabel)}${ownGoal}${penalty}</strong>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </div>
    `;
  }

  return `
    <div class="live-event-row live-event-${side}">
      <div class="live-event-home">${side === "home" ? content : ""}</div>
      <span class="live-event-minute">${minute}</span>
      <div class="live-event-away">${side === "away" ? content : ""}</div>
    </div>
  `;
}

function eventTeamSide(team, match) {
  const eventName = normalizeEventTeamName(team);

  if (!eventName) {
    return 'home';
  }

  const homeAliases = eventTeamAliases(match.team1);
  const awayAliases = eventTeamAliases(match.team2);

  if (
    awayAliases.some((alias) => {
      return eventName === alias ||
        eventName.includes(alias) ||
        alias.includes(eventName);
    })
  ) {
    return 'away';
  }

  if (
    homeAliases.some((alias) => {
      return eventName === alias ||
        eventName.includes(alias) ||
        alias.includes(eventName);
    })
  ) {
    return 'home';
  }

  return 'home';
}

function eventTeamAliases(team) {
  const extras = {
    "Bósnia": ["bosnia", "bosniaeherzegovina", "bosniaandherzegovina"],
    "República Tcheca": ["republicatcheca", "tchequia", "czechia", "czechrepublic"],
    "Coreia do Sul": ["coreiadosul", "southkorea", "korearepublic"],
    "África do Sul": ["africadosul", "southafrica"],
    "Estados Unidos": ["estadosunidos", "usa", "unitedstates"],
    "Costa do Marfim": ["costadomarfim", "ivorycoast", "cotedivoire"],
    "RD Congo": ["rdcongo", "congodr", "democraticrepublicofthecongo"]
  };

  return [team]
    .concat(extras[team] || [])
    .map(normalizeEventTeamName)
    .filter(Boolean);
}

function normalizeEventTeamName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function goalMinuteSortValue(value) {
  const raw = cleanGoalMinute(value);
  const match = raw.match(/^(\d{1,3})(?:\+(\d{1,2}))?$/);

  if (!match) {
    return 999;
  }

  return Number(match[1]) +
    Number(match[2] || 0) / 100;
}

function normalizeGoalList(value, team) {
  if (!value) return [];

  let list = value;

  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (_) {
      list = parseGoalArrayText(list);
    }
  }

  if (!Array.isArray(list)) {
    list = [list];
  }

  return list.map((item) => {
    if (typeof item === "string") {
      return parseGoalText(item, team);
    }

    if (!item || typeof item !== "object") {
      return null;
    }

    const keys = Object.keys(item);
    const fallbackKey = keys.length === 1 ? keys[0] : "";
    const rawPlayer = item.player ||
      item.name ||
      item.scorer ||
      fallbackKey ||
      "";
    const parsed = parseGoalText(
      rawPlayer,
      item.team || team || ""
    );
    let explicitMinute = cleanGoalMinute(
      item.minute ||
      item.time ||
      item.elapsed ||
      ""
    );
    const explicitInjuryTime = cleanGoalMinute(item.injuryTime || "");

    if (
      explicitMinute &&
      explicitInjuryTime &&
      !String(explicitMinute).includes("+")
    ) {
      explicitMinute = `${explicitMinute}+${explicitInjuryTime}`;
    }

    return {
      kind: item.kind || "",
      label: item.label || "",
      icon: item.icon || "",
      type: item.type || "Gol",
      goalType: item.goalType ||
        item.goal_type ||
        parsed && parsed.goalType ||
        "",
      player: parsed
        ? parsed.player
        : cleanGoalPlayer(rawPlayer),
      playerIn: item.playerIn || "",
      playerOut: item.playerOut || "",
      assist: item.assist || item.assistant || "",
      minute: explicitMinute ||
        parsed && parsed.minute ||
        "",
      injuryTime: item.injuryTime || "",
      team: item.team ||
        parsed && parsed.team ||
        team ||
        "",
      side: item.side || "",
      sequence: item.sequence || item.id || "",
      synthetic: Boolean(item.synthetic),
      score: item.score || {},
      card: item.card || "",
      matchId: item.matchId || item.match || item.gameId || item.eventMatchId || "",
      homeTeam: item.homeTeam || item.team1 || "",
      awayTeam: item.awayTeam || item.team2 || ""
    };
  }).filter((item) => {
    return item && (
      item.player ||
      item.playerIn ||
      item.playerOut ||
      item.minute
    );
  });
}

function parseGoalArrayText(value) {
  const text = String(value || "").trim();

  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1);
    const items = [];
    const regex = /"((?:\\.|[^"\\])*)"/g;
    let match;

    while ((match = regex.exec(inner)) !== null) {
      items.push(
        match[1]
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      );
    }

    if (items.length) {
      return items;
    }
  }

  return text
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanGoalPlayer(value) {
  let text = String(value || "")
    .replace(/\\"/g, '"')
    .trim();

  for (let index = 0; index < 5; index++) {
    const previous = text;

    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      text = text.slice(1, -1).trim();
    }

    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      text = text.slice(1, -1).trim();
    }

    if (text === previous) {
      break;
    }
  }

  return text
    .replace(/^[{[\s"']+/, "")
    .replace(/[}\]\s"']+$/, "")
    .replace(/^gol\s+(?:de|do|da)\s+/i, "")
    .trim();
}

function cleanGoalMinute(value) {
  const raw = String(value || "").trim();

  const added = raw.match(
    /(\d{1,3})\s*['’]?\s*\+\s*(\d{1,2})/
  );

  if (added) {
    return `${Number(added[1])}+${Number(added[2])}`;
  }

  const normal = raw.match(/\d{1,3}/);
  return normal ? String(Number(normal[0])) : "";
}

function parseGoalText(text, team) {
  let raw = cleanGoalPlayer(text);

  if (
    !raw ||
    raw.toLowerCase() === "null"
  ) {
    return null;
  }

  let goalType = "";

  if (
    /\((?:og|gc|own\s*goal|gol\s*contra)\)\s*$/i.test(raw) ||
    /\b(?:og|gc)\s*$/i.test(raw)
  ) {
    goalType = "own_goal";
    raw = raw
      .replace(/\s*\((?:og|gc|own\s*goal|gol\s*contra)\)\s*$/i, "")
      .replace(/\s+\b(?:og|gc)\s*$/i, "")
      .trim();
  }

  const match = raw.match(
    /^(.*?)\s+(\d{1,3})\s*['’]?\s*(?:\+\s*(\d{1,2})\s*['’]?)?\s*$/
  );

  if (match && match[1].trim()) {
    return {
      player: cleanGoalPlayer(match[1]),
      minute: match[3]
        ? `${Number(match[2])}+${Number(match[3])}`
        : String(Number(match[2])),
      team,
      goalType
    };
  }

  return {
    player: cleanGoalPlayer(raw),
    minute: "",
    team,
    goalType
  };
}

function matchLine(match) {
  return `
    <div class="match-line">
      <div class="match-left">${matchTeamDisplay(match, "home")}</div>
      <div class="match-score">${matchResultInline(match)}</div>
      <div class="match-right">${matchTeamDisplay(match, "away")}</div>
    </div>
  `;
}

function renderBetSection() {
  const allowedRounds = getPicksStageRounds();
  const round = allowedRounds.includes(state.betRound) ? state.betRound : allowedRounds[0];
  const playerId = state.selectedPlayer;
  const locked = isRoundLocked(round);
  const saving = Boolean(state.saveInFlight);
  const matches = DATA.matches.filter((m) => m.round === round);

  return `
    <section class="card">
      <div class="title-row">
        <h2>✍️ Enviar palpites</h2>
        <span class="kicker">Pode editar até fechar</span>
      </div>

      <div class="toolbar">
        <div class="field">
          <label>Jogador</label>
          <select id="playerSelect">
            <option value="">Selecione</option>
            ${DATA.players.map((p) => `<option value="${p.id}" ${p.id === playerId ? "selected" : ""}>${p.name}</option>`).join("")}
          </select>
        </div>

        <div class="field">
          <label>Senha/código</label>
          <input id="playerCodeInput" type="password" value="${state.playerCode}" autocomplete="off" placeholder="Código do jogador">
        </div>

        <div class="field">
          <label>${getPicksStage() === "knockout" ? "Fase" : "Rodada"}</label>
          <select id="betRoundSelect">
            ${allowedRounds.map((r) => `<option value="${r}" ${r === round ? "selected" : ""}>${displayRound(r)}</option>`).join("")}
          </select>
        </div>

        <button class="btn" id="savePicks" ${locked || saving ? "disabled" : ""}>${saving ? "Salvando..." : "Salvar"}</button>
      </div>

      ${locked
        ? `<div class="notice danger">🔒 ${displayRound(round)} fechada. Prazo: ${formatDateTime(roundDeadline(round))}.</div>`
        : `<div class="notice">⏰ ${displayRound(round)} fecha em ${formatDateTime(roundDeadline(round))}. As alterações ficam protegidas neste aparelho até o salvamento ser concluído.</div>`
      }

      ${getPicksStage() === "knockout"
        ? renderKnockoutBracket("picks", true)
        : `<div class="bet-list">
            ${matches.map((m) => betRow(m, playerId, locked)).join("")}
          </div>`
      }
    </section>
  `;
}

function betRow(match, playerId, locked) {
  const savedPick = state.picks[playerId]?.[match.id] || null;
  const draftPick = getDraftPick(playerId, match.round, match.id);
  const pick = draftPick || savedPick || {};

  return `
    <div class="bet-row">
      <div class="bet-meta">
        <span>${match.group} · Jogo ${match.number}</span>
        <span>${formatMatchDate(match)} · ${formatMatchTime(match)}</span>
      </div>

      <div class="bet-line">
        <span class="team">${matchTeamDisplay(match, "home")}</span>
        <input
          type="number"
          min="0"
          max="99"
          step="1"
          inputmode="numeric"
          autocomplete="off"
          data-match="${match.id}"
          data-side="g1"
          aria-label="Palpite para ${escapeHtml(matchTeamName(match, "home"))}"
          value="${pick.g1 ?? ""}"
          ${locked ? "disabled" : ""}
        >
        <span class="x">X</span>
        <input
          type="number"
          min="0"
          max="99"
          step="1"
          inputmode="numeric"
          autocomplete="off"
          data-match="${match.id}"
          data-side="g2"
          aria-label="Palpite para ${escapeHtml(matchTeamName(match, "away"))}"
          value="${pick.g2 ?? ""}"
          ${locked ? "disabled" : ""}
        >
        <span class="team">${matchTeamDisplay(match, "away")}</span>
      </div>
    </div>
  `;
}

function renderPicksSection() {
  const allowedRounds = getPicksStageRounds();
  const round = allowedRounds.includes(state.picksRound) ? state.picksRound : allowedRounds[0];
  const matches = DATA.matches.filter((match) => match.round === round);
  const roundClosed = isRoundLocked(round);

  return `
    <section class="card">
      <div class="title-row">
        <h2>👀 Palpites enviados</h2>
        <span class="kicker">Por fase/rodada</span>
      </div>

      <div class="toolbar picks-round-toolbar">
        <div class="field">
          <label>Rodada/fase</label>
          <select id="picksRoundSelect">
            ${allowedRounds.map((item) => `<option value="${item}" ${item === round ? "selected" : ""}>${displayRound(item)}</option>`).join("")}
          </select>
        </div>
      </div>

      ${roundClosed
        ? `<div class="picks-list">
            ${matches.map((match) => `
              <div class="pick-card">
                <div class="pick-top">
                  <span>${match.group} · Jogo ${match.number}</span>
                  <span>${formatMatchDate(match)} · ${formatMatchTime(match)}</span>
                </div>
                ${matchLine(match)}
                <div class="player-picks">
                  ${DATA.players.map((player) => {
                    const pick = state.picks[player.id]?.[match.id];
                    return `
                      <div class="player-pick ${playerPickClass(pick, match)}">
                        <span class="player-pick-name">${player.name}</span>
                        <span class="player-pick-score">${formatPick(pick)}</span>
                        <span class="player-pick-date">${formatPickLastSaved(pick)}</span>
                        ${playerPickResultBadge(pick, match)}
                      </div>
                    `;
                  }).join("")}
                </div>
              </div>
            `).join("")}
          </div>`
        : `<div class="notice picks-locked-notice">🔒 Os palpites desta rodada serão exibidos somente após o fechamento.</div>`
      }
    </section>
  `;
}

function bindEvents() {
  const playerSelect = $("#playerSelect");
  const playerCodeInput = $("#playerCodeInput");
  const betRoundSelect = $("#betRoundSelect");
  const picksRoundSelect = $("#picksRoundSelect");

  if (playerSelect) {
    playerSelect.addEventListener("change", (event) => {
      persistFocusedBetDraft();
      state.selectedPlayer = event.target.value;
      localStorage.setItem("bolao-player", state.selectedPlayer);
      render();
    });
  }

  if (playerCodeInput) {
    playerCodeInput.addEventListener("input", (event) => {
      state.playerCode = event.target.value.trim();
      localStorage.setItem("bolao-player-code", state.playerCode);
    });
  }

  if (betRoundSelect) {
    betRoundSelect.addEventListener("change", (event) => {
      persistFocusedBetDraft();
      state.betRound = event.target.value;
      state.betRoundManuallySelected = true;
      localStorage.setItem("bolao-bet-round", state.betRound);
      render();
    });
  }

  if (picksRoundSelect) {
    picksRoundSelect.addEventListener("change", (event) => {
      state.picksRound = event.target.value;
      state.picksRoundManuallySelected = true;
      localStorage.setItem("bolao-picks-round", state.picksRound);
      render();
    });
  }

  document.querySelectorAll("[data-picks-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      persistFocusedBetDraft();
      state.picksStage = button.dataset.picksStage;
      state.betRoundManuallySelected = false;
      state.picksRoundManuallySelected = false;
      normalizePicksRoundSelection();
      renderPicksArea();
    });
  });

  document.querySelectorAll("[data-official-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      state.officialStage = button.dataset.officialStage;
      renderOfficial();
    });
  });

  const selectKnockoutRound = (element) => {
    const round = element.dataset.knockoutRound;
    if (!knockoutRounds.includes(round)) return;
    persistFocusedBetDraft();
    state.betRound = round;
    state.picksRound = round;
    state.betRoundManuallySelected = true;
    state.picksRoundManuallySelected = true;
    localStorage.setItem("bolao-bet-round", round);
    localStorage.setItem("bolao-picks-round", round);
    renderPicksArea();
  };

  document.querySelectorAll("[data-knockout-round]").forEach((element) => {
    element.addEventListener("click", () => selectKnockoutRound(element));
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectKnockoutRound(element);
    });
  });

  const scoreInputs = [...document.querySelectorAll("input[data-match][data-side]")];

  scoreInputs.forEach((input, index) => {
    const replaceCurrentValue = (value) => {
      input.value = String(value || "").replace(/\D/g, "").slice(0, 2);
      input.dataset.replaceOnNextInput = "0";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    input.addEventListener("focus", () => {
      input.dataset.replaceOnNextInput = input.value === "" ? "0" : "1";
      window.requestAnimationFrame(() => input.select());
    });

    input.addEventListener("mouseup", (event) => {
      event.preventDefault();
      input.select();
    });

    input.addEventListener("beforeinput", (event) => {
      if (input.dataset.replaceOnNextInput !== "1") return;

      if (
        event.inputType === "deleteContentBackward" ||
        event.inputType === "deleteContentForward"
      ) {
        event.preventDefault();
        replaceCurrentValue("");
        return;
      }

      const inserted = String(event.data || "").replace(/\D/g, "");

      if (event.inputType.startsWith("insert") && inserted) {
        event.preventDefault();
        replaceCurrentValue(inserted);
      }
    });

    input.addEventListener("input", () => {
      input.dataset.replaceOnNextInput = "0";
      const matchId = input.dataset.match;
      const g1 = document.querySelector(`input[data-match="${matchId}"][data-side="g1"]`)?.value ?? "";
      const g2 = document.querySelector(`input[data-match="${matchId}"][data-side="g2"]`)?.value ?? "";

      setDraftPick(state.selectedPlayer, state.betRound, matchId, g1, g2);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const nextInput = scoreInputs[index + 1];

        if (nextInput) {
          nextInput.focus();
        } else {
          $("#savePicks")?.focus();
        }
        return;
      }

      if (input.dataset.replaceOnNextInput !== "1") return;

      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        replaceCurrentValue(event.key);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        replaceCurrentValue("");
      }
    });

    input.addEventListener("blur", () => {
      input.dataset.replaceOnNextInput = "0";
      flushDeferredBackendRender();
    });
  });

  const saveButton = $("#savePicks");
  if (saveButton) {
    saveButton.addEventListener("click", () => saveRoundPicks(state.betRound));
  }
}

function setSaveButtonBusy(busy) {
  const saveButton = $("#savePicks");
  if (!saveButton) return;

  saveButton.disabled = busy || isRoundLocked(state.betRound);
  saveButton.textContent = busy ? "Salvando..." : "Salvar";
}

function normalizedPickResponseItem(pick) {
  if (!pick) return null;

  const compact = Array.isArray(pick);
  const playerId = compact ? pick[0] : (pick.playerId || pick.p);
  const matchId = compact ? pick[1] : (pick.matchId || pick.m);
  const rawG1 = compact ? pick[2] : (pick.g1 ?? pick.goals1 ?? pick.a);
  const rawG2 = compact ? pick[3] : (pick.g2 ?? pick.goals2 ?? pick.b);
  const g1 = Number(rawG1);
  const g2 = Number(rawG2);

  if (!playerId || !matchId || !Number.isInteger(g1) || !Number.isInteger(g2)) {
    return null;
  }

  return {
    playerId: String(playerId),
    matchId: String(matchId),
    g1,
    g2,
    submittedAt: compact ? pick[4] : (pick.submittedAt || pick.createdAt || ""),
    updatedAt: compact ? pick[5] : (pick.updatedAt || "")
  };
}

function validateSavedRoundResponse(response, playerId, round, expectedPicks) {
  const confirmed = Array.isArray(response?.picks)
    ? response.picks.map(normalizedPickResponseItem).filter(Boolean)
    : [];
  const expectedByMatch = new Map(expectedPicks.map((pick) => [pick.matchId, pick]));
  const confirmedByMatch = new Map();

  confirmed.forEach((pick) => {
    if (pick.playerId !== playerId || !expectedByMatch.has(pick.matchId)) return;

    if (confirmedByMatch.has(pick.matchId)) {
      throw new Error(`O Google Sheets retornou o jogo ${pick.matchId} duplicado.`);
    }

    confirmedByMatch.set(pick.matchId, pick);
  });

  const missing = [];
  const divergent = [];

  expectedPicks.forEach((expected) => {
    const saved = confirmedByMatch.get(expected.matchId);

    if (!saved) {
      missing.push(expected.matchId);
      return;
    }

    if (saved.g1 !== expected.g1 || saved.g2 !== expected.g2) {
      divergent.push(`${expected.matchId} (${saved.g1}x${saved.g2})`);
    }
  });

  if (missing.length || divergent.length || confirmedByMatch.size !== expectedPicks.length) {
    const details = [];
    if (missing.length) details.push(`não confirmados: ${missing.join(", ")}`);
    if (divergent.length) details.push(`placares divergentes: ${divergent.join(", ")}`);

    throw new Error(
      `O Google Sheets não confirmou os ${expectedPicks.length} jogos de ${displayRound(round)}${details.length ? ` (${details.join("; ")})` : ""}.`
    );
  }

  return expectedPicks.map((expected) => confirmedByMatch.get(expected.matchId));
}

function saveRoundPicks(round) {
  if (state.saveInFlight) {
    return;
  }

  if (!state.selectedPlayer) {
    alert("Selecione o jogador antes de salvar.");
    return;
  }

  if (!state.playerCode) {
    alert("Informe a senha/código do jogador.");
    return;
  }

  if (isRoundLocked(round)) {
    alert("Rodada fechada para palpites.");
    return;
  }

  const matches = DATA.matches.filter((match) => match.round === round);
  const expectedCount = Number({
    "Rodada 1": 24,
    "Rodada 2": 24,
    "Rodada 3": 24,
    "Rodada 4": 16,
    "Rodada 5": 8,
    "Rodada 6": 4,
    "Rodada 7": 2,
    "Rodada 8": 2
  }[round] || 0);

  if (!expectedCount || matches.length !== expectedCount) {
    alert(`A configuração de ${displayRound(round)} está incompleta: encontrados ${matches.length} de ${expectedCount || "?"} jogos.`);
    return;
  }

  const inputMap = new Map();
  const duplicateInputs = [];

  document.querySelectorAll('input[data-match][data-side]').forEach((input) => {
    const matchId = String(input.dataset.match || "");
    const side = String(input.dataset.side || "");

    if (!matches.some((match) => match.id === matchId) || !["g1", "g2"].includes(side)) {
      return;
    }

    const key = `${matchId}|${side}`;
    if (inputMap.has(key)) duplicateInputs.push(key);
    inputMap.set(key, input);
  });

  if (duplicateInputs.length) {
    alert(`Foram encontrados campos duplicados nos jogos: ${duplicateInputs.join(", ")}. Atualize a página antes de salvar.`);
    return;
  }

  const newPicks = [];

  for (const match of matches) {
    const g1 = inputMap.get(`${match.id}|g1`)?.value ?? "";
    const g2 = inputMap.get(`${match.id}|g2`)?.value ?? "";

    if (g1 === "" || g2 === "") {
      alert(`Preencha o jogo ${match.id} antes de salvar.`);
      return;
    }

    const goals1 = Number(g1);
    const goals2 = Number(g2);

    if (
      !Number.isInteger(goals1) ||
      !Number.isInteger(goals2) ||
      goals1 < 0 ||
      goals2 < 0 ||
      goals1 > 99 ||
      goals2 > 99
    ) {
      alert(`Informe um placar válido para ${match.team1} x ${match.team2}.`);
      return;
    }

    newPicks.push({
      playerId: state.selectedPlayer,
      matchId: match.id,
      g1: goals1,
      g2: goals2,
      submittedAt: new Date().toISOString()
    });
  }

  if (newPicks.length !== expectedCount) {
    alert(`O envio foi bloqueado porque contém ${newPicks.length} de ${expectedCount} jogos.`);
    return;
  }

  setDraftRoundPicks(state.selectedPlayer, round, newPicks);
  mergePicks(newPicks);

  state.saveInFlight = true;
  picksWriteRevision += 1;
  setSaveButtonBusy(true);

  submitBackend({
    action: "savePicks",
    playerId: state.selectedPlayer,
    playerCode: state.playerCode,
    round,
    picks: newPicks
  }).then((response) => {
    if (!response || response.ok === false) {
      throw new Error(response?.error || "Não foi possível salvar no Google Sheets.");
    }

    validateBackendEnvironment(response);
    const confirmedPicks = validateSavedRoundResponse(
      response,
      state.selectedPlayer,
      round,
      newPicks
    );

    mergePicks(confirmedPicks);
    clearDraftRound(state.selectedPlayer, round);
    localStorage.removeItem(BASE_STATE_CACHE_KEY);
    lastBackendVisualSignature = "";
    alert(`Palpites salvos e conferidos: ${confirmedPicks.length} jogos.`);
    render();
  }).catch((error) => {
    alert(`Os palpites continuam protegidos neste aparelho, mas o salvamento não foi confirmado: ${error.message || "erro no backend"}`);
  }).finally(() => {
    state.saveInFlight = false;
    setSaveButtonBusy(false);
  });
}

function playerPickClass(pick, match) {
  if (!isLiveMatch(match) && !isFinishedStatus(match)) return "";

  const scored = scorePick(pick, match);
  if (scored.exact) return "player-pick-exact";
  if (scored.result) return "player-pick-result";
  return "";
}

function playerPickResultBadge(pick, match) {
  const live = isLiveMatch(match);
  if (!live && !isFinishedStatus(match)) return "";

  const scored = scorePick(pick, match);

  if (scored.exact) {
    return live
      ? `<span class="player-pick-hit-badge exact">Placar exato parcial</span>`
      : `<span class="player-pick-hit-badge exact">Placar exato · +${scored.points}</span>`;
  }

  if (scored.result) {
    return live
      ? `<span class="player-pick-hit-badge result">Resultado parcial</span>`
      : `<span class="player-pick-hit-badge result">Resultado · +${scored.points}</span>`;
  }

  return "";
}

function rankingTable(ranking) {
  return `
    <div class="table-wrap rank-table">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th class="center">Pts</th>
            <th class="center">Exatos</th>
          </tr>
        </thead>
        <tbody>
          ${ranking.map((row, index) => `
            <tr>
              <td>
                <div class="rank-position-cell">
                  <strong>${index + 1}</strong>
                  ${rankingMovement(row.movement)}
                </div>
              </td>
              <td>${row.name}</td>
              <td class="center strong">${row.points}</td>
              <td class="center">${row.exacts}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function rankingMovement(movement) {
  const value = Number(movement || 0);

  if (value > 0) {
    return `
      <span
        class="rank-movement rank-movement-up"
        title="Subiu ${value} posição${value === 1 ? "" : "ões"}"
      >
        ▲${value > 1 ? ` +${value}` : ""}
      </span>
    `;
  }

  if (value < 0) {
    const amount = Math.abs(value);

    return `
      <span
        class="rank-movement rank-movement-down"
        title="Caiu ${amount} posição${amount === 1 ? "" : "ões"}"
      >
        ▼${amount > 1 ? ` -${amount}` : ""}
      </span>
    `;
  }

  return `<span class="rank-movement rank-movement-same" title="Manteve a posição">−</span>`;
}

function calculateRanking() {
  const currentRanking = buildRanking();
  const liveMatchIds = DATA.matches
    .filter((match) => isLiveMatch(match) && hasPredictionScore(match))
    .map((match) => match.id);
  const comparisonMatchIds = liveMatchIds.length
    ? liveMatchIds
    : [getLastRankedMatch()?.id].filter(Boolean);

  if (!comparisonMatchIds.length) {
    return currentRanking.map((row) => Object.assign({}, row, { movement: 0 }));
  }

  const previousRanking = buildRanking(comparisonMatchIds);
  const previousPositions = new Map(
    previousRanking.map((row, index) => [row.id, index + 1])
  );

  return currentRanking.map((row, index) => {
    const currentPosition = index + 1;
    const previousPosition = previousPositions.get(row.id) || currentPosition;

    return Object.assign({}, row, {
      movement: previousPosition - currentPosition
    });
  });
}

function buildRanking(excludedMatchIds = []) {
  const excludedIds = new Set(
    Array.isArray(excludedMatchIds)
      ? excludedMatchIds.map(String)
      : [String(excludedMatchIds || "")].filter(Boolean)
  );

  return DATA.players.map((player) => {
    let points = 0;
    let exacts = 0;
    let results = 0;

    DATA.matches.forEach((match) => {
      if (!isRankingScorableMatch(match) || excludedIds.has(String(match.id))) {
        return;
      }

      const scored = scorePick(state.picks[player.id]?.[match.id], match);
      points += scored.points;
      exacts += scored.exact ? 1 : 0;
      results += scored.result ? 1 : 0;
    });

    return {
      id: player.id,
      name: player.name,
      points,
      exacts,
      results
    };
  }).sort((a, b) => {
    return b.points - a.points ||
      b.exacts - a.exacts ||
      a.name.localeCompare(b.name);
  });
}

function getLastRankedMatch() {
  return DATA.matches
    .filter((match) => isFinishedStatus(match) && hasPredictionScore(match))
    .sort((first, second) => compareFinishedMatches(second, first))[0] || null;
}

function numericMatchValue(match, fields) {
  for (const field of fields) {
    const rawValue = match?.[field];

    if (rawValue === null || rawValue === undefined || rawValue === "") {
      continue;
    }

    const value = Number(rawValue);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

function matchStatusText(match) {
  return [
    match?.status,
    match?.sourceStatus,
    match?.elapsed
  ]
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchEndedOnPenalties(match) {
  const text = matchStatusText(match);
  const homePenalties = numericMatchValue(match, [
    "penaltyScore1",
    "penalties1",
    "shootoutScore1"
  ]);
  const awayPenalties = numericMatchValue(match, [
    "penaltyScore2",
    "penalties2",
    "shootoutScore2"
  ]);

  return text.includes("penalt") ||
    text.includes("shootout") ||
    (homePenalties !== null && awayPenalties !== null);
}

function matchEndedAfterExtraTime(match) {
  const text = matchStatusText(match);
  return matchEndedOnPenalties(match) ||
    /(?:^|\s)aet(?:$|\s)/.test(text) ||
    text.includes("after extra time") ||
    text.includes("extra time") ||
    text.includes("prorrogacao");
}

function numericScorePair(match, fieldPairs) {
  for (const fields of fieldPairs) {
    const home = numericMatchValue(match, [fields[0]]);
    const away = numericMatchValue(match, [fields[1]]);

    if (home !== null && away !== null) {
      return { home, away };
    }
  }

  return { home: null, away: null };
}

function getPredictionScore(match) {
  const regulationScore = numericScorePair(match, [
    ["score1", "score2"]
  ]);

  if (!match || groupStageRounds.includes(match.round)) {
    return regulationScore;
  }

  if (matchEndedOnPenalties(match)) {
    return numericScorePair(match, [
      ["scoreBeforePenalties1", "scoreBeforePenalties2"],
      ["regulationPlusExtraTime1", "regulationPlusExtraTime2"],
      ["scoreAfterExtraTime1", "scoreAfterExtraTime2"],
      ["betScore1", "betScore2"],
      ["score1", "score2"]
    ]);
  }

  if (matchEndedAfterExtraTime(match)) {
    return numericScorePair(match, [
      ["regulationPlusExtraTime1", "regulationPlusExtraTime2"],
      ["scoreAfterExtraTime1", "scoreAfterExtraTime2"],
      ["betScore1", "betScore2"],
      ["score1", "score2"]
    ]);
  }

  return regulationScore;
}

function hasPredictionScore(match) {
  const score = getPredictionScore(match);
  return score.home !== null && score.away !== null;
}

function isRankingScorableMatch(match) {
  return Boolean(match) &&
    !isDelayedScheduledMatch(match) &&
    (isFinishedStatus(match) || isLiveMatch(match)) &&
    hasPredictionScore(match);
}

function scorePick(pick, match) {
  const score = getPredictionScore(match);

  if (!pick ||
    isDelayedScheduledMatch(match) ||
    isFutureScheduledMatch(match) ||
    score.home === null ||
    score.away === null) {
    return { points: 0, exact: false, result: false };
  }

  const pickHome = Number(pick.g1);
  const pickAway = Number(pick.g2);

  if (!Number.isFinite(pickHome) || !Number.isFinite(pickAway)) {
    return { points: 0, exact: false, result: false };
  }

  if (pickHome === score.home && pickAway === score.away) {
    return { points: EXACT_SCORE_POINTS, exact: true, result: true };
  }

  if (outcome(pickHome, pickAway) === outcome(score.home, score.away)) {
    return { points: RESULT_POINTS, exact: false, result: true };
  }

  return { points: 0, exact: false, result: false };
}

function outcome(a, b) {
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function calculateGroupStandings() {
  const standings = {};

  DATA.groups.forEach((group) => {
    standings[group.id] = group.teams.map((team) => ({
      team,
      pts: 0,
      j: 0,
      v: 0,
      e: 0,
      d: 0,
      gp: 0,
      gc: 0,
      sg: 0
    }));
  });

  DATA.matches
    .filter((match) => {
      const score = getPredictionScore(match);
      return groupStageRounds.includes(match.round) &&
        !isFutureScheduledMatch(match) &&
        score.home !== null &&
        score.away !== null;
    })
    .forEach((match) => {
      const score = getPredictionScore(match);
      const groupId = String(match.group || "").replace("Grupo ", "");
      const table = standings[groupId];
      if (!table) return;

      const home = table.find((row) => row.team === match.team1);
      const away = table.find((row) => row.team === match.team2);
      if (!home || !away) return;

      home.j++;
      away.j++;
      home.gp += score.home;
      home.gc += score.away;
      home.sg = home.gp - home.gc;
      away.gp += score.away;
      away.gc += score.home;
      away.sg = away.gp - away.gc;

      if (score.home > score.away) {
        home.v++;
        away.d++;
        home.pts += 3;
      } else if (score.home < score.away) {
        away.v++;
        home.d++;
        away.pts += 3;
      } else {
        home.e++;
        away.e++;
        home.pts++;
        away.pts++;
      }
    });

  Object.keys(standings).forEach((key) => {
    standings[key].sort((a, b) => b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || a.team.localeCompare(b.team));
  });

  return standings;
}

function roundDeadline(round) {
  const authoritative = new Date(state.roundDeadlines?.[round] || "");

  if (!Number.isNaN(authoritative.getTime())) {
    return authoritative;
  }

  const first = DATA.matches
    .filter((match) => match.round === round)
    .sort((firstMatch, secondMatch) => makeDate(firstMatch) - makeDate(secondMatch))[0];

  if (!first) {
    return new Date(Number.NaN);
  }

  const date = makeDate(first);
  const lockMinutes = Number(DATA.settings.lockMinutesBeforeRound ?? 15);
  date.setMinutes(date.getMinutes() - lockMinutes);
  return date;
}

function isRoundLocked(round) {
  const deadline = roundDeadline(round);
  return Number.isNaN(deadline.getTime()) || currentCompetitionTimeMs() >= deadline.getTime();
}

function isLiveMatch(match) {
  if (!match || isFinishedStatus(match) || isDelayedScheduledMatch(match)) {
    return false;
  }

  if (!hasExplicitLiveState(match)) {
    return false;
  }

  const kickoff = makeDate(match).getTime();
  const now = currentCompetitionTimeMs();

  if (hasFreshLiveSource(match)) {
    return !isInterruptedMatch(match) || !Number.isFinite(kickoff) || now >= kickoff;
  }

  return Number.isFinite(kickoff) &&
    now >= kickoff - 5 * 60 * 1000 &&
    now <= kickoff + ACTIVE_MATCH_GRACE_MS;
}

function hasExplicitLiveState(match) {
  const status = String(match && match.status || '').toLowerCase();
  const sourceStatus = String(match && match.sourceStatus || '').toLowerCase();
  const elapsed = String(match && match.elapsed || '').toLowerCase();

  if (
    status.includes('vivo') ||
    status.includes('live') ||
    status.includes('andamento') ||
    status.includes('intervalo') ||
    status.includes('interrompido') ||
    sourceStatus.includes('in_play') ||
    sourceStatus.includes('in play') ||
    sourceStatus.includes('paused') ||
    sourceStatus.includes('halftime') ||
    sourceStatus.includes('half time') ||
    sourceStatus.includes('extra_time') ||
    sourceStatus.includes('penalty') ||
    sourceStatus.includes('suspended') ||
    sourceStatus.includes('delayed') ||
    sourceStatus.includes('weather')
  ) {
    return true;
  }

  return /^\d{1,3}(?:\+\d{1,2})?$/.test(
    elapsed.replace(/['’]/g, '')
  ) || [
    'intervalo',
    'halftime',
    'half time',
    'ht',
    'break',
    'prorrogação',
    'penaltis',
    'pênaltis',
    'interrompido',
    'suspenso',
    'delayed'
  ].includes(elapsed);
}

function isDelayedScheduledMatch(match) {
  if (!match || isFinishedStatus(match)) {
    return false;
  }

  const sourceState = String(match.sourceState || "").trim().toLowerCase();
  const text = [
    match.status,
    match.sourceStatus,
    match.elapsed
  ].join(" ").toLowerCase();

  const delayed = text.includes("delayed") ||
    text.includes("weather") ||
    text.includes("adiado") ||
    text.includes("atrasado") ||
    text.includes("postponed");

  return delayed && sourceState !== "in";
}

function hasFreshLiveSource(match) {
  const updatedAt = new Date(match && match.sourceUpdatedAt || '').getTime();

  return Number.isFinite(updatedAt) &&
    Date.now() - updatedAt >= 0 &&
    Date.now() - updatedAt <= LIVE_SOURCE_FRESH_MS;
}

function isInterruptedMatch(match) {
  const text = [
    match && match.status,
    match && match.sourceStatus,
    match && match.elapsed
  ].join(' ').toLowerCase();

  return text.includes('interrompido') ||
    text.includes('suspended') ||
    text.includes('delayed') ||
    text.includes('weather') ||
    text.includes('postponed') ||
    text.includes('adiado') ||
    text.includes('atrasado');
}

function matchDisplayDate(match) {
  const sourceDate = String(match && match.sourceDate || "").trim();
  const sourceTime = String(match && match.sourceTime || "").trim();

  return sourceDate && sourceTime
    ? sourceDate
    : String(match && match.date || "");
}

function formatMatchDate(match) {
  return formatDate(matchDisplayDate(match));
}

function formatMatchTime(match) {
  const sourceDate = String(match && match.sourceDate || "").trim();
  const sourceTime = String(match && match.sourceTime || "").trim();

  return sourceDate && sourceTime
    ? sourceTime
    : String(match && match.time || "");
}

function makeDate(match) {
  const date = matchDisplayDate(match);
  const time = formatMatchTime(match);

  return new Date(`${date}T${time}:00`);
}

function country(name) {
  const label = SHORT_COUNTRY_NAMES[name] || name;
  return `<span class="country">${flagMarkup(name)}<span>${label}</span></span>`;
}

function compactCountry(name) {
  return `<span class="compact-country">${flagMarkup(name)}<span>${countryCode(name)}</span></span>`;
}

function flagMarkup(name) {
  const position = FLAG_POSITIONS[name];

  if (!position) {
    return `<span class="flag-fallback" role="img" aria-label="Bandeira não disponível">•</span>`;
  }

  return `
    <span
      class="flag-sprite"
      role="img"
      aria-label="Bandeira de ${escapeHtml(name)}"
      style="--flag-col:${position[0]};--flag-row:${position[1]}"
    ></span>
  `;
}

function countryCode(name) {
  const codes = {
    "África do Sul": "RSA",
    "Coreia do Sul": "KOR",
    "México": "MEX",
    "República Tcheca": "CZE",
    "Bósnia": "BIH",
    "Canadá": "CAN",
    "Catar": "QAT",
    "Suíça": "SUI",
    "Brasil": "BRA",
    "Escócia": "SCO",
    "Haiti": "HAI",
    "Marrocos": "MAR",
    "Austrália": "AUS",
    "Estados Unidos": "USA",
    "Paraguai": "PAR",
    "Turquia": "TUR",
    "Alemanha": "GER",
    "Costa do Marfim": "CIV",
    "Curaçao": "CUW",
    "Equador": "ECU",
    "Holanda": "NED",
    "Japão": "JPN",
    "Suécia": "SWE",
    "Tunísia": "TUN",
    "Bélgica": "BEL",
    "Egito": "EGY",
    "Irã": "IRN",
    "Nova Zelândia": "NZL",
    "Arábia Saudita": "KSA",
    "Cabo Verde": "CPV",
    "Espanha": "ESP",
    "Uruguai": "URU",
    "França": "FRA",
    "Iraque": "IRQ",
    "Noruega": "NOR",
    "Senegal": "SEN",
    "Argélia": "ALG",
    "Argentina": "ARG",
    "Áustria": "AUT",
    "Jordânia": "JOR",
    "Colômbia": "COL",
    "RD Congo": "COD",
    "Portugal": "POR",
    "Uzbequistão": "UZB",
    "Croácia": "CRO",
    "Gana": "GHA",
    "Inglaterra": "ENG",
    "Panamá": "PAN"
  };

  return codes[name] || String(name || "").slice(0, 3).toUpperCase();
}

function compactVenue(venue) {
  const text = String(venue || "");
  const parts = text.split(" - ");
  if (parts.length >= 2) return parts[1];
  return text.replace("Estadio ", "").replace("Stadium", "").trim();
}

function displayRound(round) {
  return ROUND_LABELS[round] || round;
}


function formatPickLastSaved(pick) {
  const value = pick?.updatedAt || pick?.submittedAt;

  if (!value) {
    return "Não enviado";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Salvo";
  }

  return `Salvo ${date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function formatPick(pick) {
  if (!pick || Number.isNaN(pick.g1) || Number.isNaN(pick.g2)) return "-";
  return `${pick.g1} x ${pick.g2}`;
}

function isFutureScheduledMatch(match) {
  if (!match || isLiveMatch(match) || isFinishedStatus(match)) {
    return false;
  }

  const hasScore = match.score1 !== null &&
    match.score1 !== undefined &&
    match.score2 !== null &&
    match.score2 !== undefined;

  if (hasScore) {
    return false;
  }

  if (isDelayedScheduledMatch(match)) {
    return true;
  }

  const kickoff = makeDate(match).getTime();
  return Number.isFinite(kickoff) && kickoff > currentCompetitionTimeMs();
}

function isPastMatchAwaitingResult(match) {
  if (
    !match ||
    isLiveMatch(match) ||
    isFinishedStatus(match) ||
    isDelayedScheduledMatch(match) ||
    matchHasScore(match)
  ) {
    return false;
  }

  const kickoff = makeDate(match).getTime();
  return Number.isFinite(kickoff) && kickoff < currentCompetitionTimeMs();
}

function isFinishedStatus(match) {
  const text = [
    match && match.status,
    match && match.sourceStatus,
    match && match.elapsed
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /(?:^|\s)(?:ft|aet|final|finished|encerrado|finalizado|full time|after extra time)(?:$|\s)/.test(text);
}

function matchResultInline(match) {
  if (isFutureScheduledMatch(match)) {
    return "x";
  }

  if (match.score1 === null ||
    match.score1 === undefined ||
    match.score2 === null ||
    match.score2 === undefined) {
    return isLiveMatch(match) ? "AO VIVO" : "x";
  }

  return `${match.score1} x ${match.score2}`;
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatDateTime(date) {
  const dateText = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
  const timeText = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${dateText} às ${timeText}`;
}


init();
