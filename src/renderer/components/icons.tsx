// SPDX-License-Identifier: GPL-3.0-or-later
// Inline SVG icons (24 x 24 grid, drawn with currentColor strokes). Decorative: hidden from screen
// readers, so the button or label around an icon keeps its own accessible name.
import type { ReactNode, SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon-svg"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** The app mark: a jointed mannequin raising a sword on a round miniature base. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <defs>
        <linearGradient id="mpm-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#25476b" />
          <stop offset="1" stopColor="#111c2c" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#mpm-logo-bg)" />
      <ellipse cx="16" cy="25.2" rx="9" ry="2.6" fill="#7a5c36" />
      <ellipse cx="16" cy="24.4" rx="9" ry="2.4" fill="#c9a063" />
      <g stroke="#dfe7ee" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path d="M16 12.5v6" />
        <path d="M16 18.5l-3 5M16 18.5l3.4 4.6" />
        <path d="M16 13.2l-3.2-2.4-1.4-3.4M16 13.2l2.8 2.6-.6 2.4" />
      </g>
      <circle cx="16" cy="9.6" r="2.3" fill="#dfe7ee" />
      <path d="M11.4 7.4L8 3.2" stroke="#9fd6e8" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.6 7.9l3.4-2.6" stroke="#c9a063" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// --- steps

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11" />
    <path d="M7.5 9.5L12 14l4.5-4.5" />
    <path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" />
  </Svg>
)

export const IconRig = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="4.5" r="1.8" />
    <circle cx="12" cy="11" r="1.6" />
    <circle cx="6.5" cy="8" r="1.4" />
    <circle cx="17.5" cy="8" r="1.4" />
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="15" cy="20" r="1.4" />
    <path d="M12 6.3v3.1M10.6 10.2L7.7 8.7M13.4 10.2l2.9-1.5M11.2 12.4L9.5 18.6M12.8 12.4l1.7 6.2" />
  </Svg>
)

export const IconPose = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="14" cy="4" r="1.9" />
    <path d="M13 8l-3 5.5 4 2.5-1.5 5" />
    <path d="M10 13.5L6.5 20" />
    <path d="M13 8l4 2.5 2.5-1.5" />
    <path d="M13 8L9.5 8.5 7 6.5" />
  </Svg>
)

export const IconHand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 12.5V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5" />
    <path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13" />
    <path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5.2-2.6L4 14.6a1.6 1.6 0 0 1 2.5-2l1.5 1.7" />
  </Svg>
)

export const IconSword = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 4l-9.5 9.5" />
    <path d="M20 4h-3.5L8 12.5" />
    <path d="M20 4v3.5L11.5 16" />
    <path d="M6.5 13.5l4 4" />
    <path d="M8.5 15.5L4.5 19.5" />
    <circle cx="4" cy="20" r="0.6" />
  </Svg>
)

export const IconExport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.8l7.5 4.3v8.6L12 20l-7.5-4.3V7.1z" />
    <path d="M4.5 7.1L12 11.4l7.5-4.3" />
    <path d="M12 11.4V20" />
  </Svg>
)

// --- general

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9.5" rx="2" />
    <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
)

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h11.5L20 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1z" />
    <path d="M8 4v4.5h7V4" />
    <rect x="7.5" y="13" width="9" height="7" rx="1" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7A2 2 0 0 1 5.5 5h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
)

export const IconRedo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
)

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
  </Svg>
)

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="5.5" width="3.2" height="13" rx="1" fill="currentColor" />
    <rect x="13.8" y="5.5" width="3.2" height="13" rx="1" fill="currentColor" />
  </Svg>
)

export const IconStepBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
)

export const IconStepForward = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const IconKeyBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 5.5v13" />
    <path d="M18 6l-7 6 7 6z" fill="currentColor" />
  </Svg>
)

export const IconKeyForward = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17.5 5.5v13" />
    <path d="M6 6l7 6-7 6z" fill="currentColor" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l9 16H3z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.2" r="0.5" fill="currentColor" />
  </Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r="0.5" fill="currentColor" />
  </Svg>
)

export const IconZoom = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
)

export const IconMirror = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <path d="M9 7L4 17h5z" />
    <path d="M15 7l5 10h-5z" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V4.5h5v2" />
    <path d="M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13" />
  </Svg>
)

export const IconLog = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
  </Svg>
)

export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 15l6-6 6 6" />
  </Svg>
)

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const IconCube = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.8l7.5 4.3v8.6L12 20l-7.5-4.3V7.1z" />
    <path d="M4.5 7.1L12 11.4l7.5-4.3M12 11.4V20" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19.5h14" />
  </Svg>
)

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
    <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
)
