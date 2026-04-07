import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

const TUTORIAL_VIDEO_URL =
  "https://api.gradient-bang.com/storage/v1/object/public/GB%20Public/tutorial.mp4"

export const IntroTutorial = ({ onContinue }: { onContinue: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const isOpen = activeModal?.modal === "intro_tutorial"
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hovered, setHovered] = useState(false)
  const [showConfirmTutorial, setShowConfirmTutorial] = useState(false)

  useEffect(() => {
    if (isOpen) {
      useAudioStore.getState().fadeOut("theme", { duration: 1500 })
    }
  }, [isOpen])

  const handleVideoEnded = () => {
    setShowConfirmTutorial(true)
    //setActiveModal(undefined)
    //onContinue()
  }

  const handleContinue = (bypassTutorial: boolean = false) => {
    // Hide the active model
    setActiveModal(undefined)

    // Set bypass tutorial flag to pass to bot connect method
    if (bypassTutorial) {
      useGameStore.getState().updateSettings({ bypassTutorial: true })
    }

    // Continue to connect
    onContinue()
  }

  return (
    <BaseDialog
      modalName="intro_tutorial"
      title="Welcome"
      size="full"
      overlayVariant="none"
      noPadding
      dismissOnClickOutside={false}
      showCloseButton={false}
      contentClassName="h-screen z-[100]"
      overlayClassName="z-[100]"
    >
      <div
        className="relative w-full h-full flex items-center justify-center bg-black"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {showConfirmTutorial ?
          <Card className="absolute max-w-xl bg-black/80 z-20 elbow">
            <CardContent className="flex flex-col gap-ui-sm">
              <h2 className="text-white text-base uppercase font-bold">
                Start new player tutorial?
              </h2>
              <p className="text-white text-sm text-pretty mb-ui-sm leading-relaxed">
                This tutorial will guide you through the basics of the gameplay, UI and voice agent
                commands. Recommended for first time players.
              </p>
              <Divider variant="dashed" className="h-4 text-accent" />
            </CardContent>
            <CardFooter className="flex flex-row gap-ui-sm justify-end">
              <Button variant="ghost" size="lg" onClick={() => handleContinue(true)}>
                No, skip tutorial
              </Button>
              <Button size="lg" onClick={() => handleContinue()}>
                Yes (recommended)
              </Button>
            </CardFooter>
          </Card>
        : <>
            <video
              ref={videoRef}
              src={TUTORIAL_VIDEO_URL}
              className="max-w-480 max-h-270 w-full h-full object-contain"
              autoPlay
              playsInline
              preload="auto"
              controls={hovered}
              onEnded={handleVideoEnded}
            />
            <div className="fixed top-ui-md right-ui-md z-10">
              <Button variant="ghost" size="sm" onClick={handleVideoEnded}>
                Skip
              </Button>
            </div>
          </>
        }
      </div>
    </BaseDialog>
  )
}
