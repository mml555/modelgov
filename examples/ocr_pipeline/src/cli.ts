import { AiGuardError } from "@ai-guard/sdk";
import { ai } from "./aiguard.js";
import { extractDocument } from "./extract.js";

/**
 * CLI: `pnpm extract <file.pdf|image>` → structured JSON per page + a governance
 * receipt (model, decision, cost, audit id) for each governed vision call.
 */
async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: pnpm extract <file.pdf | image>");
    console.error("  (no sample? run `pnpm sample` to generate one)");
    process.exit(2);
  }
  if (!process.env.AI_GUARD_API_KEY) {
    console.error("AI_GUARD_API_KEY is required (see .env.example)");
    process.exit(2);
  }

  console.log(`\n→ extracting ${input}\n`);
  let pages;
  try {
    pages = await extractDocument(ai, input);
  } catch (err) {
    if (err instanceof AiGuardError) {
      console.error(`⛔ blocked by Ai-Guard (${err.code}): ${JSON.stringify(err.body)}`);
      process.exit(1);
    }
    throw err;
  }

  for (const p of pages) {
    console.log(`── page ${p.page} ${"─".repeat(30)}`);
    if (p.fields) {
      console.log(JSON.stringify(p.fields, null, 2));
    } else {
      console.log("⚠  could not parse JSON from model output:");
      console.log(p.rawOutput.slice(0, 500));
    }
    const r = p.receipt;
    console.log(
      `\n  ocr: ${p.ocrChars} chars · ${r.model} (${r.provider}, ${r.decision}) · ` +
        `$${r.costUsd} · req ${r.requestId}\n`,
    );
  }
}

void main();
