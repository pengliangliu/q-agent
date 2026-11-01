import { signal } from '@preact/signals'

// Only requests currently writing to native/UI state block a page reload.
// Durable pending receipts remain recoverable after their POST has returned.
export const mutationCountSignal = signal(0)
export function beginUiMutation() {
  mutationCountSignal.value++
  let released = false
  return () => {
    if (released) return
    released = true
    mutationCountSignal.value = Math.max(0, mutationCountSignal.value - 1)
  }
}
