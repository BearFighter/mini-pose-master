// SPDX-License-Identifier: GPL-3.0-or-later
// Dismissible error banner with the error code and message.
import { detailNumbers } from '../lib/errors'
import { useStore } from '../store'
import { IconAlert, IconClose } from './icons'

export function ErrorBanner() {
  const error = useStore((s) => s.error)
  const dismiss = useStore((s) => s.dismissError)
  if (!error) return null
  return (
    <div className="error-banner" role="alert">
      <span className="error-icon">
        <IconAlert size={16} />
      </span>
      <span className="code">{error.code}</span>
      <span className="message">
        {error.message}
        {detailNumbers(error.detail) && <span className="detail"> ({detailNumbers(error.detail)})</span>}
      </span>
      <button className="icon" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <IconClose size={14} />
      </button>
    </div>
  )
}
