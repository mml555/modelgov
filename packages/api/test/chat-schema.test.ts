import { describe, expect, it } from "vitest";
import { messageSchema } from "../src/modules/chat/schemas";

/** SSRF guard: image_url.url is dereferenced by the upstream vision backend, so
 *  only inlined data: URIs and public https: URLs are accepted — never an
 *  arbitrary http(s) URL pointing at an internal address. */
describe("chat message schema image_url guard", () => {
  const withImage = (url: string) => ({
    role: "user",
    content: [{ type: "image_url", image_url: { url } }],
  });

  it("accepts a data: URI", () => {
    expect(messageSchema.safeParse(withImage("data:image/png;base64,AAAA")).success).toBe(true);
  });

  it("accepts an https: URL", () => {
    expect(messageSchema.safeParse(withImage("https://cdn.example.com/a.png")).success).toBe(true);
  });

  it("rejects an http: URL (cleartext / SSRF surface)", () => {
    expect(messageSchema.safeParse(withImage("http://cdn.example.com/a.png")).success).toBe(false);
  });

  it("rejects an internal metadata-service URL", () => {
    expect(messageSchema.safeParse(withImage("http://169.254.169.254/latest/meta-data/")).success).toBe(false);
  });

  it("rejects a file: URL", () => {
    expect(messageSchema.safeParse(withImage("file:///etc/passwd")).success).toBe(false);
  });
});
