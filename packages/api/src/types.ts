// API-local shared types.

/** A text segment of a multimodal message. */
export interface TextPart {
  type: "text";
  text: string;
}

/**
 * An image segment of a multimodal message. `url` is an http(s) URL or a
 * `data:` URI (base64). Shape matches the OpenAI-compatible content-part schema,
 * so it passes straight through LiteLLM to a vision model.
 */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
}

export type ContentPart = TextPart | ImagePart;

/** Message content is either a plain string or an ordered list of parts. */
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: MessageContent;
}

/**
 * The human-readable text of a message — the whole string, or the concatenated
 * text parts (image parts contribute nothing). Used wherever safety needs to
 * screen text (PII, prompt injection); image parts are never sent to those
 * text-only backends.
 */
export function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
