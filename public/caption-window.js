export function captionWindow(text, { maxWords = 12, maxChars = 96 } = {}) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";

  let visible = words.slice(-maxWords);
  while (visible.length > 1 && visible.join(" ").length > maxChars) visible.shift();
  return visible.join(" ");
}
