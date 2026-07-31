const SOURCE_ID_PATTERN="^source-00[1-8]$";
const TOOL_NAME_PATTERN="^[a-z][a-z0-9_]{0,63}$";
const ENVELOPE_KEYS=[
  "type","reply","ask","sourceReadRequest","toolCall","taskUpdate"
];

export function buildPersonalAssistantOutputSchema(
  tools,{allowSourceRead=false}={}
) {
  validateTools(tools);
  if (typeof allowSourceRead!=="boolean") {
    throw new Error("assistant_output_schema_invalid");
  }
  const toolNames=tools.map(tool=>tool.name);
  const sourceReadRequestSchema=nullable(strictObject({
    requests:{
      type:"array",minItems:1,maxItems:8,
      items:strictObject({
        sourceId:{type:"string",pattern:SOURCE_ID_PATTERN},
        view:{
          type:"string",
          enum:[
            "probe_media","read_existing_subtitles","transcribe_audio",
            "build_navigation_overview","inspect_time_range"
          ]
        },
        startMs:nullable({type:"integer",minimum:0}),
        endMs:nullable({type:"integer",minimum:1})
      })
    }
  }));
  return {
    type:"object",
    additionalProperties:false,
    required:ENVELOPE_KEYS,
    properties:{
      type:{
        type:"string",
        enum:[
          "reply","ask",
          ...(allowSourceRead?["source_read_request"]:[]),
          ...(toolNames.length?["tool_call"]:[])
        ]
      },
      reply:nullable(strictObject({
        text:{type:"string",minLength:1,maxLength:32_000}
      })),
      ask:nullable(strictObject({
        question:{type:"string",minLength:1,maxLength:1_000},
        waitingType:{
          type:"string",
          enum:["waiting_answer","waiting_file","waiting_confirmation"]
        },
        preparedTool:nullable(
          toolNames.length
            ?{type:"string",enum:toolNames}
            :{type:"string",pattern:TOOL_NAME_PATTERN}
        ),
        preparedRule:nullable({
          type:"string",minLength:1,maxLength:1_000
        })
      })),
      sourceReadRequest:allowSourceRead
        ?sourceReadRequestSchema
        :{type:"null"},
      toolCall:toolNames.length
        ?{
          anyOf:[
            {type:"null"},
            ...tools.map(tool=>strictObject({
              toolName:{type:"string",const:tool.name},
              arguments:strictifySchema(tool.parameters)
            }))
          ]
        }
        :{type:"null"},
      taskUpdate:nullable(strictObject({
        workingSummary:{type:"string",maxLength:8_000},
        confirmedRequirements:stringList(20,1_000),
        rejectedDirections:stringList(20,1_000)
      }))
    }
  };
}

export function decodePersonalAssistantOutputEnvelopeForTools(
  value,tools,{allowSourceRead=false}={}
) {
  validateTools(tools);
  if (typeof allowSourceRead!=="boolean") reject();
  const decoded=decodeWithoutToolArguments(value,{allowSourceRead});
  if (decoded.type!=="tool_call") return decoded;
  const tool=tools.find(item=>item.name===decoded.toolName);
  if (!tool) reject();
  return {
    ...decoded,
    arguments:removeOptionalNulls(decoded.arguments,tool.parameters)
  };
}

function decodeWithoutToolArguments(value,{allowSourceRead}) {
  if (!exactObject(value,ENVELOPE_KEYS)||
      !new Set([
        "reply","ask","source_read_request","tool_call"
      ]).has(value.type)) reject();
  const payloads={
    reply:value.reply,
    ask:value.ask,
    source_read_request:value.sourceReadRequest,
    tool_call:value.toolCall
  };
  if (Object.entries(payloads).some(([type,payload])=>
    type===value.type?payload===null:payload!==null
  )) reject();
  const taskUpdate=value.taskUpdate===null?{}:{taskUpdate:value.taskUpdate};
  if (value.type==="reply") {
    if (!exactObject(value.reply,["text"])) reject();
    return {type:"reply",text:value.reply.text,...taskUpdate};
  }
  if (value.type==="ask") {
    if (!exactObject(value.ask,[
      "question","waitingType","preparedTool","preparedRule"
    ])) reject();
    return {
      type:"ask",
      question:value.ask.question,
      waitingType:value.ask.waitingType,
      preparedTool:value.ask.preparedTool,
      preparedRule:value.ask.preparedRule,
      ...taskUpdate
    };
  }
  if (value.type==="source_read_request") {
    if (!allowSourceRead||
        value.taskUpdate!==null||
        !exactObject(value.sourceReadRequest,["requests"])||
        !Array.isArray(value.sourceReadRequest.requests)) reject();
    return {
      type:"source_read_request",
      requests:value.sourceReadRequest.requests.map(request=>{
        if (!exactObject(request,[
          "sourceId","view","startMs","endMs"
        ])) reject();
        if (request.view==="inspect_time_range") {
          if (!Number.isSafeInteger(request.startMs)||
              !Number.isSafeInteger(request.endMs)) reject();
          return {
            sourceId:request.sourceId,view:request.view,
            startMs:request.startMs,endMs:request.endMs
          };
        }
        if (request.startMs!==null||request.endMs!==null) reject();
        return {sourceId:request.sourceId,view:request.view};
      })
    };
  }
  if (!exactObject(value.toolCall,["toolName","arguments"])) reject();
  return {
    type:"tool_call",
    toolName:value.toolCall.toolName,
    arguments:value.toolCall.arguments,
    ...taskUpdate
  };
}

function validateTools(tools) {
  if (!Array.isArray(tools)||tools.some(tool=>
    !tool||typeof tool!=="object"||Array.isArray(tool)||
    typeof tool.name!=="string"||
    !new RegExp(TOOL_NAME_PATTERN,"u").test(tool.name)||
    !tool.parameters||typeof tool.parameters!=="object"||
    Array.isArray(tool.parameters)
  )||new Set(tools.map(tool=>tool.name)).size!==tools.length) {
    throw new Error("assistant_output_schema_invalid");
  }
}

function strictifySchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictifySchema);
  if (!schema||typeof schema!=="object") return schema;
  const clean=Object.fromEntries(
    Object.entries(schema)
      .filter(([key])=>!key.startsWith("x-")&&key!=="uniqueItems")
      .map(([key,item])=>[key,strictifySchema(item)])
  );
  if (clean.type==="object") {
    const properties=clean.properties??{};
    const originallyRequired=new Set(clean.required??[]);
    clean.properties=Object.fromEntries(
      Object.entries(properties).map(([key,item])=>[
        key,
        originallyRequired.has(key)?item:nullable(item)
      ])
    );
    clean.required=Object.keys(properties);
    clean.additionalProperties=false;
  }
  return clean;
}

function removeOptionalNulls(value,schema) {
  if (Array.isArray(value)) {
    return value.map(item=>removeOptionalNulls(item,schema?.items));
  }
  if (!value||typeof value!=="object"||!schema||schema.type!=="object") {
    return value;
  }
  const required=new Set(schema.required??[]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key,item])=>item!==null||required.has(key))
      .map(([key,item])=>[
        key,removeOptionalNulls(item,schema.properties?.[key])
      ])
  );
}

function strictObject(properties) {
  return {
    type:"object",additionalProperties:false,
    required:Object.keys(properties),properties
  };
}

function nullable(schema) {
  return {anyOf:[schema,{type:"null"}]};
}

function stringList(maxItems,maxLength) {
  return {
    type:"array",maxItems,
    items:{type:"string",minLength:1,maxLength}
  };
}

function exactObject(value,keys) {
  return Boolean(
    value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&
    Object.keys(value).every(key=>keys.includes(key))
  );
}

function reject() {
  throw new Error("assistant_output_invalid");
}
