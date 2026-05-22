"use client"

import { useEffect, useRef, useState } from "react"
import type { Player } from "@/lib/player/types"

declare global {
  interface Window {
    WebTorrent?: any
  }
}

let webTorrentReady: Promise<any> | null = null
function loadWebTorrent(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"))
  if (webTorrentReady) return webTorrentReady
  // Use new Function to hide the import from Next's bundler — we want it to fetch
  // the prebuilt ESM bundle at runtime, not statically resolve "webtorrent".
  const importESM = new Function("u", "return import(u)")
  const p: Promise<any> = importESM("/webtorrent.min.js").then((mod: any) => {
    return mod?.default ?? mod?.WebTorrent ?? mod
  })
  webTorrentReady = p
  return p
}

export type TorrentPlayerProps = {
  /** If provided (host path), file is seeded locally and rendered from the seed. */
  file?: File | null
  /** If provided (guest path), torrent is added by magnet URI. */
  magnet?: string | null
  /** Emitted once after seeding so the parent can broadcast the magnet URI. */
  onMagnet?: (uri: string) => void
  onPlayer?: (p: Player | null) => void
  onReady?: () => void
  onUserPlay?: (at: number) => void
  onUserPause?: (at: number) => void
  onUserSeek?: (at: number) => void
}

export function TorrentPlayer({
  file,
  magnet,
  onMagnet,
  onPlayer,
  onReady,
  onUserPlay,
  onUserPause,
  onUserSeek,
}: TorrentPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const clientRef = useRef<any>(null)
  const suppress = useRef(false)
  const seekArmed = useRef(false)
  const [status, setStatus] = useState<string>("connecting…")

  function attachVideoListeners(v: HTMLVideoElement) {
    videoElRef.current = v
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

    const player: Player = {
      async play() {
        if (!v.paused) return
        suppress.current = true
        try {
          await v.play()
        } catch {
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
        try {
          clientRef.current?.destroy?.()
        } catch {}
        clientRef.current = null
      },
    }
    onPlayer?.(player)
  }

  useEffect(() => {
    let cancelled = false

    async function go() {
      const WebTorrent = await loadWebTorrent()
      if (cancelled) return
      const client = new WebTorrent()
      clientRef.current = client

      const onTorrent = async (torrent: any) => {
        if (cancelled) return
        const videoFile =
          torrent.files.find((f: any) => /\.(mp4|webm|mkv|mov|m4v)$/i.test(f.name)) ??
          torrent.files[0]
        if (!videoFile) {
          setStatus("no playable file in torrent")
          return
        }
        setStatus(`streaming ${videoFile.name}`)
        // Broadcast magnet first so guests can start fetching peers ASAP.
        if (onMagnet && torrent.magnetURI) onMagnet(torrent.magnetURI)
        const container = containerRef.current
        if (!container) return
        try {
          // dist bundle exposes file.blob(); pull the bytes and feed a real <video>.
          const blob: Blob = await videoFile.blob()
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          container.innerHTML = ""
          const elem = document.createElement("video")
          elem.src = url
          elem.controls = true
          elem.playsInline = true
          elem.className = "h-full w-full bg-black"
          container.appendChild(elem)
          attachVideoListeners(elem)
        } catch (e: any) {
          setStatus(`render error: ${e.message ?? String(e)}`)
        }
      }

      if (file) {
        setStatus("seeding…")
        client.seed(file, onTorrent)
      } else if (magnet) {
        setStatus("fetching peers…")
        client.add(magnet, onTorrent)
      } else {
        setStatus("waiting for source")
      }
    }
    go().catch((err) => setStatus(`error: ${err.message ?? String(err)}`))

    return () => {
      cancelled = true
      try {
        clientRef.current?.destroy?.()
      } catch {}
      clientRef.current = null
      onPlayer?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, magnet])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full bg-black" />
      {status && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs text-white">
          {status}
        </div>
      )}
    </div>
  )
}
