import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {chmod,lstat,mkdir,mkdtemp,readdir,rm} from "node:fs/promises";
import {join} from "node:path";

const EXPORTS={
  doc:{extension:"docx",docType:"doc"},
  docx:{extension:"docx",docType:"docx"},
  sheet:{extension:"xlsx",docType:"sheet"},
  slides:{extension:"pptx",docType:"slides"}
};

export function createFeishuDocumentExporter({
  cliPath,profile,tempRoot,execute=executeCli,timeoutMs=120_000
}) {
  if (typeof cliPath!=="string"||!cliPath||
      typeof profile!=="string"||!profile||
      typeof tempRoot!=="string"||!tempRoot||
      typeof execute!=="function"||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000) {
    throw new Error("feishu_snapshot_invalid");
  }
  return {
    async exportSnapshot({url}) {
      let tempDir="";
      try {
        validateUrl(url);
        await mkdir(tempRoot,{recursive:true,mode:0o700});
        await chmod(tempRoot,0o700);
        const rootInfo=await lstat(tempRoot);
        if (!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||
            rootInfo.uid!==process.getuid()||(rootInfo.mode&0o077)!==0) {
          throw new Error("unsafe_root");
        }
        tempDir=await mkdtemp(join(tempRoot,"job-"));
        await chmod(tempDir,0o700);
        const inspected=await execute({
          command:cliPath,cwd:tempDir,timeoutMs,
          args:[
            "--profile",profile,"drive","+inspect","--as","user",
            "--url",url,"--format","json"
          ]
        });
        const document=validatedInspection(inspected);
        const policy=EXPORTS[document.type];
        if (!policy) throw new Error("unsupported");
        const fileName=`snapshot.${policy.extension}`;
        const exported=await execute({
          command:cliPath,cwd:tempDir,timeoutMs,
          args:[
            "--profile",profile,"drive","+export","--as","user",
            "--token",document.token,"--doc-type",policy.docType,
            "--file-extension",policy.extension,
            "--file-name",fileName,"--output-dir",".","--format","json"
          ]
        });
        if (exported?.ok!==true||exported.identity!=="user"||
            exported.data?.ready===false) {
          throw new Error("export_failed");
        }
        const entries=await readdir(tempDir,{withFileTypes:true});
        if (entries.length!==1||entries[0].name!==fileName||
            !entries[0].isFile()) {
          throw new Error("invalid_output");
        }
        const file=join(tempDir,fileName);
        await chmod(file,0o600);
        const info=await lstat(file);
        if (!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||
            (info.mode&0o077)!==0) {
          throw new Error("invalid_output");
        }
        return {
          tempDir,file,extension:policy.extension,
          displayName:`${safeTitle(document.title)}.${policy.extension}`,
          safeSourceReference:`feishu:${createHash("sha256")
            .update(`${document.type}\0${document.token}`,"utf8").digest("hex")}`
        };
      } catch {
        if (tempDir) await rm(tempDir,{recursive:true,force:true}).catch(()=>{});
        throw new Error("feishu_snapshot_invalid");
      }
    }
  };
}

function validateUrl(value) {
  if (typeof value!=="string"||value.length<1||value.length>2048) {
    throw new Error("invalid_url");
  }
  const url=new URL(value);
  const host=url.hostname.toLowerCase();
  const allowedHost=host==="feishu.cn"||host.endsWith(".feishu.cn")||
    host==="larksuite.com"||host.endsWith(".larksuite.com");
  if (url.protocol!=="https:"||!allowedHost||url.username||url.password||
      url.hash||!/^\/(?:docx?|sheets|slides|wiki|base|bitable)\/[A-Za-z0-9_-]+\/?$/u
        .test(url.pathname)) {
    throw new Error("invalid_url");
  }
}

function validatedInspection(value) {
  const data=value?.data;
  if (value?.ok!==true||value.identity!=="user"||
      !data||typeof data!=="object"||Array.isArray(data)||
      typeof data.type!=="string"||typeof data.token!=="string"||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(data.token)||
      typeof data.title!=="string"||[...data.title].length>255) {
    throw new Error("invalid_inspection");
  }
  return {type:data.type,token:data.token,title:data.title};
}

function safeTitle(value) {
  const title=value.normalize("NFC").trim()
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/gu,"-")
    .replace(/\s+/gu," ").slice(0,120);
  return title||"飞书文档快照";
}

function executeCli({command,args,cwd,timeoutMs}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{
      cwd,stdio:["ignore","pipe","ignore"],
      env:{
        ...process.env,
        PATH:"/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1",
        LARK_CLI_NO_PROXY:"1"
      }
    });
    const chunks=[];
    let size=0,settled=false;
    const finish=(error,value)=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer=setTimeout(()=>{
      child.kill("SIGKILL");
      finish(new Error("timeout"));
    },timeoutMs);
    child.stdout.on("data",chunk=>{
      size+=chunk.length;
      if (size>64*1024) {
        child.kill("SIGKILL");
        finish(new Error("oversized"));
      } else chunks.push(chunk);
    });
    child.once("error",finish);
    child.once("close",code=>{
      if (code!==0) return finish(new Error("cli_failed"));
      try {
        finish(null,JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new Error("invalid_json"));
      }
    });
  });
}
