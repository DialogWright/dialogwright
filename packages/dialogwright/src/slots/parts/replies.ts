/** A button's words as a chat shows them (SlotSpec.replies): the first letter a capital ("a light clean" -> "A light clean"). */
export function capitalized(words: string): string {
  const trimmed = words.trim();
  return trimmed === '' ? trimmed : trimmed[0]!.toLocaleUpperCase() + trimmed.slice(1);
}
