import {
  createModelgovClient,
  ModelgovError,
  PolicyBlockedError,
} from "@modelgov/sdk";

/** Sub-cent costs need more than 2 decimals; trailing zeros trimmed so the
 *  output never shows raw float noise ("$0.000160999999..."). */
const usd = (n: number): string =>
  `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

const client = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
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
    console.log(`  cost: ${usd(res.cost.actualUsd)}`);
    console.log(`  feature budget remaining: ${usd(res.budgetRemaining.featureMonthlyUsd)}`);
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      console.error(`⛔ policy blocked: ${JSON.stringify(err.body)}`);
      console.error("   (daily extraction limit or budget cap reached)");
    } else {
      throw err;
    }
  }
}

// The default modelgov.yaml has no `document_extraction` feature — this example
// ships its own policy (README step 1). Skipping it is the likeliest first run, so
// answer it with the fix rather than a stack trace.
void main().catch((err: unknown) => {
  process.exitCode = 1;
  if (
    err instanceof ModelgovError &&
    (err.code === "unknown_feature" || err.code === "unknown_user_type")
  ) {
    console.error(`⛔ ${err.message}`);
    console.error(
      "\n   The running gateway's policy doesn't define this feature. This example\n" +
        "   ships its own policy — point the stack at it first (README step 1):\n\n" +
        "     export MODELGOV_CONFIG=examples/document_extraction/modelgov.yaml\n" +
        "     ./setup\n",
    );
    return;
  }
  console.error("request failed:", err);
});
