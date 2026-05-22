"use client"

import { useEffect, useRef } from "react"
import type { Player } from "@/lib/player/types"

export type Html5PlayerProps = {
  src: string
  onPlayer?: (p: Player | null) => void
  onReady?: () => void
  onUserPlay?: (at: number) => void
  onUserPause?: (at: number) => void
  onUserSeek?: (at: number) => void
}

export function Html5Player({
  src,
  onPlayer,
  onReady,
  onUserPlay,
  onUserPause,
  onUserSeek,
}: Html5PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const suppress = useRef(false)
  const seekArmed = useRef(false)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const player: Player = {
      async play() {
        if (!v.paused) return
        suppress.current = true
        try {
          await v.play()
        } catch {
          // Autoplay blocked. Reset so a future real gesture isn't eaten.
          suppress.current = false
        }
      },
      pause() {
        if (v.paused) return
        suppress.current = true
        v.pause()
      },
      seek(seconds) {
        if (Math.abs(v.currentTime - seconds) < 0.1) return
        suppress.current = true
        v.currentTime = seconds
      },
      async playFrom(seconds) {
        v.currentTime = seconds
        suppress.current = true
        try {
          await v.play()
        } catch {
          suppress.current = false
        }
      },
      currentTime() {
        return v.currentTime
      },
      duration() {
        return v.duration
      },
      isPaused() {
        return v.paused
      },
      destroy() {
        v.pause()
        v.removeAttribute("src")
        v.load()
      },
    }
    onPlayer?.(player)

    const handlePlay = () => {
      if (suppress.current) {
        suppress.current = false
        return
      }
      onUserPlay?.(v.currentTime)
    }
    const handlePause = () => {
      if (suppress.current) {
        suppress.current = false
        return
      }
      onUserPause?.(v.currentTime)
    }
    const handleSeeking = () => {
      seekArmed.current = true
    }
    const handleSeeked = () => {
      if (!seekArmed.current) return
      seekArmed.current = false
      if (suppress.current) {
        suppress.current = false
        return
      }
      onUserSeek?.(v.currentTime)
    }
    const handleLoaded = () => onReady?.()
    v.addEventListener("play", handlePlay)
    v.addEventListener("pause", handlePause)
    v.addEventListener("seeking", handleSeeking)
    v.addEventListener("seeked", handleSeeked)
    v.addEventListener("loadedmetadata", handleLoaded)
    return () => {
      v.removeEventListener("play", handlePlay)
      v.removeEventListener("pause", handlePause)
      v.removeEventListener("seeking", handleSeeking)
      v.removeEventListener("seeked", handleSeeked)
      v.removeEventListener("loadedmetadata", handleLoaded)
      onPlayer?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      playsInline
      className="h-full w-full bg-black"
    />
  )
}
