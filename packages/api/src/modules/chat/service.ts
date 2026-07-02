import { prepareChatCall, executeSyncChat } from "./pipeline";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";

export async function handleChat(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<ChatResult> {
  const prep = await prepareChatCall(deps, body, {});
  if (prep.ok !== true) return prep;
  return executeSyncChat(deps, prep.prepared);
}
