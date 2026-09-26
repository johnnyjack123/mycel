// Single word lists of the zxcvbn language packages, imported one by one so
// the bundle carries only the lists worth their size. The packages ship no
// types for these files.
declare module '@zxcvbn-ts/*.json.mjs' {
  const list: string[] | Record<string, string[]>
  export default list
}

declare module '@zxcvbn-ts/language-en/dist/translations.mjs' {
  import type { TranslationKeys } from '@zxcvbn-ts/core'
  const translations: TranslationKeys
  export default translations
}
