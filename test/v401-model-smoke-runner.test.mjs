import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runV401ModelSmoke} from "../tools/run-v401-model-smoke.mjs";

test("reports only bounded decision kinds for the representative model smoke",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-model-smoke-"));
  const configFile=join(root,"config.json");
  await writeFile(configFile,JSON.stringify({
    codexPath:"/test/codex",vaultRoot:"/test/vault",
    deepseekEnabled:true,deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"service",deepseekKeychainAccount:"account"
  }),{mode:0o600});
  try {
    let codexCalls=0,deepseekCalls=0;
    const report=await runV401ModelSmoke({
      configFile,skillRoot:root,
      codexInvoke:async({context,workspaceDir,workspaceRoot})=>{
        codexCalls+=1;
        assert.notEqual(workspaceDir,root);
        assert.equal(workspaceRoot,undefined);
        assert.ok(Array.isArray(context.sources));
        assert.equal("sourceEvidence" in context,false);
        assert.deepEqual(
          context.tools.find(tool=>tool.name==="save_knowledge")
            .parameters.properties.libraryKey.enum,
          ["work-knowledge","personal-knowledge"]
        );
        if (context.sources.length===1) {
          assert.equal(
            (await readFile(`${workspaceDir}/source-001.docx`))
              .subarray(0,2).toString(),
            "PK"
          );
          return {
            type:"tool_call",toolName:"save_knowledge",
            arguments:{
              libraryKey:"personal-knowledge",
              folderSegments:["测试资料"],title:"合成原始文档",
              summary:"合成测试摘要。",tags:["测试"],
              sourceIds:["source-001"],
              knowledgeSections:{
                keyFacts:["合成测试事实。"],
                structureAndMainContent:"合成测试正文。",
                reusableContent:[],sourceNotes:"来自原始 DOCX。",
                contentIndex:"一个来源。"
              }
            }
          };
        }
        assert.deepEqual(
          context.sources.map(source=>source.sourceId),
          ["source-001","source-002"]
        );
        return {type:"reply",text:"两份合成材料的比较结果。"};
      },
      deepseekInvoke:async({context})=>{
        deepseekCalls+=1;
        assert.deepEqual(context.sources,[]);
        assert.equal("sourceEvidence" in context,false);
        return {
        type:"tool_call",toolName:"record_daily_work",
        arguments:{
          operation:"create",targetRecordId:"",
          records:[{
            occurred_date:"2026-07-28",occurred_time:"",
            occurred_end_time:"",title:"方案评审",people:[],
            location:"",summary:"完成方案评审。",follow_ups:[],
            original_text:"今天完成了方案评审。"
          }]
        }
        };
      }
    });
    assert.deepEqual(report,{
      rawInputsIncluded:false,rawOutputsIncluded:false,
      calls:{codex:2,deepseek:1,writer:0},
      tokens:{input:null,output:null,available:false},
      codexDocx:{
        kind:"tool",toolName:"save_knowledge",
        selectedSourceIds:["source-001"],
        selectedLibraryKey:"personal-knowledge",writerCalls:0
      },
      codexMulti:{
        kind:"reply",sourceCount:2,writerCalls:0,zeroWrite:true
      },
      deepseek:{
        kind:"tool",toolName:"record_daily_work",
        sourceCount:0,writerCalls:0
      },
      zeroWriteCases:1
    });
    assert.equal(codexCalls,2);
    assert.equal(deepseekCalls,1);
    assert.equal(JSON.stringify(report).includes("方案评审"),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
