import { useEffect, useRef, useState } from "react"

import type { AnimationPlaybackControls } from "motion/react"
import { animate, AnimatePresence, motion, useMotionValue } from "motion/react"
import { HandCoinsIcon, VaultIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

// Shared counter so sound plays once even when both balances animate simultaneously
let activeAnimations = 0
let soundSafetyTimer: ReturnType<typeof setTimeout> | null = null
const SOUND_MAX_DURATION = 3000

function startSoundTracking() {
  activeAnimations++
  if (activeAnimations === 1) {
    useAudioStore.getState().playSound("currency", { loop: true, once: true, delay: 200 })
    if (soundSafetyTimer) clearTimeout(soundSafetyTimer)
    soundSafetyTimer = setTimeout(() => {
      useAudioStore.getState().stopSound("currency")
      activeAnimations = 0
    }, SOUND_MAX_DURATION)
  }
}

function stopSoundTracking() {
  activeAnimations = Math.max(0, activeAnimations - 1)
  if (activeAnimations === 0) {
    useAudioStore.getState().stopSound("currency")
    if (soundSafetyTimer) {
      clearTimeout(soundSafetyTimer)
      soundSafetyTimer = null
    }
  }
}

const useBalanceAnimation = (balance: number | undefined) => {
  const value = useMotionValue(balance ?? 0)
  const [state, setState] = useState({
    displayValue: balance ?? 0,
    settledBalance: balance ?? 0,
    isAnimating: false,
    direction: null as "up" | "down" | null,
  })
  const controls = useRef<AnimationPlaybackControls | null>(null)
  const isFirst = useRef(true)

  useEffect(
    () => value.on("change", (v) => setState((prev) => ({ ...prev, displayValue: Math.round(v) }))),
    [value]
  )

  useEffect(() => {
    if (balance == null) return
    if (isFirst.current) {
      isFirst.current = false
      return
    }
    if (balance === value.get()) return
    const direction = balance > value.get() ? "up" : "down"
    controls.current?.stop()
    queueMicrotask(() => setState((prev) => ({ ...prev, isAnimating: true, direction })))

    startSoundTracking()

    controls.current = animate(value, balance, {
      duration: 0.8,
      delay: 0.25,
      ease: [0.16, 1, 0.3, 1],
      onComplete: () => {
        stopSoundTracking()
        setState((prev) => ({
          ...prev,
          isAnimating: false,
          settledBalance: balance,
          direction: null,
        }))
      },
    })
  }, [balance, value])

  return state
}

const BalanceItem = ({
  label,
  balance,
  settledBalance,
  displayValue,
  expanded,
  direction,
  Icon,
}: {
  label: string
  balance: number | undefined
  settledBalance: number
  displayValue: number
  expanded: boolean
  direction: "up" | "down" | null
  Icon: React.ElementType
}) => {
  const directionColor =
    direction === "up" ? "text-success"
    : direction === "down" ? "text-warning"
    : ""

  const content = (
    <div className="flex flex-col justify-center gap-1.5 text-xs uppercase w-28 h-full p-ui-xs">
      <span
        className={cn(
          "truncate leading-none text-xxs",
          direction ? "animate-blink text-white" : "text-subtle-foreground"
        )}
      >
        {label}
      </span>{" "}
      <AnimatePresence mode="wait" initial={false}>
        {expanded ?
          <motion.span
            key="counting"
            className={cn(
              "font-semibold truncate tabular-nums flex flex-row items-center gap-1.5 leading-none tracking-tight",
              directionColor
            )}
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Icon size={14} weight="bold" />
            {formatCurrency(displayValue, "standard")}
          </motion.span>
        : <motion.span
            key="settled"
            className="text-white font-semibold truncate tabular-nums flex flex-row items-center gap-1.5 leading-none tracking-tight"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            <Icon size={14} weight="bold" />
            {formatCurrency(settledBalance)}
          </motion.span>
        }
      </AnimatePresence>
    </div>
  )

  if (balance == null) return content

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{formatCurrency(balance, "standard")} CR</TooltipContent>
    </Tooltip>
  )
}

export const TopBarCreditBalance = () => {
  const player = useGameStore.use.player()
  const ship = useGameStore.use.ship()

  const bank = useBalanceAnimation(player?.credits_in_bank)
  const hand = useBalanceAnimation(ship?.credits)
  const anyAnimating = bank.isAnimating || hand.isAnimating

  const [expanded, setExpanded] = useState(false)
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (anyAnimating) {
      if (restTimer.current) clearTimeout(restTimer.current)
      restTimer.current = null
      queueMicrotask(() => setExpanded(true))
    } else if (expanded) {
      restTimer.current = setTimeout(() => setExpanded(false), 2000)
    }
    return () => {
      if (restTimer.current) clearTimeout(restTimer.current)
    }
  }, [anyAnimating, expanded])

  return (
    <motion.div
      className={cn(
        "absolute bg-subtle-background inset-y-0 left-1/2 -translate-x-1/2 flex items-center divide-x divide-border origin-top h-13",
        "border border-t-0",
        expanded && "pointer-events-none"
      )}
      animate={{ scale: expanded ? 1.2 : 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      <BalanceItem
        label="Bank"
        balance={player?.credits_in_bank}
        settledBalance={bank.settledBalance}
        displayValue={bank.displayValue}
        expanded={expanded}
        direction={bank.direction}
        Icon={VaultIcon}
      />
      <BalanceItem
        label="On Hand"
        balance={ship?.credits}
        settledBalance={hand.settledBalance}
        displayValue={hand.displayValue}
        expanded={expanded}
        direction={hand.direction}
        Icon={HandCoinsIcon}
      />
    </motion.div>
  )
}
