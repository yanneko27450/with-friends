export declare const nobleEd25519Verify: (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
) => boolean

export declare const nobleEd25519Sign: (message: Uint8Array, privateKey: Uint8Array) => Uint8Array

export declare const nobleSha512: (message: Uint8Array) => Uint8Array
