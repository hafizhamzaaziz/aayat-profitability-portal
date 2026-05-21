import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM symmetric encryption for at-rest secrets (e.g. OAuth refresh tokens).
 *
 * The encryption key is read from the TOKEN_ENC_KEY env var (32 bytes, base64-encoded).
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Ciphertext format: base64(iv || authTag || ciphertext)
 *   iv      = 12 bytes (GCM standard)
 *   authTag = 16 bytes
 *   ciphertext = variable length
 *
 * If TOKEN_ENC_KEY rotates, all stored ciphertexts become unreadable. Keep it
 * versioned in your secret manager and never commit it to the repo.
 */

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENC_KEY is not configured. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` and add it to .env.local and Vercel env vars."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). Regenerate with the command in the doc-block above.`
    );
  }
  return key;
}

export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptString(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted payload is too short to be valid.");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
