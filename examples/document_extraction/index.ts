import {
  createModelgovClient,
  PolicyBlockedError,
} from "@modelgov/sdk";

const client = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3000",
  apiKey: process.env.MODELGOV_API_KEY,
});

const userId = process.env.DEMO_USER_ID ?? "workflow-runner-1";
const documentText =
  process.argv.slice(2).join(" ") ||
  "Invoice #1042 from Acme Corp. Line items: consulting $800, hosting $450. Total $1,250 due 2026-04-01.";

const extractionPrompt = `Extract JSON with keys: vendor, invoice_number, total_usd, due_date.
Return only valid JSON.

Document:
${documentText}`;

async function main(): Promise<void> {
  if (!process.env.MODELGOV_API_KEY) {
    throw new Error("MODELGOV_API_KEY is required");
  }

  console.log("\n→ document_extraction workflow");
  console.log(`  user: ${userId} (workflow)\n`);

  const preview = await client.explain({
    userId,
    userType: "workflow" as never,
    feature: "document_extraction" as never,
    modelClass: "standard" as never,
    inputTokensEstimate: 800,
  });
  console.log("Policy preview:");
  console.log(preview.summary);
  console.log();

  try {
    const res = await client.chat({
      userId,
      userType: "workflow" as never,
      feature: "document_extraction" as never,
      modelClass: "standard" as never,
      inputTokensEstimate: 800,
      messages: [
        {
          role: "system",
          content: "You extract structured data from documents. Output JSON only.",
        },
        { role: "user", content: extractionPrompt },
      ],
      temperature: 0,
    });

    console.log(`extracted:\n${res.message.content}`);
    console.log(`\n  model: ${res.model} (${res.decision})`);
    console.log(`  cost: $${res.cost.actualUsd}`);
    console.log(`  feature budget remaining: $${res.budgetRemaining.featureMonthlyUsd}`);
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      console.error(`⛔ policy blocked: ${JSON.stringify(err.body)}`);
      console.error("   (daily extraction limit or budget cap reached)");
    } else {
      throw err;
    }
  }
}

void main();
