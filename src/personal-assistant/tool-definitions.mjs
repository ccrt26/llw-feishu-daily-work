const string=(maxLength,minLength=1)=>({
  type:"string",minLength,maxLength
});
const stringArray=(maxItems,maxLength)=>({
  type:"array",maxItems,items:string(maxLength)
});

const definitions={
  record_daily_work:{
    name:"record_daily_work",
    description:"记录新的每日工作事实，或补充一个明确且唯一的既有工作记录。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["operation","records"],
      properties:{
        operation:{type:"string",enum:["create","supplement"]},
        records:{
          type:"array",minItems:1,maxItems:20,
          items:{
            type:"object",additionalProperties:false,
            required:["originalText","title","date","summary"],
            properties:{
              originalText:string(12_000),
              title:string(200),
              date:{type:"string",pattern:"^\\d{4}-\\d{2}-\\d{2}$"},
              summary:string(4_000),
              targetRecordId:string(128,0)
            }
          }
        }
      }
    }
  },
  archive_dining_invoice:{
    name:"archive_dining_invoice",
    description:"归档当前已安全准备的一张餐饮发票；当前来源由程序自动绑定。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["extraction"],
      properties:{
        extraction:{
          type:"object",additionalProperties:false,
          required:["invoiceNumber","invoiceDate","buyerName","buyerTaxId","sellerName","totalAmount","itemSummary"],
          properties:Object.fromEntries([
            "invoiceNumber","invoiceDate","buyerName","buyerTaxId",
            "sellerName","totalAmount","itemSummary"
          ].map(key=>[key,string(500,0)]))
        }
      }
    }
  },
  save_knowledge:{
    name:"save_knowledge",
    description:"把当前程序绑定的完整来源保存为一个新的知识项。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["libraryKey","folderSegments","title","summary","tags","body"],
      properties:{
        libraryKey:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,63}$"},
        folderSegments:stringArray(5,64),
        title:string(200),
        summary:string(2_000),
        tags:stringArray(20,64),
        body:string(262_144)
      }
    }
  },
  create_document:{
    name:"create_document",
    description:"根据当前已确认内容生成一个 DOCX、PPTX 或 XLSX 文件。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["format","title","content"],
      properties:{
        format:{type:"string",enum:["docx","pptx","xlsx"]},
        title:string(200),
        content:string(262_144)
      }
    }
  }
};

for (const definition of Object.values(definitions)) {
  deepFreeze(definition);
}
export const TOOL_DEFINITIONS=Object.freeze(definitions);

export function getModelToolDeclarations() {
  return Object.values(TOOL_DEFINITIONS);
}

export function validateToolCall(call) {
  try {
    if (!call||typeof call!=="object"||Array.isArray(call)||
        Object.keys(call).some(key=>!new Set(["name","arguments"]).has(key))||
        typeof call.name!=="string"||
        !TOOL_DEFINITIONS[call.name]) {
      reject();
    }
    validateSchema(TOOL_DEFINITIONS[call.name].parameters,call.arguments);
    return structuredClone(call);
  } catch (error) {
    if (error?.message==="tool_call_invalid") throw error;
    reject();
  }
}

function validateSchema(schema,value) {
  if (schema.type==="object") {
    if (!value||typeof value!=="object"||Array.isArray(value)) reject();
    const keys=Object.keys(value);
    if (schema.additionalProperties===false&&
        keys.some(key=>!Object.hasOwn(schema.properties,key))) reject();
    if ((schema.required||[]).some(key=>!Object.hasOwn(value,key))) reject();
    for (const key of keys) validateSchema(schema.properties[key],value[key]);
    return;
  }
  if (schema.type==="array") {
    if (!Array.isArray(value)||
        value.length<(schema.minItems??0)||
        value.length>(schema.maxItems??Number.MAX_SAFE_INTEGER)) reject();
    for (const item of value) validateSchema(schema.items,item);
    return;
  }
  if (schema.type==="string") {
    if (typeof value!=="string"||
        [...value].length<(schema.minLength??0)||
        [...value].length>(schema.maxLength??Number.MAX_SAFE_INTEGER)||
        (schema.enum&&!schema.enum.includes(value))||
        (schema.pattern&&!new RegExp(schema.pattern,"u").test(value))) reject();
    return;
  }
  reject();
}

function deepFreeze(value) {
  if (!value||typeof value!=="object"||Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function reject() {
  throw new Error("tool_call_invalid");
}
