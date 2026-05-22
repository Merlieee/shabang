/** Extract a YouTube video ID from common URL shapes, or pass through an 11-char ID. */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s
  try {
    const u = new URL(s)
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.slice(1)
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v")
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v
      // /shorts/ID or /embed/ID
      const m = u.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/)
      if (m) return m[2]
    }
  } catch {
    // not a URL
  }
  return null
}
