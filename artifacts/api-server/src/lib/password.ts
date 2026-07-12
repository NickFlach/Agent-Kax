import crypto from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing for the email door (task #52). Uses node:crypto
 * scrypt — no external dependency — with parameters encoded into the
 * stored string so they can be tuned later without invalidating
 * existing hashes:
 *
 *   scrypt$N$r$p$<salt b64>$<hash b64>
 *
 * Always use the async scrypt: the sync variant would block the event
 * loop and a burst of logins would stall the whole single-instance
 * server.
 */

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/**
 * Upper bound on accepted password length. scrypt cost scales with
 * input size, so an unbounded password is a CPU-DoS vector. Enforced
 * by the OpenAPI schema too (maxLength: 128).
 */
export const MAX_PASSWORD_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`password exceeds ${MAX_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A real hash computed once on first use, so the "email not found"
// path costs the same as the "wrong password" path — a fast 401 on
// unknown emails would leak which addresses have accounts.
let dummyHash: string | null = null;

export async function dummyVerify(password: string): Promise<void> {
  if (!dummyHash) {
    dummyHash = await hashPassword("kax-timing-equalizer");
  }
  await verifyPassword(password.slice(0, MAX_PASSWORD_LENGTH), dummyHash);
}
