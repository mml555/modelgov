import { describe, expect, it } from "vitest";
import { parseExtraction } from "../src/extract.js";

describe("parseExtraction", () => {
  it("parses a clean JSON object", () => {
    const out = parseExtraction('{"vendor":"Northwind Cafe","total":14.85}');
    expect(out).toEqual({ vendor: "Northwind Cafe", total: 14.85 });
  });

  it("extracts JSON embedded in prose / code fences", () => {
    const raw = "Here is the data:\n```json\n{\"total\": 14.85, \"currency\": \"USD\"}\n```\nDone.";
    expect(parseExtraction(raw)).toEqual({ total: 14.85, currency: "USD" });
  });

  it("returns null when there is no JSON object", () => {
    expect(parseExtraction("I could not read the document.")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseExtraction("{ vendor: Northwind, }")).toBeNull();
  });

  it("handles nested line_items arrays", () => {
    const raw = '{"total":14.85,"line_items":[{"description":"Cappuccino","amount":8.0}]}';
    const out = parseExtraction(raw);
    expect(Array.isArray((out as { line_items?: unknown[] }).line_items)).toBe(true);
  });
});
