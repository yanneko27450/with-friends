export declare const nobleEd25519Verify: (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
) => boolean

export declare const nobleEd25519Sign: (message: Uint8Array, privateKey: Uint8Array) => Uint8Array

export declare const nobleEd25519PublicKey: (privateKey: Uint8Array) => Uint8Array

export declare const nobleSha512: (message: Uint8Array) => Uint8Array

export declare const nobleXChaCha20Poly1305Encrypt: (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
) => Uint8Array

export declare const nobleXChaCha20Poly1305Decrypt: (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
) => Uint8Array

export declare const nobleSha256: (message: Uint8Array) => Uint8Array

export declare const nobleHmacSha256: (key: Uint8Array, message: Uint8Array) => Uint8Array

export declare const nobleHkdfSha256: (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
) => Uint8Array

export declare const nobleX25519PublicKey: (privateKey: Uint8Array) => Uint8Array

export declare const nobleX25519SharedSecret: (privateKey: Uint8Array, publicKey: Uint8Array) => Uint8Array
