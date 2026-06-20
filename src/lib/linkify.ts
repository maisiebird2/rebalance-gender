const URL_REGEX = /https?:\/\/[^\s<>"]+/g;

type Segment = { type: "text" | "url"; value: string };

export function linkify(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const { index } = match;
    if (index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({ type: "url", value: match[0] });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}
