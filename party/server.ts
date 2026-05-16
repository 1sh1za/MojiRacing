import type * as Party from "partykit/server";

/** クライアントから送られるプレイヤー状態 */
type PlayerPayload = {
  type: "state";
  name: string;
  char: string;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  av: number;
  finished: boolean;
  goalTime: number | null;
  color: string;
};

type ClientMessage =
  | PlayerPayload
  | { type: "ready"; name: string; color: string }
  | { type: "request_start" };

type ServerMessage =
  | { type: "welcome"; id: string; room: string }
  | { type: "player"; id: string } & PlayerPayload
  | { type: "leave"; id: string }
  | { type: "race_start"; startAt: number };

export default class RoomServer implements Party.Server {
  /** 接続ごとの最新状態（再接続時に新規参加者へ送る） */
  players = new Map<string, PlayerPayload & { id: string }>();
  readyIds = new Set<string>();
  raceScheduled = false;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    conn.send(
      JSON.stringify({
        type: "welcome",
        id: conn.id,
        room: this.room.id,
      } satisfies ServerMessage)
    );

    for (const [id, p] of this.players) {
      if (id === conn.id) continue;
      conn.send(JSON.stringify({ type: "player", ...p } satisfies ServerMessage));
    }
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ready") {
      this.readyIds.add(sender.id);
      const stub: PlayerPayload & { id: string } = {
        type: "state",
        id: sender.id,
        name: msg.name,
        char: "あ",
        x: 0,
        y: 0,
        angle: 0,
        vx: 0,
        vy: 0,
        av: 0,
        finished: false,
        goalTime: null,
        color: msg.color,
      };
      this.players.set(sender.id, stub);
      this.room.broadcast(
        JSON.stringify({ type: "player", ...stub } satisfies ServerMessage),
        [sender.id]
      );
      return;
    }

    if (msg.type === "request_start") {
      const conns = [...this.room.getConnections()];
      if (conns.length < 1 || this.raceScheduled) return;
      this.raceScheduled = true;
      const startAt = Date.now() + 3000;
      this.room.broadcast(
        JSON.stringify({ type: "race_start", startAt } satisfies ServerMessage)
      );
      return;
    }

    if (msg.type === "state") {
      const player = { ...msg, id: sender.id };
      this.players.set(sender.id, player);
      this.room.broadcast(JSON.stringify(player), [sender.id]);
    }
  }

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id);
    this.readyIds.delete(conn.id);
    this.room.broadcast(
      JSON.stringify({ type: "leave", id: conn.id } satisfies ServerMessage)
    );
    if (this.room.getConnections().size === 0) {
      this.raceScheduled = false;
    }
  }
}
