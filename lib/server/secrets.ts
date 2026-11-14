/**
 * Encryption for secrets the office keeps, such as a model provider's API
 * key. AES-256-GCM with a key derived from the server's signing key, so the
 * database file alone does not reveal them.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { signingKey } from "./auth";

const encryptionKey = (): Buffer =>
  Buffer.from(hkdfSync("sha256", signingKey(), Buffer.alloc(0), "office-secrets-v1", 32));

/** Encrypt a secret for storage. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

/**
 * Decrypt a stored secret. Returns null when it cannot be read, which is what
 * happens if the server's signing key has changed since it was stored.
 */
export function unseal(sealed: string | null): string | null {
  if (!sealed) return null;
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
