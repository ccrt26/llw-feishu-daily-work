import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createFeishuDocumentExporter
} from "../src/capabilities/knowledge-ingest/feishu-document-exporter.mjs";

test("inspects and exports one allowed Feishu snapshot exactly once",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-feishu-export-"));
  try {
    for (const [type,extension] of [
      ["docx","docx"],["doc","docx"],["sheet","xlsx"],["slides","pptx"]
    ]) {
      const calls=[];
      const exporter=createFeishuDocumentExporter({
        cliPath:"/synthetic/lark-cli",profile:"private",tempRoot:root,
        async execute({args,cwd}) {
          calls.push([...args]);
          if (args.includes("+inspect")) {
            return {
              ok:true,identity:"user",
              data:{type,token:`token_${type}`,title:"客户交流方案"}
            };
          }
          await writeFile(join(cwd,`snapshot.${extension}`),Buffer.from("PK\u0003\u0004snapshot"),{
            mode:0o600
          });
          return {ok:true,identity:"user",data:{ready:true}};
        }
      });
      const result=await exporter.exportSnapshot({
        url:`https://example.feishu.cn/${type==="sheet"?"sheets":type}/token_${type}`
      });
      assert.equal(result.extension,extension);
      assert.equal(result.displayName,`客户交流方案.${extension}`);
      assert.match(result.safeSourceReference,/^feishu:[a-f0-9]{64}$/);
      assert.equal(calls.length,2);
      assert.deepEqual(calls[0].slice(-2),["--format","json"]);
      assert.equal(calls[0].includes("--as"),true);
      assert.equal(calls[0].includes("user"),true);
      assert.equal(calls[1].filter(value=>value==="+export").length,1);
      assert.equal(calls[1].includes("--overwrite"),false);
      assert.equal(
        result.safeSourceReference,
        `feishu:${createHash("sha256").update(`${type}\0token_${type}`).digest("hex")}`
      );
      await rm(result.tempDir,{recursive:true,force:true});
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects unsafe links, unsupported types and failed exports without residue",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-feishu-export-invalid-"));
  try {
    let calls=0;
    const exporter=createFeishuDocumentExporter({
      cliPath:"/synthetic/lark-cli",profile:"private",tempRoot:root,
      async execute() {
        calls+=1;
        return {ok:true,identity:"user",data:{
          type:"bitable",token:"base_token",title:"多维表格"
        }};
      }
    });
    for (const url of [
      "http://example.feishu.cn/docx/token",
      "https://evil.example.com/docx/token",
      "https://user:pass@example.feishu.cn/docx/token",
      "https://example.feishu.cn/drive/folder/token"
    ]) {
      await assert.rejects(exporter.exportSnapshot({url}),/feishu_snapshot_invalid/);
    }
    await assert.rejects(
      exporter.exportSnapshot({url:"https://example.feishu.cn/base/base_token"}),
      /feishu_snapshot_invalid/
    );
    assert.equal(calls,1);
    assert.deepEqual(await readdir(root),[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
