import { Fragment } from "react"

import { SquareHalfBottomIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

import { MessageRole } from "./MessageRole"
import { MessageTimestamp } from "./MessageTimestamp"

import type { ConversationMessage } from "@/types/conversation"

interface UiContentProps {
  message: ConversationMessage
  classNames?: {
    messageContent?: string
    time?: string
  }
}

export const UiContent: React.FC<UiContentProps> = ({ message, classNames = {} }) => {
  const parts = Array.isArray(message.parts) ? message.parts : []

  return (
    <div
      className={cn(
        "w-fit text-info font-extrabold text-xxs uppercase inline-flex gap-1 items-center text-subtle-foreground",
        classNames.messageContent
      )}
    >
      <MessageTimestamp createdAt={message.createdAt} className="text-accent-foreground" />
      <SquareHalfBottomIcon size={11} weight="bold" />
      <MessageRole role={message.role} className="inline font-extrabold text-xxs text-inherit" />
      <span className="font-base">
        {parts.map((part, idx) => (
          <Fragment key={idx}>{part.text as React.ReactNode}</Fragment>
        ))}
      </span>
    </div>
  )
}
