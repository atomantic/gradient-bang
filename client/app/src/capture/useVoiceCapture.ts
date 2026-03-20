import { useEffect } from "react"

import { usePipecatClientMediaTrack } from "@pipecat-ai/client-react"

import { useCaptureStore } from "@/stores/captureStore"

export function useVoiceCapture(): void {
  const capture = useCaptureStore((s) => s.capture)
  const localTrack = usePipecatClientMediaTrack("audio", "local")
  const botTrack = usePipecatClientMediaTrack("audio", "bot")

  useEffect(() => {
    capture?.setLocalTrack(localTrack ?? null)
    capture?.setBotTrack(botTrack ?? null)
  }, [capture, localTrack, botTrack])
}
