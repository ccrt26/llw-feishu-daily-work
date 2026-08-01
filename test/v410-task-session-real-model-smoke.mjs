import {createHash} from "node:crypto";
import {
  chmod,mkdir,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createFeishuIncomingMessage
} from "../src/core/incoming-message.mjs";
import {
  PersonalAssistantClient
} from "../src/personal-assistant/client.mjs";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "../src/personal-assistant/dispatcher.mjs";
import {
  invokePersonalAssistantCodex
} from "../src/personal-assistant/invoke-personal-assistant.mjs";
import {
  loadPersonalAssistantSkillBundle
} from "../src/personal-assistant/skill-bundle.mjs";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {StateStore} from "../src/state-store.mjs";

const started=Date.now();
const report={
  status:"failed",
  taskIdStable:false,
  decisions:[],
  stages:[],
  sourceHashes:[],
  sourceCount:0,
  writerCalls:0,
  replyCount:0,
  elapsedMs:0
};
const root=await mkdtemp(join(tmpdir(),"llw-v410-real-model-"));

try {
  const skillsRoot=process.env.LLW_SKILLS_ROOT;
  if (!skillsRoot) throw new Error("skill_root_unavailable");
  const skillRoot=join(skillsRoot,"llw-personal-assistant");
  const skillManifest=JSON.parse(
    await readFile(join(skillsRoot,"manifest.json"),"utf8")
  );
  const skillEntry=skillManifest.skills.find(
    entry=>entry.name==="llw-personal-assistant"
  );
  if (!skillEntry) throw new Error("skill_manifest_invalid");
  const skillBundle=await loadPersonalAssistantSkillBundle({
    skillRoot,
    runtimeFiles:skillEntry.runtime_files.map(({path,sha256})=>({path,sha256}))
  });
  const codexPath=process.env.LLW_CODEX_PATH||
    "/Applications/ChatGPT.app/Contents/Resources/codex";
  const firstTime=Date.parse("2026-07-29T10:00:00.000Z");
  let nowMs=firstTime;
  const pdfBytes=createSyntheticPdf(
    "LLW SYNTHETIC SECURITY CENTRE. MAIN CONTENT: endpoint controls, risk review, and incident response."
  );
  const sourcePdf=join(root,"synthetic-source.pdf");
  await writeFile(sourcePdf,pdfBytes,{mode:0o600});
  await chmod(sourcePdf,0o600);
  report.sourceHashes.push(
    createHash("sha256").update(pdfBytes).digest("hex")
  );

  const state=await StateStore.open(join(root,"state.json"));
  const bindings={
    feishu:{userId:"synthetic-owner",conversationId:"synthetic-chat"},
    wechat:null
  };
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings,selectModel:async()=>"codex",
    createId:()=>"s".repeat(43),now:()=>nowMs
  });
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:join(root,"intake"),
    download:async()=>({file:sourcePdf,tempDir:root}),
    cleanup:async()=>{}
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),
    prepareTurnSources,now:()=>nowMs
  });
  const assistant=new PersonalAssistantClient({
    codex:async(context,{workspaceDir,imageFiles})=>{
      const raw=await invokePersonalAssistantCodex({
        codexPath,workspaceDir,skillBundle,context,imageFiles,
        timeoutMs:180_000
      });
      report.decisions.push(raw.type||raw.action||"invalid");
      return raw;
    },
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const sent=[];
  const messenger={
    async send(value){
      sent.push({
        source:value.replyTarget.source,
        hasText:typeof value.text==="string"&&value.text.length>0,
        fileCount:value.replyFiles.length
      });
    }
  };
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,assistant,
    writer:{
      async commit(){
        report.writerCalls+=1;
        throw new Error("unexpected_writer");
      }
    },
    dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    },
    messenger,personalRules:[],model:"codex",
    skillVersion:"4.1.0",taskManager,taskWorkspace
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"synthetic-owner",chatId:"synthetic-chat"},
    bindings:{feishu:bindings.feishu},state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger,
    taskManager,taskWorkspace,now:()=>nowMs
  });

  const first=await dispatcher.handleTaskIncomingMessage(
    createFeishuIncomingMessage({
      messageId:"synthetic-file",senderId:"synthetic-owner",
      chatId:"synthetic-chat",messageType:"file",
      content:'<file key="file_synthetic_smoke" name="synthetic.pdf"/>',
      createTimeMs:firstTime
    })
  );
  report.stages.push(first.status);
  const firstSession=taskManager.current("feishu");
  if (first.status!=="awaiting_clarification"||
      firstSession?.sourceIds.length!==1) {
    throw new Error("first_stage_contract_failed");
  }

  nowMs=firstTime+20_000;
  const second=await dispatcher.handleTaskIncomingMessage(
    createFeishuIncomingMessage({
      messageId:"synthetic-instruction",
      senderId:"synthetic-owner",chatId:"synthetic-chat",
      messageType:"text",
      content:"请总结这份合成材料的主要内容，不保存，不生成文件。",
      createTimeMs:nowMs
    })
  );
  report.stages.push(second.status);
  const finalSession=taskManager.current("feishu");
  report.taskIdStable=Boolean(
    firstSession&&finalSession&&
    firstSession.taskId===finalSession.taskId
  );
  report.sourceCount=finalSession?.sourceIds.length??0;
  report.replyCount=sent.length;
  if (second.status!=="committed"||
      !report.taskIdStable||report.sourceCount!==1||
      report.writerCalls!==0||report.replyCount!==2) {
    throw new Error("second_stage_contract_failed");
  }
  report.status="passed";
} catch (error) {
  report.errorCode=new Set([
    "skill_root_unavailable","first_stage_contract_failed",
    "second_stage_contract_failed"
  ]).has(error?.message)
    ?error.message
    :"real_model_smoke_failed";
} finally {
  report.elapsedMs=Date.now()-started;
  await rm(root,{recursive:true,force:true});
}

process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status!=="passed") process.exitCode=1;

function createSyntheticPdf(text) {
  const escaped=text.replace(/[\\()]/gu,character=>`\\${character}`);
  const stream=`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects=[
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body="%PDF-1.4\n";
  const offsets=[0];
  for (let index=0;index<objects.length;index+=1) {
    offsets.push(Buffer.byteLength(body));
    body+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref=Buffer.byteLength(body);
  body+=`xref\n0 ${objects.length+1}\n`;
  body+="0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body+=`${String(offset).padStart(10,"0")} 00000 n \n`;
  }
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\n`;
  body+=`startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
