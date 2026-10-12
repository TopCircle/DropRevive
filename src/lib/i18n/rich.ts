/**
 * Splits a translated message at a `{name}` placeholder so the caller can render a
 * component there (a link, for example) without putting HTML in the language pack.
 * Returns the text segments around each occurrence; `parts.length - 1` placeholders.
 */
export function splitPlaceholder(message: string, name: string): string[] {
  return message.split(`{${name}}`);
}
