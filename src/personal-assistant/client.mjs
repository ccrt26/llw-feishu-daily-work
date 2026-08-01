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
    const allowSourceRead=options.allowSourceRead===true;
    try {
      const decision=adaptProviderResult({
        provider:model,
        raw:await provider(
          structuredClone(context),
          {
            workspaceDir:options.workspaceDir,
            imageFiles:[...(options.imageFiles||[])],
            modelImageFiles:structuredClone(
              options.modelImageFiles||[]
            ),
            allowSourceRead
          }
        ),
        availableSources:context.sources||[],
        allowSourceRead
      });
      if (decision.kind==="tool") {
        decision.toolCall=validateToolCall(decision.toolCall);
      }
      return decision;
    } catch (error) {
      if (error?.message==="tool_call_invalid"||
          error?.message==="provider_result_invalid"||
          new Set([
            "assistant_timeout",
            "assistant_process_failed",
            "assistant_result_invalid",
            "pdf_prepare_failed"
          ]).has(error?.message)) throw error;
      throw new Error("assistant_model_failed");
    }
  }
}
