import {invokeIntentRouter} from "./intent-router-client.mjs";
import {invokeCodex} from "../codex-client.mjs";
import {invokeInvoiceDecision} from "../capabilities/invoice/decision-client.mjs";

export function createRouterTextTask({invoke=invokeIntentRouter,...configuration}) {
  const fixed=structuredClone(configuration);
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.capabilities)) throw new Error("invalid_router_text_input");
    return invoke({...fixed,input});
  };
}

export function createDailyWorkInterpretTask({invoke=invokeCodex,...configuration}) {
  const fixed=structuredClone(configuration);
  return async input=>{
    if (!input||typeof input!=="object"||!input.message||!Array.isArray(input.candidates)) throw new Error("invalid_daily_work_interpret_input");
    return invoke({...fixed,...input});
  };
}

export function createInvoiceVisualTask({invoke=invokeInvoiceDecision,...configuration}) {
  const fixed=structuredClone(configuration);
  return async input=>{
    if (!input||typeof input!=="object"||!input.analysisInput) throw new Error("invalid_invoice_visual_input");
    return invoke({...fixed,...input});
  };
}
