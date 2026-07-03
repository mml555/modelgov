import { createModelgovClient } from "@modelgov/sdk";

// One shared client. Point MODELGOV_URL at your Modelgov gateway.
export const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
  apiKey: process.env.MODELGOV_API_KEY,
});
