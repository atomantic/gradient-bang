import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

/**
 * Destructive confirmation when the player joins a different corporation
 * and is the last member of their current one — joining will disband the
 * old corp. The edge function only emits `corporation.join_pending` in
 * this case; if there are other remaining members, auto-leave runs
 * silently and no modal is shown.
 *
 * Clicking Confirm sends `confirm-join` with `corp_id` + `invite_code`
 * back to the bot, which forwards to the edge function with
 * `confirm: true`. The edge function re-validates everything before
 * mutating, so tampered fields buy nothing.
 */
export const JoinConfirmDialog = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const client = usePipecatClientStore((state) => state.client)

  const data =
    activeModal?.modal === "confirm_join" ?
      (activeModal.data as ConfirmJoinData | undefined)
    : undefined

  const oldCorpName = data?.old_corp_name ?? "your current corporation"
  const newCorpName = data?.corp_name ?? "the new corporation"

  const onConfirm = () => {
    if (!client || !data) {
      setActiveModal(undefined)
      return
    }
    client.sendClientMessage("confirm-join", {
      corp_id: data.corp_id,
      invite_code: data.invite_code,
    })
    setActiveModal(undefined)
  }

  const onCancel = () => {
    client?.sendClientMessage("cancel-join", {})
    setActiveModal(undefined)
  }

  return (
    <BaseDialog
      modalName="confirm_join"
      title="Switch corporation"
      size="lg"
      dismissOnClickOutside={false}
      onClose={onCancel}
    >
      <Card
        variant="stripes"
        size="default"
        className="w-full h-fit shadow-2xl stripe-frame-destructive bg-background"
      >
        <CardHeader>
          <CardTitle>Disband {oldCorpName}?</CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0 text-sm space-y-3">
          <p>
            You are the last member of <strong>{oldCorpName}</strong>. Joining{" "}
            <strong>{newCorpName}</strong> will <strong>permanently disband</strong> {oldCorpName}.
          </p>
          <p className="text-destructive-foreground/80">This cannot be undone.</p>
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button variant="outline" onClick={onCancel} className="flex-1">
              Stay in {oldCorpName}
            </Button>
            <Button onClick={onConfirm} className="flex-1">
              Join {newCorpName}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
