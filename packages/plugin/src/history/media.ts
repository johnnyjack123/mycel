// What the history views need to show a file that is not a note.

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif'
}

/** The MIME type of an image, by its file name or extension; null for anything else. */
export function imageType(nameOrExtension: string): string | null {
  const extension = nameOrExtension.slice(nameOrExtension.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_TYPES[extension] ?? null
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** An object URL showing these bytes as an image; revoke it when done. */
export function imageUrl(data: Uint8Array, type: string): string {
  return URL.createObjectURL(new Blob([data.slice().buffer], { type }))
}
