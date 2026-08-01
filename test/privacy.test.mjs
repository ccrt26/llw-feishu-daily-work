import test from "node:test";
import assert from "node:assert/strict";
import {safeLog} from "../src/core/redaction.mjs";
import {
  assertContentSafe
} from "../src/personal-assistant/content-safety.mjs";
import {
  buildAgentTurnContext
} from "../src/personal-assistant/context-builder.mjs";
import {
  executeSaveKnowledge
} from "../src/personal-assistant/tools/save-knowledge.mjs";

test("safe logs contain only allowlisted scalars and a one-way correlation",() => {
  const secrets=["om_secret","ou_secret","oc_secret","img_secret","123456789012","亚信科技（成都）有限公司","成都餐厅","290.00","token-secret","票面全文"];
  const line=safeLog({stage:"archive",code:"copy_verification_failed",messageId:secrets[0],durationMs:12,sizeBytes:99,stderrBytes:2,retryCount:1,content:secrets.at(-1),invoiceNumber:secrets[4],buyer:secrets[5],seller:secrets[6],amount:secrets[7],token:secrets[8]});
  const parsed=JSON.parse(line);
  assert.equal(parsed.stage,"archive"); assert.equal(parsed.code,"copy_verification_failed");
  assert.match(parsed.correlation,/^[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(parsed).sort(),["code","correlation","durationMs","sizeBytes","stage","stderrBytes","time","retryCount"].sort());
  for (const secret of secrets) assert.equal(line.includes(secret),false);
});

test("safe startup logs retain only bounded Skill bundle metadata",()=>{
  const line=safeLog({
    stage:"startup",
    code:"personal_assistant_skill_loaded",
    fileCount:7,
    totalBytes:20_111,
    bundleSha256:"a".repeat(64),
    content:"must-not-log",
    path:"/private/skill"
  });
  const parsed=JSON.parse(line);
  assert.equal(parsed.fileCount,7);
  assert.equal(parsed.totalBytes,20_111);
  assert.equal(parsed.bundleSha256,"a".repeat(64));
  assert.equal(line.includes("must-not-log"),false);
  assert.equal(line.includes("/private/skill"),false);
});

test("content safety errors never echo rejected user content",()=>{
  const secret="Authorization: Bearer not-a-real-secret";
  let error;
  try {
    assertContentSafe({
      instructionText:secret,sources:[],conversation:null,
      limits:{maxContextBytes:512*1024}
    });
  }
  catch (caught) { error=caught; }
  assert.equal(error?.message,"content_safety_rejected");
  assert.equal(String(error).includes(secret),false);
});

test("model context never includes resource keys or entry identifiers",() => {
  const summary=JSON.stringify(buildAgentTurnContext({
    message:{
      source:"feishu",sourceMessageId:"message_secret",
      userId:"sender_secret",conversationId:"chat_secret",
      receivedAt:"2026-07-23T01:30:00.000Z",
      instructionText:"查看发票",attachments:[{
        type:"file",sourceAttachmentId:"file_secret",
        displayName:"发票.pdf",extension:"pdf"
      }]
    },
    sources:[{
      sourceId:"source-001",displayName:"发票.pdf",
      mediaClass:"document",format:"pdf",
      relativePath:"source-001.pdf",byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    }],
    personalRules:[],model:"codex",toolDeclarations:[]
  }));
  for (const value of ["event_secret","message_secret","sender_secret","chat_secret","file_secret"]) assert.equal(summary.includes(value),false);
});

test("knowledge receipts fail closed instead of returning absolute managed roots",async()=>{
  const result=await executeSaveKnowledge({
    toolCall:{
      name:"save_knowledge",
      arguments:{
        libraryKey:"work-knowledge",folderSegments:[],
        title:"交流方案",summary:"交流方案摘要。",tags:[],
        sourceIds:[],
        knowledgeSections:{
          keyFacts:["事实"],structureAndMainContent:"正文。",
          reusableContent:[],sourceNotes:"来自用户当前指令。",
          contentIndex:"一个部分。"
        }
      }
    },
    sourceBindings:[],workspaceDir:"/private/task",
    instructionText:"保存交流方案",
    writer:{async commit(){
      return {
        status:"created",
        relativePath:"/Volumes/private-vault/work/交流方案",
        files:["/Volumes/private-vault/work/交流方案/knowledge.md"]
      };
    }},
    skillVersion:"4.4.0",
    ingestedAt:"2026-07-31T00:00:00.000Z"
  });
  assert.equal(result.status,"failed");
  assert.equal(JSON.stringify(result).includes("/Volumes/private-vault"),false);
});
