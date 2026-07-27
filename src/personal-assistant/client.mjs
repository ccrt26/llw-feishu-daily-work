import {adaptProviderResult} from "./provider-adapter.mjs";
import {validateToolCall} from "./tool-definitions.mjs";

export class PersonalAssistantClient {
  constructor({codex,deepseek}) {
    if (typeof codex!=="function"||typeof deepseek!=="function") {
      throw new Error("assistant_client_invalid");
    }
    this.providers={codex,deepseek};
  }

  async decide(context,options={}) {
    const model=context?.model;
    const provider=this.providers[model];
    if (!provider) throw new Error("assistant_model_unsupported");
    try {
      const decision=adaptProviderResult({
        provider:model,
        raw:await provider(
          structuredClone(context),
          {imageFiles:[...(options.imageFiles||[])]}
        )
      });
      if (decision.kind==="tool") {
        decision.toolCall=validateToolCall(decision.toolCall);
      }
      return decision;
    } catch (error) {
      if (error?.message==="tool_call_invalid"||
          error?.message==="provider_result_invalid") throw error;
      throw new Error("assistant_model_failed");
    }
  }
}
