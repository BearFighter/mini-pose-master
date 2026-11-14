// SPDX-License-Identifier: GPL-3.0-or-later
// Dismissible error banner with the error code and message.
import { useStore } from '../store'

export function ErrorBanner() {
  const error = useStore((s) => s.error)
  const dismiss = useStore((s) => s.dismissError)
  if (!error) return null
  return (
    <div className="error-banner" role="alert">
      <span className="code">{error.code}</span>
      <span className="message">{error.message}</span>
      <button className="icon" onClick={dismiss} title="Dismiss">
        ×
      </button>
    </div>
  )
}
