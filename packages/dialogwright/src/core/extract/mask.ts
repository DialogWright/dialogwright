export function matchesMask(value: string, mask: RegExp): boolean {
  return mask.test(value);
}
