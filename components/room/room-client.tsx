"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { usePartySocket } from "partysocket/react"
import { Check, Link as LinkIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Player } from "@/lib/player/types"
import type { ClientMessage, RoomState, ServerMessage, Source } from "@/lib/types"
import { YouTubePlayer } from "./youtube-player"
import { Html5Player } from "./html5-player"
import { SourcePicker } from "./source-picker"

const TorrentPlayer = dynamic(
  () => import("./torrent-player").then((m) => m.TorrentPlayer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-black text-sm text-muted-foreground">
        Loading torrent engine…
      </div>
    ),
  },
)

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "127.0.0.1:1999"

type Props = { roomId: string }

export function RoomClient({ roomId }: Props) {
  const [state, setState] = useState<RoomState | null>(null)
  const [localFile, setLocalFile] = useState<File | null>(null)
  const [player, setPlayer] = useState<Player | null>(null)
  const [lastApplied, setLastApplied] = useState<{
    paused: boolean
    position: number
    updatedAt: number
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const socket = usePartySocket({
    host: PARTYKIT_HOST,
    room: roomId,
    onMessage(evt) {
      let msg: ServerMessage
      try {
        msg = JSON.parse(evt.data)
      } catch {
        return
      }
      if (msg.type === "state") setState(msg.state)
    },
  })

  const send = useCallback(
    (msg: ClientMessage) => {
      socket.send(JSON.stringify(msg))
    },
    [socket],
  )

  const source = state?.source ?? null

  useEffect(() => {
    if (!state || !player) return
    if (
      lastApplied &&
      lastApplied.paused === state.paused &&
      lastApplied.position === state.position &&
      lastApplied.updatedAt === state.updatedAt
    ) {
      return
    }
    setLastApplied({
      paused: state.paused,
      position: state.position,
      updatedAt: state.updatedAt,
    })

    const targetNow = state.paused
      ? state.position
      : state.position + (Date.now() - state.updatedAt) / 1000
    const cur = player.currentTime()
    if (Math.abs(cur - targetNow) > 1.0) player.seek(targetNow)
    if (state.paused) player.pause()
    else player.play().catch(() => {})
  }, [state, player, lastApplied])

  useEffect(() => {
    if (!state || state.paused || !player) return
    const id = window.setInterval(() => {
      const target = state.position + (Date.now() - state.updatedAt) / 1000
      const cur = player.currentTime()
      if (Math.abs(cur - target) > 1.5) player.seek(target)
    }, 4000)
    return () => window.clearInterval(id)
  }, [state, player])

  const handleUserPlay = useCallback((at: number) => send({ type: "play", at }), [send])
  const handleUserPause = useCallback((at: number) => send({ type: "pause", at }), [send])
  const handleUserSeek = useCallback((at: number) => send({ type: "seek", at }), [send])

  const handlePickSource = useCallback(
    (s: Source) => {
      send({ type: "set-source", source: s })
      setLocalFile(null)
    },
    [send],
  )
  const handlePickLocalFile = useCallback((f: File) => setLocalFile(f), [])
  const handleMagnetReady = useCallback(
    (uri: string) => {
      if (!localFile) return
      send({
        type: "set-source",
        source: { kind: "torrent", ref: uri, title: localFile.name },
      })
    },
    [localFile, send],
  )

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  const shouldSeedLocalFile =
    !!localFile && (!source || source.kind !== "torrent" || !source.ref)

  const playerView = useMemo(() => {
    if (shouldSeedLocalFile && localFile) {
      return (
        <TorrentPlayer
          file={localFile}
          onPlayer={setPlayer}
          onMagnet={handleMagnetReady}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />
      )
    }
    if (!source) return null
    if (source.kind === "youtube") {
      return (
        <YouTubePlayer
          videoId={source.ref}
          onPlayer={setPlayer}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />
      )
    }
    if (source.kind === "mp4") {
      return (
        <Html5Player
          src={source.ref}
          onPlayer={setPlayer}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />
      )
    }
    if (source.kind === "torrent") {
      return (
        <TorrentPlayer
          file={localFile}
          magnet={localFile ? null : source.ref}
          onPlayer={setPlayer}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />
      )
    }
    return null
  }, [
    shouldSeedLocalFile,
    localFile,
    source,
    handleMagnetReady,
    handleUserPlay,
    handleUserPause,
    handleUserSeek,
  ])

  return (
    <main className="flex min-h-svh flex-col gap-3 p-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <a href="/" className="text-lg font-semibold tracking-tight hover:underline">
          shabang
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{state?.memberCount ?? 1} watching</Badge>
          <SourcePicker
            onPickSource={handlePickSource}
            onPickLocalFile={handlePickLocalFile}
          />
          <Button
            size="icon"
            variant="secondary"
            onClick={copyLink}
            aria-label={copied ? "Link copied" : "Copy link"}
            title={copied ? "Link copied" : "Copy link"}
          >
            {copied ? <Check className="size-4" /> : <LinkIcon className="size-4" />}
          </Button>
        </div>
      </header>

      <div
        className="mx-auto aspect-video w-full overflow-hidden rounded-lg border bg-card"
        style={{ maxWidth: "min(98vw, calc((100dvh - 90px) * 16 / 9))" }}
      >
        {playerView ?? (
          <div className="flex h-full w-full items-center justify-center bg-black text-sm text-muted-foreground">
            Paste a link or pick a file to start.
          </div>
        )}
      </div>

      {source?.title && (
        <p className="text-center text-xs text-muted-foreground">
          Now playing: {source.title}
        </p>
      )}
    </main>
  )
}
