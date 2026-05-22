"use client"

import { useRef } from "react"
import { Clipboard, FileVideo } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { parseYouTubeId } from "@/lib/player/youtube-id"
import type { Source } from "@/lib/types"

type Props = {
  onPickSource: (s: Source) => void
  onPickLocalFile: (file: File) => void
}

export function SourcePicker({ onPickSource, onPickLocalFile }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function pasteAndPlay() {
    let text = ""
    try {
      text = (await navigator.clipboard.readText()).trim()
    } catch {
      toast.error("Couldn't read clipboard. Allow clipboard access and try again.")
      return
    }
    if (!text) {
      toast.error("Clipboard is empty.")
      return
    }
    const yt = parseYouTubeId(text)
    if (yt) {
      onPickSource({ kind: "youtube", ref: yt })
      return
    }
    if (/^https?:\/\//.test(text) && /\.(mp4|webm|m4v|mov)(\?|$)/i.test(text)) {
      onPickSource({ kind: "mp4", ref: text })
      return
    }
    toast.error("Clipboard isn't a YouTube link or direct .mp4 URL.")
  }

  return (
    <>
      <Button size="sm" onClick={pasteAndPlay}>
        <Clipboard className="mr-1 size-4" />
        Paste link
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPickLocalFile(f)
        }}
      />
      <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
        <FileVideo className="mr-1 size-4" />
        Select file
      </Button>
    </>
  )
}
