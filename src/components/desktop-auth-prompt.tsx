"use client"

import { useEffect, useState } from "react"

import { getForgeHost } from "@/host/forge-host"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type DesktopAuthPromptProps = {
  returnTo?: string
  title: string
}

export function DesktopAuthPrompt({ returnTo, title }: DesktopAuthPromptProps) {
  const [isOpening, setIsOpening] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [manualCode, setManualCode] = useState("")
  const [showManualCode, setShowManualCode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpening) return

    const timeout = window.setTimeout(() => {
      setIsOpening(false)
      setError("Sign-in expired. Start again to open a new secure session.")
    }, 120_000)

    return () => window.clearTimeout(timeout)
  }, [isOpening])

  async function beginAuth() {
    setError(null)
    setIsOpening(true)
    setShowManualCode(false)

    try {
      await getForgeHost().beginAuth({ returnTo })
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Forge could not open your browser."
      )
      setIsOpening(false)
    }
  }

  async function completeAuth() {
    const token = manualCode.trim()
    if (!token) return

    setError(null)
    setIsCompleting(true)
    try {
      await getForgeHost().completeAuth({ token })
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Forge could not use that connection code."
      )
      setIsCompleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-8 items-center justify-center rounded-md">
            <img
              src="/img/Logo%20Forge.png"
              alt="Forge"
              className="size-8 object-contain"
            />
          </div>
          <h1 className="text-xl font-bold">{title}</h1>
          <FieldDescription>
            Continue in your browser to sign in or create an account. Forge will
            reopen automatically when you&apos;re done.
          </FieldDescription>
        </div>

        {error ? (
          <FieldDescription className="text-center text-destructive">
            {error}
          </FieldDescription>
        ) : null}

        <Button type="button" onClick={beginAuth} disabled={isOpening}>
          {isOpening ? "Waiting for browser…" : "Continue in browser"}
        </Button>

        {isOpening ? (
          <div className="space-y-3 text-center">
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-muted-foreground"
              onClick={() => setIsOpening(false)}
            >
              I cancelled—try again
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-muted-foreground"
              onClick={() => setShowManualCode((visible) => !visible)}
            >
              Use a connection code
            </Button>

            {showManualCode ? (
              <div className="space-y-2 text-left">
                <Input
                  aria-label="Connection code"
                  value={manualCode}
                  onChange={(event) => setManualCode(event.target.value)}
                  placeholder="Paste the code from your browser"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  className="w-full"
                  disabled={!manualCode.trim() || isCompleting}
                  onClick={completeAuth}
                >
                  {isCompleting ? "Connecting…" : "Connect Forge"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </FieldGroup>
    </div>
  )
}
