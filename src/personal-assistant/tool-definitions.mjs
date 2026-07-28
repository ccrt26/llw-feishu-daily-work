const string=(maxLength,minLength=1)=>({
  type:"string",minLength,maxLength
});
const stringArray=(maxItems,maxLength)=>({
  type:"array",maxItems,items:string(maxLength)
});
const sourceId=()=>({
  type:"string",pattern:"^source-00[1-8]$"
});
const sourceIds=()=>({
  type:"array",maxItems:8,uniqueItems:true,items:sourceId()
});

const definitions={
  record_daily_work:{
    name:"record_daily_work",
    description:"记录新的每日工作事实，或补充一个明确且唯一的既有工作记录。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["operation","targetRecordId","records"],
      properties:{
        operation:{type:"string",enum:["create","supplement"]},
        targetRecordId:string(128,0),
        records:{
          type:"array",minItems:1,maxItems:20,
          items:{
            type:"object",additionalProperties:false,
            required:[
              "occurred_date","occurred_time","occurred_end_time","title",
              "people","location","summary","follow_ups","original_text"
            ],
            properties:{
              occurred_date:{type:"string",pattern:"^\\d{4}-\\d{2}-\\d{2}$"},
              occurred_time:string(5,0),
              occurred_end_time:string(5,0),
              title:string(200),
              people:stringArray(50,200),
              location:string(500,0),
              summary:string(4_000),
              follow_ups:stringArray(50,1000),
              original_text:string(12_000)
            }
          }
        }
      }
    }
  },
  archive_dining_invoice:{
    name:"archive_dining_invoice",
    description:"批量归档当前来源中的一至八张餐饮发票；每项必须绑定一个当前 sourceId。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["items"],
      properties:{
        items:{
          type:"array",minItems:1,maxItems:8,
          uniqueItems:true,"x-unique-by":"sourceId",
          items:{
            type:"object",additionalProperties:false,
            required:["sourceId","extraction"],
            properties:{
              sourceId:sourceId(),
              extraction:{
                type:"object",additionalProperties:false,
                required:["invoice","field_quality","category","document_verification"],
                properties:{
                  invoice:invoiceFields(string(500,0)),
                  field_quality:invoiceFields({
                    type:"string",enum:["clear","missing","unclear"]
                  }),
                  category:{type:"string",enum:["dining","non_dining","uncertain"]},
                  document_verification:{
                    type:"string",
                    enum:["single_invoice","multiple_invoices","conflicting_fields","unclear"]
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  save_knowledge:{
    name:"save_knowledge",
    description:"把当前程序绑定的完整来源保存为一个新的知识项。",
    parameters:{
      type:"object",additionalProperties:false,
      required:[
        "libraryKey","folderSegments","title","summary","tags","sourceIds",
        "knowledgeSections"
      ],
      properties:{
        libraryKey:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,63}$"},
        folderSegments:stringArray(5,64),
        title:string(200),
        summary:string(2_000),
        tags:stringArray(20,64),
        sourceIds:sourceIds(),
        knowledgeSections:{
          type:"object",additionalProperties:false,
          required:[
            "keyFacts","structureAndMainContent","reusableContent",
            "sourceNotes","contentIndex"
          ],
          properties:{
            keyFacts:{
              type:"array",minItems:1,maxItems:50,items:string(1000)
            },
            structureAndMainContent:string(16_000),
            reusableContent:stringArray(50,1000),
            sourceNotes:string(4_000),
            contentIndex:string(16_000)
          }
        }
      }
    }
  },
  create_document:{
    name:"create_document",
    description:"根据当前已确认内容生成一个 DOCX、PPTX 或 XLSX 文件。",
    parameters:{
      type:"object",additionalProperties:false,
      required:["sourceIds","format","title","content"],
      properties:{
        sourceIds:sourceIds(),
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
    if (schema.uniqueItems&&
        new Set(value.map(stableJson)).size!==value.length) reject();
    if (schema["x-unique-by"]) {
      const field=schema["x-unique-by"];
      if (new Set(value.map(item=>item?.[field])).size!==value.length) reject();
    }
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value&&typeof value==="object") {
    return `{${Object.keys(value).sort().map(key=>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value||typeof value!=="object"||Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function invoiceFields(fieldSchema) {
  const names=[
    "invoice_number","issue_date","buyer_name","buyer_tax_id",
    "seller_name","item_name","total_with_tax"
  ];
  return {
    type:"object",additionalProperties:false,required:names,
    properties:Object.fromEntries(names.map(name=>[name,fieldSchema]))
  };
}

function reject() {
  throw new Error("tool_call_invalid");
}
