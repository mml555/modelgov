import {
  createModelgovClient,
  PolicyBlockedError,
} from "@modelgov/sdk";

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
    console.log(`  budget remaining today: $${res.budgetRemaining.userDailyUsd}`);
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      console.error(`⛔ policy blocked: ${JSON.stringify(err.body)}`);
    } else {
      throw err;
    }
  }
}

void main();
