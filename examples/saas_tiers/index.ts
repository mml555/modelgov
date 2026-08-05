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

const userId = process.env.DEMO_USER_ID ?? "demo-user-1";
const userType = process.env.DEMO_USER_TYPE ?? "free_user";
const prompt = process.argv.slice(2).join(" ") || "What can I do on the free plan?";

async function main(): Promise<void> {
  if (!process.env.MODELGOV_API_KEY) {
    throw new Error("MODELGOV_API_KEY is required");
  }

  console.log(`\n→ SaaS tier demo: user=${userId} type=${userType}`);
  console.log(`  prompt: ${prompt}\n`);

  const preview = await client.explain({
    userId,
    userType: userType as never,
    feature: "support_chat" as never,
    modelClass: "standard" as never,
  });
  console.log("Policy preview (standard model):");
  console.log(preview.summary);
  console.log();

  try {
    const res = await client.chat({
      userId,
      userType: userType as never,
      feature: "support_chat" as never,
      modelClass: "cheap" as never,
      messages: [
        { role: "system", content: "You are a helpful SaaS assistant. Be concise." },
        { role: "user", content: prompt },
      ],
    });

    console.log(`assistant: ${res.message.content}`);
    console.log(`\n  model: ${res.model} (${res.decision})`);
    console.log(`  budget remaining today: ${usd(res.budgetRemaining.userDailyUsd)}`);
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      console.error(`⛔ policy blocked: ${JSON.stringify(err.body)}`);
    } else {
      throw err;
    }
  }
}

// This example needs ITS OWN policy loaded into the gateway (README step 1) — the
// default modelgov.yaml has no `free_user`/`paid_user` tier. Skipping that step is
// the likeliest first run, so answer it with the fix rather than a stack trace.
void main().catch((err: unknown) => {
  process.exitCode = 1;
  if (
    err instanceof ModelgovError &&
    (err.code === "unknown_user_type" || err.code === "unknown_feature")
  ) {
    console.error(`⛔ ${err.message}`);
    console.error(
      "\n   The running gateway's policy doesn't define this tier. This example\n" +
        "   ships its own policy — point the stack at it first (README step 1):\n\n" +
        "     export MODELGOV_CONFIG=examples/saas_tiers/modelgov.yaml\n" +
        "     ./setup\n",
    );
    return;
  }
  console.error("request failed:", err);
});
