import type * as Party from "partykit/server"
import type {
  ClientMessage,
  RoomState,
  ServerMessage,
  Source,
} from "../lib/types"

export default class RoomServer implements Party.Server {
  state: RoomState = {
    source: null,
    paused: true,
    position: 0,
    updatedAt: Date.now(),
    memberCount: 0,
  }

  constructor(readonly room: Party.Room) {}

  /** Walk position forward if currently playing so the snapshot is fresh. */
  private currentPosition(): number {
    if (this.state.paused) return this.state.position
    return this.state.position + (Date.now() - this.state.updatedAt) / 1000
  }

  private snapshot(): RoomState {
    return {
      ...this.state,
      position: this.currentPosition(),
      updatedAt: Date.now(),
      memberCount: [...this.room.getConnections()].length,
    }
  }

  private broadcastState() {
    const msg: ServerMessage = { type: "state", state: this.snapshot() }
    this.room.broadcast(JSON.stringify(msg))
  }

  onConnect() {
    this.broadcastState()
  }

  onClose() {
    this.broadcastState()
  }

  onMessage(raw: string) {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    switch (msg.type) {
      case "set-source": {
        this.state.source = sanitizeSource(msg.source)
        this.state.position = 0
        this.state.paused = true
        this.state.updatedAt = Date.now()
        this.broadcastState()
        return
      }
      case "play":
      case "pause":
      case "seek": {
        this.state.position = Math.max(0, Number(msg.at) || 0)
        this.state.paused = msg.type !== "play"
        this.state.updatedAt = Date.now()
        this.broadcastState()
        return
      }
    }
  }
}

function sanitizeSource(s: Source): Source {
  return {
    kind: s.kind,
    ref: String(s.ref).slice(0, 4096),
    title: s.title ? String(s.title).slice(0, 200) : undefined,
  }
}
