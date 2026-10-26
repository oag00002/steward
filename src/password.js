// PBKDF2-SHA256 password hashing with Web Crypto (works in Workers and in Node 18+).
// Stored as: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>
// 60,000 rounds keeps a sign-in inside the Workers Free plan's 10 ms CPU budget.
// The round count is stored with each hash, so it can be raised later without breaking old passwords.
export const ITERATIONS = 60000;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 100000) return false;
  const expected = unb64(parts[4]);
  const actual = new Uint8Array(await derive(password, unb64(parts[3]), iterations));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// A hash of nothing in particular, used to spend the same time when a username doesn't exist.
export const DUMMY_HASH = 'pbkdf2$sha256$60000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
