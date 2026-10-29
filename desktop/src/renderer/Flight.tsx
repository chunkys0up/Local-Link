import { useLayoutEffect, useRef } from 'react'

/**
 * The send animation, two layers from where the composer sits:
 * - the prompt's text glides to the top of the build page and shrinks, dimming until it
 *   lands exactly on the build page's caption (same width, wrap and colour);
 * - the composer's white card glides up beside it and spreads into the build bar across
 *   the top of the page, turning from white into the bar's dark glass; the real bar takes
 *   over where it lands.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Intro {
  id: string // the workflow being built
  prompt: string
  from: Box // where the composer was
  width: number // the caption's text width: the composer's, scaled by SCALE
  landed: boolean
}

// The composer's text is 15px; the caption's 13px. Everything scales by the same factor,
// so the text wraps identically all the way up.
export const SCALE = 13 / 15
const PAD_X = 16 // the composer's padding
const PAD_Y = 18

export function captionWidth(from: Box): number {
  return (from.width - PAD_X * 2) * SCALE
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const GLIDE = { duration: 860, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } as const

export function PromptFlight({ intro, anchor, card, onLanded }: { intro: Intro; anchor: HTMLElement; card: HTMLElement; onLanded: () => void }) {
  const text = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const words = text.current
    const shell = box.current
    if (!words || !shell) return
    const from = intro.from

    // The text: laid out where it lands; the animation starts it back where the composer was.
    const to = anchor.getBoundingClientRect()
    const left = to.left - PAD_X * SCALE
    const top = to.top - PAD_Y * SCALE
    const height = to.height + PAD_Y * SCALE * 2
    Object.assign(words.style, { left: `${left}px`, top: `${top}px`, width: `${intro.width + PAD_X * SCALE * 2}px`, height: `${height}px` })
    const glide = words.animate(
      [
        { transform: `translate(${from.left - left}px, ${from.top - top}px) scale(${1 / SCALE})`, height: `${from.height * SCALE}px` },
        { transform: 'none', height: `${height}px` },
      ],
      GLIDE,
    )
    const dim = words.animate(
      [{ color: 'rgb(36, 36, 36)' }, { offset: 0.45, color: 'rgba(255, 255, 255, 0.85)' }, { color: 'rgba(255, 255, 255, 0.5)' }],
      { duration: 700, easing: 'ease-in-out', fill: 'both' },
    )

    // The box: from the composer's to the build bar's (full width, against the top edge),
    // white to the bar's dark glass.
    const target = card.getBoundingClientRect()
    const reshape = shell.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
        { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px` },
      ],
      GLIDE,
    )
    const darken = shell.animate(
      [
        { backgroundColor: 'rgb(255, 255, 255)', boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.21), 0 18px 50px rgba(0, 0, 0, 0.18)' },
        { offset: 0.5, backgroundColor: 'rgba(120, 110, 104, 0.9)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 18px 50px rgba(0, 0, 0, 0)' },
        { backgroundColor: 'rgba(34, 33, 32, 0.9)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0), 0 18px 50px rgba(0, 0, 0, 0)' },
      ],
      { duration: 450, easing: 'ease-out', fill: 'both' },
    )
    // The bar is square: the corners stay round until the box is nearly there (85% of the
    // way, on the same easing as the glide), then square off as it meets the edges.
    const square = shell.animate([{ borderRadius: '12px' }, { offset: 0.85, borderRadius: '12px' }, { borderRadius: '0px' }], GLIDE)

    Promise.all([glide.finished, reshape.finished]).then(onLanded, () => {})
    return () => {
      for (const a of [glide, dim, reshape, darken, square]) a.cancel()
    }
    // Runs once per flight: the anchors and intro are fixed for its duration.
  }, [])

  return (
    <>
      <div className="flight-card" ref={box} aria-hidden="true" />
      <div className="flight" ref={text} aria-hidden="true">
        <div className="flight-text">{intro.prompt}</div>
      </div>
    </>
  )
}
