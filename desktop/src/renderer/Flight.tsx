import { useLayoutEffect, useRef } from 'react'

/**
 * The send animation: the composer, copied where it sits, glides to the top of the
 * build page and shrinks, its fill and stroke fading until only the prompt is left,
 * dim, against the dark. It lands exactly on the build page's caption (same width,
 * wrap and colour), which takes over without a visible swap.
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

export function PromptFlight({ intro, anchor, onLanded }: { intro: Intro; anchor: HTMLElement; onLanded: () => void }) {
  const card = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const to = anchor.getBoundingClientRect()
    // Laid out where it lands; the animation starts it back where the composer was.
    const left = to.left - PAD_X * SCALE
    const top = to.top - PAD_Y * SCALE
    const height = to.height + PAD_Y * SCALE * 2
    Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${intro.width + PAD_X * SCALE * 2}px`, height: `${height}px` })

    const from = intro.from
    const glide = el.animate(
      [
        { transform: `translate(${from.left - left}px, ${from.top - top}px) scale(${1 / SCALE})`, height: `${from.height * SCALE}px` },
        { transform: 'none', height: `${height}px` },
      ],
      { duration: 860, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    )
    // The card dissolves on the way up; the text turns into the dim caption.
    const fade = el.animate(
      [
        { backgroundColor: 'rgb(255, 255, 255)', boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.21), 0 18px 50px rgba(0, 0, 0, 0.18)', color: 'rgb(36, 36, 36)' },
        { offset: 0.45, backgroundColor: 'rgba(255, 255, 255, 0.35)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 18px 50px rgba(0, 0, 0, 0)', color: 'rgba(255, 255, 255, 0.85)' },
        { backgroundColor: 'rgba(255, 255, 255, 0)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0), 0 18px 50px rgba(0, 0, 0, 0)', color: 'rgba(255, 255, 255, 0.5)' },
      ],
      { duration: 700, easing: 'ease-in-out', fill: 'both' },
    )
    glide.finished.then(onLanded, () => {})
    return () => {
      glide.cancel()
      fade.cancel()
    }
    // Runs once per flight: the anchor and intro are fixed for its duration.
  }, [])

  return (
    <div className="flight" ref={card} aria-hidden="true">
      <div className="flight-text">{intro.prompt}</div>
    </div>
  )
}
