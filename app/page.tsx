"use client"

import { useRouter } from "next/navigation"
import { nanoid } from "nanoid"
import { Button } from "@/components/ui/button"

export default function Page() {
  const router = useRouter()
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">shabang</h1>
        <Button size="lg" onClick={() => router.push(`/r/${nanoid(8)}`)}>
          Create a room
        </Button>
      </div>
    </main>
  )
}
