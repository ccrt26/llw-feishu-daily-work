import {invokeIntentRouter} from "./intent-router-client.mjs";
import {invokeCodex} from "../codex-client.mjs";
import {invokeInvoiceDecision} from "../capabilities/invoice/decision-client.mjs";
import {invokeDeepSeek} from "../ai/deepseek-client.mjs";
import {guardAiInput} from "../ai/ai-input-guard.mjs";
import {validatePreparedVisual} from "./prepared-visual.mjs";

export function createRouterTextTask({invoke=invokeIntentRouter,invokeDeepSeekClient=invokeDeepSeek,deepseekEnabled=false,...configuration}) {
  const {deepseekModel,deepseekKeychainService,deepseekKeychainAccount,...codexConfiguration}=configuration;
  const fixed=structuredClone(codexConfiguration);
  const deepseek=structuredClone({model:deepseekModel,keychainService:deepseekKeychainService,keychainAccount:deepseekKeychainAccount,skillRoot:configuration.skillRoot});
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.capabilities)) throw new Error("invalid_router_text_input");
    const {model="codex",...taskInput}=input;
    guardAiInput("router.text",taskInput);
    if (model==="deepseek") {
      if (!deepseekEnabled) throw new Error("deepseek_disabled");
      return invokeDeepSeekClient({task:"router.text",...deepseek,input:taskInput});
    }
    if (model!=="codex") throw new Error("invalid_task_model");
    return invoke({...fixed,input:taskInput});
  };
}

export function createRouterVisualTask({invoke=invokeIntentRouter,...configuration}) {
  const fixed=structuredClone(configuration);
  return async input=>{
    if (!validVisualInput(input)) throw new Error("invalid_router_visual_input");
    if (input.model!=="codex") throw new Error("invalid_task_model");
    return invoke({
      ...fixed,
      input:{
        message:{type:input.preparedVisual.resourceType,beijingTime:input.beijingTime},
        conversation:null,
        capabilities:structuredClone(input.capabilities)
      },
      imageFiles:[...input.preparedVisual.analysisInput.pageImages]
    });
  };
}

export function createDailyWorkInterpretTask({invoke=invokeCodex,invokeDeepSeekClient=invokeDeepSeek,deepseekEnabled=false,...configuration}) {
  const {deepseekModel,deepseekKeychainService,deepseekKeychainAccount,...codexConfiguration}=configuration;
  const fixed=structuredClone(codexConfiguration);
  const deepseek=structuredClone({model:deepseekModel,keychainService:deepseekKeychainService,keychainAccount:deepseekKeychainAccount,skillRoot:configuration.skillRoot});
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.candidates)) throw new Error("invalid_daily_work_interpret_input");
    const {model="codex",...taskInput}=input;
    guardAiInput("daily-work.interpret",taskInput);
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

function validVisualInput(input) {
  if (!input||typeof input!=="object"||input.model!=="codex"||typeof input.beijingTime!=="string"||
      !input.beijingTime||!Array.isArray(input.capabilities)) return false;
  try {
    validatePreparedVisual(input.preparedVisual);
    return input.capabilities.every(contract=>Array.isArray(contract?.accepts)&&contract.accepts.includes(input.preparedVisual.resourceType));
  } catch { return false; }
}
