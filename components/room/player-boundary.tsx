"use client"

import { Component, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Stops a player crash (YT IFrame DOM mismatch, etc) from taking down the room UI. */
export class PlayerBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error("[player-boundary]", error)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-black text-sm text-muted-foreground">
          <p>Player crashed.</p>
          <Button size="sm" variant="secondary" onClick={this.reset}>
            Reload player
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
