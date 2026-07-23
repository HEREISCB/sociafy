/* Shared word-boundary truncation: never chop mid-word (reads as a rendering
   bug), always ends with an ellipsis when actually cut. */
export function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1); // room for the ellipsis char
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.3 ? cut.slice(0, lastSpace) : cut}…`;
}
