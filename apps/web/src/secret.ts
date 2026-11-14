import type { Env } from "./types";

async function encryptionKey(env: Env) {
  const raw = env.SOURCE_ENCRYPTION_KEY;
  if (!raw) throw new Error("SOURCE_ENCRYPTION_KEY is not set");
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  if (bytes.length !== 32)
    throw new Error("SOURCE_ENCRYPTION_KEY must hold 32 bytes in base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealSecret(env: Env, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(text),
  );
  const blob = new Uint8Array(iv.length + sealed.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(sealed), iv.length);
  return blob;
}

export async function openSecret(env: Env, secret: ArrayBuffer | Uint8Array) {
  const blob = secret instanceof Uint8Array ? secret : new Uint8Array(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12) },
    await encryptionKey(env),
    blob.slice(12),
  );
  return new TextDecoder().decode(plain);
}
