/**
 * What makes a password acceptable: at least 10 characters, not one of the passwords people
 * reach for first (attackers try those first too), and not built from your own name or email.
 */
const COMMON = new Set(
  `password password1 password12 password123 password1234 passw0rd p@ssword p@ssw0rd 1234567890 0123456789 12345678910 123456789a
  qwertyuiop qwerty1234 qwerty12345 1q2w3e4r5t 1qaz2wsx3edc qazwsxedc azertyuiop asdfghjkl zxcvbnm123 iloveyou123 letmein123
  welcome123 welcome1234 administrator admin12345 changeme123 abcdefghij abc1234567 aaaaaaaaaa 1111111111 0000000000 football123
  springbok springboks southafrica capetown123 johannesburg pretoria123 durban1234 baseball123 sunshine123 princess123 monkey1234
  dragon1234 master1234 superman123 trustno1234 starwars123 computer123 internet123 whatever123 freedom123 shadow1234 michael123
  jennifer123 jordan2323 hunter1234 batman1234 secret1234 summer2024 summer2025 summer2026 winter2024 winter2025 winter2026
  spring2025 spring2026 october2026 november2026 december2026 january2026 shap123456 shapshap12 construction openworks1`.split(/\s+/),
);

export const MIN_PASSWORD = 10;

/** Why this password won't do, or null if it's fine. */
export function passwordProblem(password: string, who: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters`;
  if (password.length > 200) return 'At most 200 characters';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(0123456789|1234567890|9876543210)+$/.test(password)) {
    return 'That’s one of the first passwords anyone would guess. Try a few unrelated words together.';
  }
  // Their name, each part of it, and the letters of their email address before the @.
  const local = ((who.email ?? '').split('@')[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const name = (who.name ?? '').toLowerCase();
  const names = [...name.split(/[^a-z]+/), name.replace(/[^a-z]/g, ''), local].filter((n) => n.length >= 4);
  const letters = lower.replace(/[^a-z]/g, '');
  if (names.some((n) => letters.startsWith(n) || (lower.includes(n) && lower.length < n.length + 6))) {
    return 'Leave your name and email out of it: they’re the first things someone would try.';
  }
  return null;
}
