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
  /** Current playhead in seconds. */
  currentTime(): number
  /** Duration in seconds (NaN if unknown). */
  duration(): number
  /** Tear down. */
  destroy(): void
}
