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
  // React owns the wrapper. The YT API will replace whatever we appendChild
  // inside it — keeping the replaced node out of React's tree so unmount can
  // never hit a removeChild mismatch.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const ytRef = useRef<any>(null)
  const suppressEvents = useRef(false)
  const lastTime = useRef(0)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    let destroyed = false
    let pollId: number | null = null

    // Create a host element manually — React doesn't know about it.
    const host = document.createElement("div")
    host.style.width = "100%"
    host.style.height = "100%"
    wrapper.appendChild(host)

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

    loadYT().then(() => {
      if (destroyed) return
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
          async playFrom(seconds) {
            // loadVideoById with startSeconds is the YT-canonical way to begin
            // playback at a specific position. Avoids the seek-then-play race
            // when the player is UNSTARTED/CUED.
            suppressEvents.current = true
            safe(() =>
              ytRef.current?.loadVideoById?.({ videoId, startSeconds: seconds }),
            )
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

      ytRef.current = new window.YT.Player(host, {
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
              if (suppressEvents.current) suppressEvents.current = false
              else onUserPlay?.(t)
            } else if (e.data === YT?.PlayerState?.PAUSED) {
              if (suppressEvents.current) suppressEvents.current = false
              else onUserPause?.(t)
            }
            lastTime.current = t
          },
        },
      })

      pollId = window.setInterval(() => {
        const cur = getCur()
        const delta = cur - lastTime.current
        if (Math.abs(delta) > 1.5) {
          if (suppressEvents.current) suppressEvents.current = false
          else onUserSeek?.(cur)
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
      // React will remove `wrapper` on unmount; whatever's inside (iframe
      // replacement or host div) goes with it. We don't touch wrapper.children.
      onPlayer?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  return <div ref={wrapperRef} className="h-full w-full bg-black" />
}
