export type PlayerEvent =
  | { type: "ready" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; at: number }
  | { type: "ended" }
  | { type: "error"; message: string }

export interface Player {
  /** Begin playback as soon as the underlying source allows. */
  play(): Promise<void>
  pause(): void
  /** Seek to seconds. */
  seek(seconds: number): void
  /** Atomic "start playing at this position" — required for late-joiner sync,
      because seek-then-play is unreliable on YT when the player is UNSTARTED. */
  playFrom(seconds: number): Promise<void>
  /** Current playhead in seconds. */
  currentTime(): number
  /** Duration in seconds (NaN if unknown). */
  duration(): number
  /** True when the underlying media is not actively playing. */
  isPaused(): boolean
  /** Tear down. */
  destroy(): void
}
