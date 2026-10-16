const TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9]{4,8}(?![A-Za-z0-9])/g;
const KEYWORD = /验证码|校验码|动态码|确认码|code|otp|passcode|pin/i;

/**
 * The one-time code in a received text, or null. Either the whole text is a code
 * (4-8 letters/digits with at least one digit), or a short message names a code and holds one.
 */
export function extractCode(text: string): string | null {
  const trimmed = text.trim();
  if (/^[A-Za-z0-9]{4,8}$/.test(trimmed) && /\d/.test(trimmed)) return trimmed;
  if (trimmed.length > 160) return null;
  const keyword = KEYWORD.exec(trimmed);
  if (!keyword) return null;
  const tokens = [...trimmed.matchAll(TOKEN)].filter((match) => /\d/.test(match[0]));
  // The code usually follows its keyword ("验证码是 482913"); otherwise it leads ("482913 is your code").
  const after = tokens.find((match) => (match.index ?? 0) > keyword.index);
  return (after ?? tokens[0])?.[0] ?? null;
}
