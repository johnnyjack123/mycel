export interface UserColor {
  color: string
  colorLight: string
}

const PALETTE: readonly UserColor[] = [
  { color: '#30bced', colorLight: '#30bced33' },
  { color: '#6eeb83', colorLight: '#6eeb8333' },
  { color: '#ffbc42', colorLight: '#ffbc4233' },
  { color: '#ecd444', colorLight: '#ecd44433' },
  { color: '#ee6352', colorLight: '#ee635233' },
  { color: '#9ac2c9', colorLight: '#9ac2c933' },
  { color: '#8acb88', colorLight: '#8acb8833' },
  { color: '#1be7ff', colorLight: '#1be7ff33' }
]

export function userColor(seed: string): UserColor {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  return PALETTE[hash % PALETTE.length] as UserColor
}
