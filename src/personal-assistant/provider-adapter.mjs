import {validatePersonalRule} from "./personal-rules.mjs";
import {
  validateSourceReadRequest
} from "./source-read-request.mjs";
import {validateTaskUpdate} from "./task-session.mjs";

export function adaptProviderResult({
  provider,raw,availableSources=[]
}) {
  try {
    if (!new Set(["codex","deepseek"]).has(provider)||
        !raw||typeof raw!=="object"||Array.isArray(raw)) reject();
    if (provider==="codex"&&raw.type==="source_read_request"&&
        Object.keys(raw).length===2&&
        Object.hasOwn(raw,"requests")) {
      return {
        kind:"source_read",
        requests:validateSourceReadRequest({
          raw:raw.requests,availableSources
        })
      };
    }
    if ((raw.type==="reply"||raw.action==="reply")&&safeText(raw.text,32_000)) {
      return {
        kind:"reply",text:raw.text,...taskUpdateOf(raw)
      };
    }
    if ((raw.type==="ask"||raw.action==="ask")&&safeText(raw.question,1000)) {
      const waitingType=raw.waitingType??"waiting_answer";
      const preparedTool=raw.preparedTool??null;
      const preparedRule=raw.preparedRule??null;
      if (!new Set([
        "waiting_answer","waiting_file","waiting_confirmation"
      ]).has(waitingType)||
          (preparedTool!==null&&!safeName(preparedTool))||
          (preparedRule!==null&&(
            waitingType!=="waiting_confirmation"||
            preparedTool!==null
          ))) reject();
      return {
        kind:"ask",question:raw.question,waitingType,preparedTool,
        ...(preparedRule===null
          ?{}
          :{preparedRule:validatePersonalRule(preparedRule)}),
        ...taskUpdateOf(raw)
      };
    }
    if ((raw.type==="tool_call"||raw.action==="tool_call")&&
        safeName(raw.toolName||raw.name)&&
        plainObject(raw.arguments)&&
        toolEnvelopeOnly(raw)&&
        !Object.hasOwn(raw,"text")&&!Object.hasOwn(raw,"question")) {
      return {
        kind:"tool",
        toolCall:{
          name:raw.toolName||raw.name,
          arguments:structuredClone(raw.arguments)
        },
        ...taskUpdateOf(raw)
      };
    }
    reject();
  } catch (error) {
    if (error?.message==="provider_result_invalid") throw error;
    reject();
  }
}

function safeText(value,max) {
  return typeof value==="string"&&value.trim()&&Buffer.byteLength(value,"utf8")<=max;
}
function safeName(value) {
  return typeof value==="string"&&/^[a-z][a-z0-9_]{0,63}$/u.test(value);
}
function plainObject(value) {
  return value&&typeof value==="object"&&!Array.isArray(value);
}
function toolEnvelopeOnly(value) {
  return Object.keys(value).every(key=>
    new Set([
      "type","action","toolName","name","arguments","taskUpdate"
    ]).has(key)
  );
}
function taskUpdateOf(value) {
  return Object.hasOwn(value,"taskUpdate")
    ?{taskUpdate:validateTaskUpdate(value.taskUpdate)}
    :{};
}
function reject() {
  throw new Error("provider_result_invalid");
}
