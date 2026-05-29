export type SourceKind = "youtube" | "mp4" | "torrent"

export type Source = {
  kind: SourceKind
  /** For youtube: video ID. For mp4: URL. For torrent: magnet URI. */
  ref: string
  /** Optional display title */
  title?: string
}

export type RoomState = {
  source: Source | null
  paused: boolean
  /** Server-anchored playhead: position (seconds) at `updatedAt` (ms epoch). */
  position: number
  updatedAt: number
  /** Just a count and ids — no names, no host concept. */
  memberCount: number
}

export type ClientMessage =
  | { type: "play"; at: number }
  | { type: "pause"; at: number }
  | { type: "seek"; at: number }
  | { type: "set-source"; source: Source }

export type ServerMessage = { type: "state"; state: RoomState }
