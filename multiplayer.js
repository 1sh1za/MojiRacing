/**
 * もじレーシング — マルチプレイ（PartyKit WebSocket）
 *
 * 各クライアントはローカルで Matter.js 物理を実行し、
 * 他プレイヤーは剛体としてワールドに参加（衝突あり）。
 */
(function () {
  const SYNC_INTERVAL_MS = 66;
  const REMOTE_COLORS = [
    "#e11d48", "#7c3aed", "#0891b2", "#ca8a04", "#059669", "#db2777",
  ];

  const lobbyEl = document.getElementById("lobby");
  const roomInputEl = document.getElementById("roomCode");
  const nameInputEl = document.getElementById("playerName");
  const lobbyStatusEl = document.getElementById("lobbyStatus");
  const playerListEl = document.getElementById("playerList");
  const btnSolo = document.getElementById("btnSolo");
  const btnJoin = document.getElementById("btnJoin");
  const btnStartRace = document.getElementById("btnStartRace");
  const btnCopyLink = document.getElementById("btnCopyLink");
  const mpHudEl = document.getElementById("mpHud");

  const mp = {
    mode: "lobby",
    ws: null,
    myId: "",
    roomId: "",
    name: "プレイヤー",
    color: REMOTE_COLORS[0],
    remotes: new Map(),
    lastSync: 0,
    raceStartTimer: null,
    connected: false,
  };

  function partyHost() {
    const cfg = window.MOJI_CONFIG?.partyHost;
    if (cfg) return cfg.replace(/^wss?:\/\//, "").replace(/\/$/, "");
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return "localhost:1999";
    }
    return "";
  }

  function wsUrl(roomId) {
    const host = partyHost();
    const proto = host.startsWith("localhost") ? "ws" : "wss";
    return `${proto}://${host}/party/${encodeURIComponent(roomId)}`;
  }

  function randomRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function colorFromId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return REMOTE_COLORS[h % REMOTE_COLORS.length];
  }

  function setLobbyStatus(msg, isError) {
    if (!lobbyStatusEl) return;
    lobbyStatusEl.textContent = msg || "";
    lobbyStatusEl.classList.toggle("error", !!isError);
  }

  function hideLobby() {
    if (lobbyEl) lobbyEl.classList.add("hidden");
  }

  function showLobby() {
    if (lobbyEl) lobbyEl.classList.remove("hidden");
  }

  function updatePlayerList() {
    if (!playerListEl) return;
    const items = [{ id: mp.myId || "me", name: mp.name + " (あなた)", color: mp.color }];
    for (const [, r] of mp.remotes) {
      items.push({ id: r.id, name: r.name || "???", color: r.color });
    }
    playerListEl.innerHTML = items
      .map(
        (p) =>
          `<li><span class="mp-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</li>`
      )
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function updateMpHud() {
    if (!mpHudEl) return;
    if (mp.mode !== "online") {
      mpHudEl.classList.add("hidden");
      return;
    }
    mpHudEl.classList.remove("hidden");
    const n = 1 + mp.remotes.size;
    mpHudEl.textContent = `ルーム ${mp.roomId} · ${n}人`;
  }

  function pushRemoteToPhysics(id, data) {
    window.MojiGame?.ensureRemotePlayer?.(id, data);
  }

  function applyRemoteState(id, data) {
    let r = mp.remotes.get(id);
    if (!r) {
      r = {
        id,
        name: data.name || "???",
        char: data.char || "あ",
        color: data.color || colorFromId(id),
        target: { x: 0, y: 0, angle: 0, vx: 0, vy: 0, av: 0 },
      };
      mp.remotes.set(id, r);
    }
    r.name = data.name || r.name;
    r.char = data.char || r.char;
    r.color = data.color || r.color;
    r.target.x = data.x ?? r.target.x;
    r.target.y = data.y ?? r.target.y;
    r.target.angle = data.angle ?? r.target.angle;
    r.target.vx = data.vx ?? r.target.vx;
    r.target.vy = data.vy ?? r.target.vy;
    r.target.av = data.av ?? r.target.av;

    pushRemoteToPhysics(id, {
      name: r.name,
      char: r.char,
      color: r.color,
      x: r.target.x,
      y: r.target.y,
      angle: r.target.angle,
      vx: r.target.vx,
      vy: r.target.vy,
      av: r.target.av,
    });

    updatePlayerList();
    updateMpHud();
  }

  function removeRemote(id) {
    mp.remotes.delete(id);
    window.MojiGame?.removeRemotePlayer?.(id);
    updatePlayerList();
    updateMpHud();
  }

  function hydrateRemotesToWorld() {
    for (const [id, r] of mp.remotes) {
      pushRemoteToPhysics(id, {
        name: r.name,
        char: r.char,
        color: r.color,
        x: r.target.x,
        y: r.target.y,
        angle: r.target.angle,
        vx: r.target.vx,
        vy: r.target.vy,
        av: r.target.av,
      });
    }
  }

  function connectRoom(roomId) {
    const host = partyHost();
    if (!host) {
      setLobbyStatus(
        "マルチ用サーバーが未設定です。ひとりでプレイするか、README の手順で PartyKit をデプロイしてください。",
        true
      );
      return;
    }

    const name = (nameInputEl?.value || "").trim() || "プレイヤー";
    mp.name = name.slice(0, 12);
    mp.roomId = roomId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || randomRoomCode();
    mp.color = REMOTE_COLORS[Math.floor(Math.random() * REMOTE_COLORS.length)];
    mp.mode = "online";
    mp.remotes.clear();
    window.MojiGame?.clearRemotePlayers?.();

    if (roomInputEl) roomInputEl.value = mp.roomId;
    history.replaceState(null, "", `?room=${encodeURIComponent(mp.roomId)}`);

    const url = wsUrl(mp.roomId);
    setLobbyStatus(`接続中… (${url})`);
    if (btnJoin) btnJoin.disabled = true;

    mp.wasConnected = false;
    const ws = new WebSocket(url);
    mp.ws = ws;

    ws.addEventListener("open", () => {
      mp.wasConnected = true;
      mp.connected = true;
      setLobbyStatus(`ルーム ${mp.roomId} に接続しました`);
      ws.send(JSON.stringify({ type: "ready", name: mp.name, color: mp.color }));
      if (btnStartRace) btnStartRace.disabled = false;
      updateMpHud();
      updatePlayerList();
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === "welcome") {
        mp.myId = msg.id;
        updatePlayerList();
        return;
      }
      if (msg.type === "player" && msg.id !== mp.myId) {
        applyRemoteState(msg.id, msg);
        return;
      }
      if (msg.type === "leave") {
        removeRemote(msg.id);
        return;
      }
      if (msg.type === "state" && msg.id !== mp.myId) {
        applyRemoteState(msg.id, msg);
        return;
      }
      if (msg.type === "race_start") {
        scheduleRaceStart(msg.startAt);
      }
    });

    ws.addEventListener("close", () => {
      mp.connected = false;
      if (mp.mode !== "online") return;
      if (btnJoin) btnJoin.disabled = false;
      const host = partyHost();
      if (!mp.wasConnected) {
        if (host.includes("localhost")) {
          setLobbyStatus(
            "マルチサーバーに接続できません。別ターミナルで npm run dev を実行してから、もう一度「ルームに参加」してください。",
            true
          );
        } else {
          setLobbyStatus(
            `マルチサーバー（${host}）に接続できません。PartyKit のデプロイと Vercel の MOJI_PARTY_HOST を確認してください。`,
            true
          );
        }
      } else {
        setLobbyStatus("接続が切れました。もう一度「ルームに参加」してください。", true);
      }
    });

    ws.addEventListener("error", () => {
      if (btnJoin) btnJoin.disabled = false;
    });
  }

  function scheduleRaceStart(startAt) {
    hideLobby();
    const delay = Math.max(0, startAt - Date.now());
    setLobbyStatus("");
    if (mp.raceStartTimer) clearTimeout(mp.raceStartTimer);
    showCountdown(delay);
    mp.raceStartTimer = setTimeout(() => {
      hideCountdown();
      const G = window.MojiGame;
      if (G?.startGame) G.startGame();
    }, delay);
  }

  const countdownEl = document.getElementById("countdown");

  function showCountdown(ms) {
    if (!countdownEl) return;
    countdownEl.classList.remove("hidden");
    const end = Date.now() + ms;
    function tick() {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (left <= 0) {
        countdownEl.textContent = "GO!";
        return;
      }
      countdownEl.textContent = String(left);
      requestAnimationFrame(tick);
    }
    tick();
  }

  function hideCountdown() {
    if (countdownEl) {
      countdownEl.classList.add("hidden");
      countdownEl.textContent = "";
    }
  }

  function beginSolo() {
    mp.mode = "solo";
    mp.ws?.close();
    mp.ws = null;
    mp.remotes.clear();
    window.MojiGame?.clearRemotePlayers?.();
    hideLobby();
    updateMpHud();
    window.MojiGame?.startGame();
  }

  function requestRaceStart() {
    if (mp.mode !== "online" || !mp.ws || mp.ws.readyState !== WebSocket.OPEN) return;
    mp.ws.send(JSON.stringify({ type: "request_start" }));
    if (btnStartRace) btnStartRace.disabled = true;
    setLobbyStatus("スタートを待っています…");
  }

  function buildLocalState() {
    const G = window.MojiGame;
    const st = G?.getState?.();
    if (!st?.vehicle) return null;
    const b = st.vehicle.body;
    return {
      type: "state",
      name: mp.name,
      char: st.charText || "あ",
      x: b.position.x,
      y: b.position.y,
      angle: b.angle,
      vx: b.velocity.x,
      vy: b.velocity.y,
      av: b.angularVelocity,
      finished: st.finished,
      goalTime: st.finished && st.startTime
        ? (performance.now() - st.startTime) / 1000
        : null,
      color: mp.color,
    };
  }

  function tick() {
    if (mp.mode !== "online" || !mp.connected || !mp.ws) return;
    const now = performance.now();
    if (now - mp.lastSync < SYNC_INTERVAL_MS) return;
    mp.lastSync = now;
    const payload = buildLocalState();
    if (payload) mp.ws.send(JSON.stringify(payload));
  }

  function onCharChange() {
    if (mp.mode !== "online" || !mp.ws) return;
    mp.lastSync = 0;
    tick();
  }

  function onGoal() {
    if (mp.mode !== "online" || !mp.ws) return;
    mp.lastSync = 0;
    tick();
  }

  function onGameStart() {
    if (mp.mode === "online") hydrateRemotesToWorld();
  }

  function copyRoomLink() {
    const room = (roomInputEl?.value || mp.roomId || randomRoomCode()).trim();
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    navigator.clipboard?.writeText(url).then(
      () => setLobbyStatus("リンクをコピーしました"),
      () => setLobbyStatus(url)
    );
  }

  function initLobby() {
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room && roomInputEl) roomInputEl.value = room.toUpperCase();

    btnSolo?.addEventListener("click", beginSolo);
    btnJoin?.addEventListener("click", () => {
      const code = (roomInputEl?.value || "").trim() || randomRoomCode();
      connectRoom(code);
    });
    btnStartRace?.addEventListener("click", requestRaceStart);
    btnCopyLink?.addEventListener("click", copyRoomLink);

    const host = partyHost();
    if (host.includes("localhost")) {
      setLobbyStatus(
        "ローカルマルチ: 先に npm run dev（PartyKit）を起動してから参加してください"
      );
    } else if (host) {
      setLobbyStatus(`マルチサーバー: ${host}`);
    } else {
      setLobbyStatus(
        "インターネットマルチ未設定 — PartyKit をデプロイし Vercel に MOJI_PARTY_HOST を設定してください",
        false
      );
    }
    showLobby();
  }

  window.MojiMP = {
    tick,
    onCharChange,
    onGoal,
    onGameStart,
    get mode() {
      return mp.mode;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLobby);
  } else {
    initLobby();
  }
})();
