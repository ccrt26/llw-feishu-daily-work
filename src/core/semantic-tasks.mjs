import {invokeIntentRouter} from "./intent-router-client.mjs";
import {invokeCodex} from "../codex-client.mjs";
import {invokeInvoiceDecision} from "../capabilities/invoice/decision-client.mjs";
import {invokeDeepSeek} from "../ai/deepseek-client.mjs";

export function createRouterTextTask({invoke=invokeIntentRouter,invokeDeepSeekClient=invokeDeepSeek,deepseekEnabled=false,...configuration}) {
  const {deepseekModel,deepseekKeychainService,deepseekKeychainAccount,...codexConfiguration}=configuration;
  const fixed=structuredClone(codexConfiguration);
  const deepseek=structuredClone({model:deepseekModel,keychainService:deepseekKeychainService,keychainAccount:deepseekKeychainAccount,skillRoot:configuration.skillRoot});
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.capabilities)) throw new Error("invalid_router_text_input");
    const {model="codex",...taskInput}=input;
    if (model==="deepseek") {
      if (!deepseekEnabled) throw new Error("deepseek_disabled");
      return invokeDeepSeekClient({task:"router.text",...deepseek,input:taskInput});
    }
    if (model!=="codex") throw new Error("invalid_task_model");
    return invoke({...fixed,input:taskInput});
  };
}

export function createDailyWorkInterpretTask({invoke=invokeCodex,invokeDeepSeekClient=invokeDeepSeek,deepseekEnabled=false,...configuration}) {
  const {deepseekModel,deepseekKeychainService,deepseekKeychainAccount,...codexConfiguration}=configuration;
  const fixed=structuredClone(codexConfiguration);
  const deepseek=structuredClone({model:deepseekModel,keychainService:deepseekKeychainService,keychainAccount:deepseekKeychainAccount,skillRoot:configuration.skillRoot});
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.candidates)) throw new Error("invalid_daily_work_interpret_input");
    const {model="codex",...taskInput}=input;
    if (model==="deepseek") {
      if (!deepseekEnabled) throw new Error("deepseek_disabled");
      return invokeDeepSeekClient({task:"daily-work.interpret",...deepseek,input:taskInput});
    }
    if (model!=="codex") throw new Error("invalid_task_model");
    return invoke({...fixed,...taskInput});
  };
}

export function createInvoiceVisualTask({invoke=invokeInvoiceDecision,...configuration}) {
  const fixed=structuredClone(configuration);
  return async input=>{
    if (!input||typeof input!=="object"||!input.analysisInput) throw new Error("invalid_invoice_visual_input");
    return invoke({...fixed,...input});
  };
}
