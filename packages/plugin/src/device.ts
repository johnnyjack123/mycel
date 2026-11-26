// A device as the account's other devices see it: by the name it was given in
// its settings, or by its kind until then (0.9.29). Before, every device was
// "a computer" or "a phone or tablet" - locks and records sealed then still say so.

/** A device's name until it is given one: its kind. */
export function defaultDeviceName(platform: { isMobile: boolean; isIosApp: boolean; isMacOS: boolean; isWin: boolean }): string {
  if (platform.isMobile) return platform.isIosApp ? 'iPhone or iPad' : 'Android device'
  if (platform.isMacOS) return 'Mac'
  return platform.isWin ? 'Windows computer' : 'Linux computer'
}

/** A device named in a sentence: a name in quotes, the words of a device from before names as they are. */
export function deviceWords(device: string): string {
  return /^(a|an|another) /.test(device) ? device : `"${device}"`
}
