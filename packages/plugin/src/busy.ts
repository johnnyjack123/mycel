// A click that waits for the server or the disk shows at once that it was
// taken: the button greys out and spins until the work is done, and takes no
// second click meanwhile. Without it, a click that waited for the server
// looked like one that went nowhere, and was clicked again.

/** What `busy` needs of Obsidian's ButtonComponent or ExtraButtonComponent. */
export interface BusyButton {
  setDisabled(disabled: boolean): unknown
  buttonEl?: HTMLElement
  extraSettingsEl?: HTMLElement
}

const BUSY = 'connect-busy'

/**
 * Runs `task` with `button` greyed out and spinning. A button already busy
 * runs nothing; without a button the task simply runs. Errors pass through.
 */
export async function busy(button: BusyButton | null | undefined, task: () => Promise<void>): Promise<void> {
  const element = button?.buttonEl ?? button?.extraSettingsEl
  if (element?.classList.contains(BUSY)) return
  element?.classList.add(BUSY)
  button?.setDisabled(true)
  try {
    await task()
  } finally {
    element?.classList.remove(BUSY)
    button?.setDisabled(false)
  }
}
