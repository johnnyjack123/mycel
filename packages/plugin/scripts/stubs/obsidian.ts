// Stands in for the `obsidian` module when the sync layer runs outside the
// app (see scripts/tsconfig.json). Only what `src/sync` and `src/editor`
// import at runtime; behaviour lives in `fake-vault.ts`.

export class TAbstractFile {
  path = ''
  name = ''
}

export class TFile extends TAbstractFile {
  basename = ''
  extension = ''
  stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
  /** What lies directly in it; the fake vault keeps it current. */
  children: TAbstractFile[] = []
}

export class Notice {
  /** Every notice shown so far, for tests to assert on. */
  static readonly shown: string[] = []

  constructor(message: string, _duration?: number) {
    Notice.shown.push(message)
  }
}

export function normalizePath(path: string): string {
  return path
}

/** A link's target without its heading or block reference. */
export function getLinkpath(linktext: string): string {
  const cut = linktext.search(/[#^]/)
  return cut < 0 ? linktext : linktext.slice(0, cut)
}
