"use client"

import { useEffect, useRef } from "react"
import type { Player } from "@/lib/player/types"

declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

let ytReady: Promise<void> | null = null
function loadYT(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"))
  if (window.YT?.Player) return Promise.resolve()
  if (ytReady) return ytReady
  ytReady = new Promise((resolve) => {
    const tag = document.createElement("script")
    tag.src = "https://www.youtube.com/iframe_api"
    document.head.appendChild(tag)
    window.onYouTubeIframeAPIReady = () => resolve()
  })
  return ytReady
}

export type YouTubePlayerProps = {
  videoId: string
  onPlayer?: (p: Player | null) => void
  onReady?: () => void
  onUserPlay?: (at: number) => void
  onUserPause?: (at: number) => void
  onUserSeek?: (at: number) => void
}

export function YouTubePlayer({
  videoId,
  onPlayer,
  onReady,
  onUserPlay,
  onUserPause,
  onUserSeek,
}: YouTubePlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const ytRef = useRef<any>(null)
  // Programmatic state changes (from sync) should NOT echo back as user actions.
  const suppressEvents = useRef(false)
  const lastTime = useRef(0)

  useEffect(() => {
    let destroyed = false
    let pollId: number | null = null

    loadYT().then(() => {
      if (destroyed || !hostRef.current) return
      // YT IFrame API methods throw "this.b is undefined" if called on a player
      // that's mid-init or destroyed. Wrap every call so a stale reference can't
      // crash React.
      const safe = <T,>(fn: () => T): T | undefined => {
        try {
          return fn()
        } catch (e) {
          console.warn("[yt] api call failed", e)
          return undefined
        }
      }
      const getState = () => safe(() => ytRef.current?.getPlayerState?.())
      const getCur = () => safe(() => ytRef.current?.getCurrentTime?.()) ?? 0
      const expose = () => {
        const player: Player = {
          async play() {
            const YT = window.YT
            if (getState() === YT?.PlayerState?.PLAYING) return
            suppressEvents.current = true
            safe(() => ytRef.current?.playVideo?.())
            window.setTimeout(() => {
              if (getState() !== YT?.PlayerState?.PLAYING) {
                suppressEvents.current = false
              }
            }, 1500)
          },
          pause() {
            const YT = window.YT
            if (getState() === YT?.PlayerState?.PAUSED) return
            suppressEvents.current = true
            safe(() => ytRef.current?.pauseVideo?.())
          },
          seek(seconds) {
            const cur = getCur()
            if (Math.abs(cur - seconds) < 0.1) return
            suppressEvents.current = true
            safe(() => ytRef.current?.seekTo?.(seconds, true))
          },
          currentTime() {
            return getCur()
          },
          duration() {
            return safe(() => ytRef.current?.getDuration?.()) ?? NaN
          },
          isPaused() {
            return getState() !== window.YT?.PlayerState?.PLAYING
          },
          destroy() {
            safe(() => ytRef.current?.destroy?.())
            ytRef.current = null
          },
        }
        onPlayer?.(player)
      }
      ytRef.current = new window.YT.Player(hostRef.current, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          controls: 1,
          disablekb: 0,
        },
        events: {
          onReady: () => {
            expose()
            onReady?.()
          },
          onStateChange: (e: any) => {
            const YT = window.YT
            const t = getCur()
            if (e.data === YT?.PlayerState?.PLAYING) {
              if (suppressEvents.current) {
                suppressEvents.current = false
              } else {
                onUserPlay?.(t)
              }
            } else if (e.data === YT?.PlayerState?.PAUSED) {
              if (suppressEvents.current) {
                suppressEvents.current = false
              } else {
                onUserPause?.(t)
              }
            }
            lastTime.current = t
          },
        },
      })

      // Detect user seeks by polling: YT doesn't fire a dedicated seek event.
      pollId = window.setInterval(() => {
        const cur = getCur()
        const delta = cur - lastTime.current
        // Big jumps not explained by ~1s of elapsed playback → treat as seek.
        if (Math.abs(delta) > 1.5) {
          if (suppressEvents.current) {
            suppressEvents.current = false
          } else {
            onUserSeek?.(cur)
          }
        }
        lastTime.current = cur
      }, 800)
    })

    return () => {
      destroyed = true
      if (pollId != null) window.clearInterval(pollId)
      try {
        ytRef.current?.destroy?.()
      } catch {
        /* already torn down */
      }
      ytRef.current = null
      onPlayer?.(null)
    }
    // We intentionally do NOT depend on callbacks; they're refs of refs of behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  return <div ref={hostRef} className="h-full w-full bg-black" />
}
