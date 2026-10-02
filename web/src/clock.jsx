import { now } from './clock-state.js'
import { elapsed, relativeTime, timestamp } from './state.js'

export function Clock({ value, relative = false, end }) {
  const time = now.value
  return relative ? `Last activity ${relativeTime(value, time)}` : elapsed(value, end ? timestamp(end)?.getTime() || time : time)
}
