import { argon2id } from 'hash-wasm'
import type { Argon2id } from '@mycel/shared/crypto'

// WebCrypto has no Argon2id. hash-wasm ships it as WebAssembly inside the
// JavaScript bundle, so it works in Obsidian on every platform and in Node.
export const hashWasmArgon2id: Argon2id = (password, salt, params) =>
  argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.hashLength,
    outputType: 'binary'
  })
