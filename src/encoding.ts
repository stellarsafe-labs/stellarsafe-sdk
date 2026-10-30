/** Byte encoding helpers that work in Node and browsers without `Buffer`. */
import { StellarSafeError } from "./errors.js";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (err) {
    throw new StellarSafeError("INVALID_ARGUMENT", "Invalid base64 string", { cause: err });
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new StellarSafeError("INVALID_ARGUMENT", `Invalid hex string: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new StellarSafeError(
      "INVALID_ARGUMENT",
      `Expected ${expectedLength} bytes of hex, got ${bytes.length}`,
    );
  }
  return bytes;
}
