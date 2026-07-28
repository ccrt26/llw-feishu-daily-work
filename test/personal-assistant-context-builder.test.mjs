import test from "node:test";
import assert from "node:assert/strict";
import {buildAgentTurnContext} from "../src/personal-assistant/context-builder.mjs";

const sources=[
  {
    handle:{
      sourceId:"source-001",displayName:"方案.docx",
      mediaClass:"document",format:"docx",
      relativePath:"source-001.docx",byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    },
    absolutePath:"/private/llw-turn/source-001.docx",
    sourceAttachmentId:"file_private",
    sourceBytes:Buffer.from("private")
  },
  {
    handle:{
      sourceId:"source-002",displayName:"附件.pdf",
      mediaClass:"document",format:"pdf",
      relativePath:"source-002.pdf",byteSize:200,
      sha256:"b".repeat(64),availability:"ready"
    },
    absolutePath:"/private/llw-turn/source-002.pdf"
  }
];

test("joins the user instruction and all model-safe source projections",() => {
  const context=buildAgentTurnContext({
    message:{
      source:"feishu",receivedAt:"2026-07-28T00:00:00.000Z",
      instructionText:"比较两个文件，只总结，不保存",attachments:[{},{}]
    },
    sources,
    conversation:null,
    personalRules:["餐饮发票默认归档"],
    model:"codex",
    toolDeclarations:[{name:"save_knowledge"}]
  });
  assert.equal(context.instructionText,"比较两个文件，只总结，不保存");
  assert.deepEqual(
    context.sources.map(source=>source.sourceId),
    ["source-001","source-002"]
  );
  assert.deepEqual(context.priority,[
    "program_safety","current_instruction","confirmed_personal_rules",
    "source_facts","weak_metadata"
  ]);
  const serialized=JSON.stringify(context);
  for (const forbidden of [
    "/private/llw-turn","file_private","sourceBytes","content",
    "extractionIntegrity","sourceAttachmentId"
  ]) assert.equal(serialized.includes(forbidden),false);
});

test("keeps channel identifiers, reply targets and absolute paths out of AI context",() => {
  const context=buildAgentTurnContext({
    message:{
      source:"wechat",sourceMessageId:"secret-id",userId:"secret-user",
      conversationId:"secret-chat",receivedAt:"2026-07-28T00:00:00.000Z",
      instructionText:"请总结",attachments:[],
      replyTarget:{contextToken:"secret-token"}
    },
    sources:[],conversation:null,personalRules:[],model:"codex",
    toolDeclarations:[]
  });
  const serialized=JSON.stringify(context);
  for (const secret of [
    "secret-id","secret-user","secret-chat","secret-token","/Volumes/"
  ]) assert.equal(serialized.includes(secret),false);
});
