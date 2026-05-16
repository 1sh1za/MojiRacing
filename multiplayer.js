/**
 * もじレーシング — マルチプレイ（PartyKit WebSocket）
 *
 * 各クライアントはローカルで Matter.js 物理を実行し、
 * 自車の位置・姿勢・文字を約 15Hz で同期。他プレイヤーは補間表示。
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
    mode: "lobby", // lobby | solo | online
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
    for (const [id, r] of mp.remotes) {
      items.push({ id, name: r.name || "???", color: r.color });
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

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function ensureRemoteShape(remote) {
    const G = window.MojiGame;
    if (!G || !remote.char) return;
    if (remote.char === remote._shapeChar && remote.shape) return;
    const shape = G.getCharacterShape(remote.char);
    if (!shape) return;
    remote.shape = shape;
    remote._shapeChar = remote.char;
  }

  function applyRemoteState(id, data) {
    let r = mp.remotes.get(id);
    if (!r) {
      r = {
        id,
        name: data.name || "???",
        char: data.char || "あ",
        color: data.color || colorFromId(id),
        shape: null,
        _shapeChar: "",
        display: { x: 0, y: 0, angle: 0 },
        target: { x: 0, y: 0, angle: 0 },
        finished: false,
        goalTime: null,
      };
      mp.remotes.set(id, r);
    }
    r.name = data.name || r.name;
    r.char = data.char || r.char;
    r.color = data.color || r.color;
    r.finished = !!data.finished;
    r.goalTime = data.goalTime;
    r.target.x = data.x;
    r.target.y = data.y;
    r.target.angle = data.angle;
    if (!r.display.x && !r.display.y) {
      r.display.x = data.x;
      r.display.y = data.y;
      r.display.angle = data.angle;
    }
    ensureRemoteShape(r);
    updatePlayerList();
    updateMpHud();
  }

  function removeRemote(id) {
    mp.remotes.delete(id);
    updatePlayerList();
    updateMpHud();
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

    if (roomInputEl) roomInputEl.value = mp.roomId;
    history.replaceState(null, "", `?room=${encodeURIComponent(mp.roomId)}`);

    setLobbyStatus("接続中…");
    if (btnJoin) btnJoin.disabled = true;

    const ws = new WebSocket(wsUrl(mp.roomId));
    mp.ws = ws;

    ws.addEventListener("open", () => {
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
      if (mp.mode === "online") {
        setLobbyStatus("接続が切れました", true);
        if (btnJoin) btnJoin.disabled = false;
      }
    });

    ws.addEventListener("error", () => {
      setLobbyStatus("接続に失敗しました。PartyKit が起動しているか確認してください。", true);
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

  function interpolateRemotes(dt) {
    const t = Math.min(1, dt / 120);
    for (const r of mp.remotes.values()) {
      r.display.x = lerp(r.display.x, r.target.x, t);
      r.display.y = lerp(r.display.y, r.target.y, t);
      r.display.angle = lerpAngle(r.display.angle, r.target.angle, t);
    }
  }

  function drawRemotes(ctx) {
    const G = window.MojiGame;
    if (!G?.drawCharacterRoller) return;
    for (const r of mp.remotes.values()) {
      ensureRemoteShape(r);
      if (!r.shape) continue;
      const fakeBody = {
        position: { x: r.display.x, y: r.display.y },
        angle: r.display.angle,
      };
      ctx.save();
      ctx.globalAlpha = 0.92;
      drawRemoteRoller(ctx, fakeBody, r);
      ctx.restore();

      if (r.name) {
        ctx.save();
        ctx.font = "bold 12px sans-serif";
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(r.display.x - 40, r.display.y - r.shape.size * 0.9, 80, 18);
        ctx.fillStyle = r.color;
        ctx.textAlign = "center";
        ctx.fillText(r.name, r.display.x, r.display.y - r.shape.size * 0.78);
        ctx.restore();
      }
    }
  }

  /** リモート用: 色付きで同じ形状を描画 */
  function drawRemoteRoller(ctx, body, remote) {
    const shape = remote.shape;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    ctx.fillStyle = remote.color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const contour of shape.contours) {
      ctx.beginPath();
      ctx.moveTo(contour[0][0], contour[0][1]);
      for (let i = 1; i < contour.length; i++) {
        ctx.lineTo(contour[i][0], contour[i][1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function onCharChange(ch) {
    if (mp.mode !== "online" || !mp.ws) return;
    mp.lastSync = 0;
    tick();
  }

  function onGoal() {
    if (mp.mode !== "online" || !mp.ws) return;
    mp.lastSync = 0;
    tick();
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

    if (partyHost()) {
      setLobbyStatus("ルームコードを共有して友達を招待できます");
    } else {
      setLobbyStatus("マルチサーバー未設定 — ひとりでプレイ、または PartyKit をセットアップ", false);
    }
    showLobby();
  }

  window.MojiMP = {
    tick,
    interpolateRemotes,
    drawRemotes,
    onCharChange,
    onGoal,
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
