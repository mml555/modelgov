import { prepareChatCall, executeSyncChat } from "./pipeline";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";

export async function handleChatHierarchical(
  deps: ChatServiceDeps,
  body: ChatInput,
  leafNodeId: string,
): Promise<ChatResult> {
  const prep = await prepareChatCall(deps, body, { leafNodeId });
  if (prep.ok !== true) return prep;
  return executeSyncChat(deps, prep.prepared);
}
