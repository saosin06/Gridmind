'use client'

import { useEffect, useRef, useState } from 'react'

/** Smoothly animates a number toward `value` whenever it changes. */
export default function CountUp({
  value,
  render,
  ms = 600,
}: {
  value: number
  render: (n: number) => string
  ms?: number
}) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const from = fromRef.current
    const to = value
    if (from === to) return
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      setDisplay(from + (to - from) * eased)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else { fromRef.current = to; setDisplay(to) }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [value, ms])

  return <>{render(display)}</>
}
