import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunk.js";
import { toVector } from "../src/store.js";

describe("toVector", () => {
  it("formats an embedding as a pgvector literal", () => {
    expect(toVector([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
    expect(toVector([])).toBe("[]");
  });
});

describe("chunkMarkdown", () => {
  it("splits by H2 heading and prepends the heading to each chunk", () => {
    const md = "# Title\n\n## Refunds\nRefunds take 5 days.\n\n## Support\nWe are open 9-5.";
    const chunks = chunkMarkdown("doc.md", md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.source).toBe("doc.md#Refunds");
    expect(chunks[0]?.text).toContain("Refunds");
    expect(chunks[0]?.text).toContain("5 days");
    // The H1 title is not emitted as its own chunk.
    expect(chunks.some((c) => c.text.startsWith("Title"))).toBe(false);
  });

  it("packs paragraphs without exceeding maxChars", () => {
    const md = "## S\n" + "a".repeat(300) + "\n\n" + "b".repeat(300) + "\n\n" + "c".repeat(300);
    const chunks = chunkMarkdown("d.md", md, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400 + "S\n".length);
  });
});
