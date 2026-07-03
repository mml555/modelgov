import {
  createModelgovClient,
  PolicyBlockedError,
  SafetyBlockedError,
} from "@modelgov/sdk";

// End-to-end demo: a "support chat" feature calling through Modelgov.
// Run the stack first:  make setup
// Then:                 pnpm --filter support-chat-example start

const client = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3000",
  apiKey: process.env.MODELGOV_API_KEY,
});

const userId = process.env.DEMO_USER_ID ?? "demo-user-1";
const userType = process.env.DEMO_USER_TYPE ?? "logged_in";
const prompt = process.argv.slice(2).join(" ") || "How do I reset my password?";

async function main(): Promise<void> {
  if (!process.env.MODELGOV_API_KEY) {
    throw new Error("MODELGOV_API_KEY is required to call Modelgov");
  }

  console.log(`\n→ feature=support_chat user=${userId} (${userType})`);
  console.log(`  prompt: ${prompt}\n`);

  try {
    const res = await client.chat({
      userId,
      userType,
      feature: "support_chat",
      modelClass: "cheap",
      messages: [
        { role: "system", content: "You are a concise customer-support assistant." },
        { role: "user", content: prompt },
      ],
    });

    console.log(`assistant: ${res.message.content}`);
    console.log(`\n  model:    ${res.model} (decision: ${res.decision})`);
    console.log(
      `  cost:     est $${res.cost.estimatedUsd} / actual $${res.cost.actualUsd}`,
    );
    console.log(
      `  budget:   user-daily $${res.budgetRemaining.userDailyUsd} remaining`,
    );
    console.log(
      `  safety:   piiMasked=${res.safety.piiMasked} injectionBlocked=${res.safety.injectionBlocked}`,
    );
  } catch (err) {
    if (err instanceof SafetyBlockedError) {
      console.error(`⛔ safety blocked: ${JSON.stringify(err.body)}`);
    } else if (err instanceof PolicyBlockedError) {
      console.error(`⛔ policy blocked: ${JSON.stringify(err.body)}`);
      console.error(`   (try again after the daily limit resets, or use a different userType)`);
    } else {
      console.error("request failed:", err);
      process.exitCode = 1;
    }
  }
}

void main();
