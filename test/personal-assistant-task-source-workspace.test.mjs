import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,mkdtemp,mkdir,readFile,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {
  createTaskSession
} from "../src/personal-assistant/task-session.mjs";

const TASK_ID="T".repeat(43);
const NOW="2026-07-29T01:00:00.000Z";

function message({
  id="message-1",
  text="",
  resource="file-1",
  displayName="联通联信终端安全能力中心介绍.txt",
  receivedAt=NOW,
  attachments=null
}={}) {
  return {
    source:"feishu",
    sourceMessageId:id,
    userId:"bound-user",
    conversationId:"bound-chat",
    receivedAt,
    instructionText:text,
    attachments:attachments??[{
      type:"file",
      sourceAttachmentId:resource,
      displayName,
      extension:"txt"
    }],
    replyTarget:{
      source:"feishu",
      sourceMessageId:id,
      conversationId:"bound-chat"
    }
  };
}

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-task-source-"));
  const transientRoot=join(root,"transient");
  const downloadRoot=join(root,"downloads");
  const taskRoot=join(root,"tasks");
  let downloads=0;
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:transientRoot,
    download:async({attachment})=>{
      downloads+=1;
      const tempDir=join(downloadRoot,attachment.sourceAttachmentId);
      await mkdir(tempDir,{recursive:true,mode:0o700});
      const file=join(tempDir,"source.txt");
      await writeFile(
        file,
        attachment.sourceAttachmentId==="file-1"
          ?"SYNTHETIC-SECURITY-CENTER-CONTENT"
          :"SYNTHETIC-SECOND-SOURCE",
        {mode:0o600}
      );
      return {file,tempDir};
    }
  });
  const workspace=new TaskSourceWorkspace({
    root:taskRoot,prepareTurnSources
  });
  return {root,transientRoot,taskRoot,workspace,get downloads(){return downloads;}};
}

test("keeps an original after a stage question and reopens identical bytes later",async()=>{
  const h=await harness();
  const firstMessage=message();
  const session=createTaskSession({
    message:firstMessage,model:"codex",taskId:TASK_ID,now:NOW
  });
  try {
    const first=await h.workspace.prepareAndMerge({
      session,message:firstMessage
    });
    const originalHash=createHash("sha256")
      .update("SYNTHETIC-SECURITY-CENTER-CONTENT")
      .digest("hex");
    assert.equal(first.addedSourceIds[0],"source-001");
    assert.equal(first.sources[0].handle.sha256,originalHash);
    assert.equal(h.downloads,1);

    const reopened=await h.workspace.load({
      taskId:TASK_ID,
      expectedSourceIds:["source-001"]
    });
    assert.equal(reopened.sources[0].handle.sha256,originalHash);
    assert.equal(
      createHash("sha256")
        .update(await readFile(reopened.sources[0].absolutePath))
        .digest("hex"),
      originalHash
    );
    assert.equal((await stat(reopened.workspaceDir)).mode&0o777,0o700);
    assert.equal(
      (await stat(reopened.sources[0].absolutePath)).mode&0o777,
      0o600
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("merges later files with monotonic task source ids and never overwrites",async()=>{
  const h=await harness();
  const firstMessage=message();
  const session=createTaskSession({
    message:firstMessage,model:"codex",taskId:TASK_ID,now:NOW
  });
  try {
    await h.workspace.prepareAndMerge({session,message:firstMessage});
    const second=await h.workspace.prepareAndMerge({
      session:{...session,sourceIds:["source-001"]},
      message:message({
        id:"message-2",
        resource:"file-2",
        displayName:"补充材料.txt",
        receivedAt:"2026-07-29T01:01:00.000Z"
      })
    });
    assert.deepEqual(
      second.sources.map(source=>source.handle.sourceId),
      ["source-001","source-002"]
    );
    assert.deepEqual(second.addedSourceIds,["source-002"]);
    assert.equal(
      await readFile(second.sources[0].absolutePath,"utf8"),
      "SYNTHETIC-SECURITY-CENTER-CONTENT"
    );
    assert.equal(
      await readFile(second.sources[1].absolutePath,"utf8"),
      "SYNTHETIC-SECOND-SOURCE"
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("rejects a ninth task source before copying it",async()=>{
  const h=await harness();
  const attachments=Array.from({length:8},(_,index)=>({
    type:"file",
    sourceAttachmentId:`file-${index+1}`,
    displayName:`材料-${index+1}.txt`,
    extension:"txt"
  }));
  const firstMessage=message({attachments});
  const session=createTaskSession({
    message:firstMessage,model:"codex",taskId:TASK_ID,now:NOW
  });
  try {
    const first=await h.workspace.prepareAndMerge({
      session,message:firstMessage
    });
    assert.equal(first.sources.length,8);
    const resolved={
      ...session,
      resolvedRevision:1,
      sourceIds:first.sources.map(source=>source.handle.sourceId),
      pendingInputs:[]
    };
    await assert.rejects(
      h.workspace.prepareAndMerge({
        session:resolved,
        message:message({
          id:"message-9",
          resource:"file-9",
          receivedAt:"2026-07-29T01:09:00.000Z"
        })
      }),
      /task_source_workspace_invalid/
    );
    const reopened=await h.workspace.load({
      taskId:TASK_ID,
      expectedSourceIds:resolved.sourceIds
    });
    assert.equal(reopened.sources.length,8);
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("rejects a task source whose retained bytes no longer match its hash",async()=>{
  const h=await harness();
  const firstMessage=message();
  const session=createTaskSession({
    message:firstMessage,model:"codex",taskId:TASK_ID,now:NOW
  });
  try {
    const first=await h.workspace.prepareAndMerge({
      session,message:firstMessage
    });
    await writeFile(
      first.sources[0].absolutePath,
      "TAMPERED-BUT-STILL-A-REGULAR-FILE"
    );
    await assert.rejects(
      h.workspace.load({
        taskId:TASK_ID,expectedSourceIds:["source-001"]
      }),
      /task_source_workspace_invalid/
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("keeps active task workspaces and removes only expired task workspaces",async()=>{
  const h=await harness();
  const activeId="A".repeat(43);
  const expiredId="E".repeat(43);
  const activeMessage=message();
  const expiredMessage=message({
    id:"message-expired",resource:"file-2"
  });
  try {
    await h.workspace.prepareAndMerge({
      session:createTaskSession({
        message:activeMessage,model:"codex",taskId:activeId,now:NOW
      }),
      message:activeMessage
    });
    await h.workspace.prepareAndMerge({
      session:createTaskSession({
        message:expiredMessage,model:"codex",taskId:expiredId,now:NOW
      }),
      message:expiredMessage
    });

    const removed=await h.workspace.cleanupExpired({
      activeTaskIds:[activeId],
      now:"2026-07-30T01:00:00.001Z"
    });

    assert.deepEqual(removed,[expiredId]);
    await access(h.workspace.workspace(activeId));
    await assert.rejects(access(h.workspace.workspace(expiredId)),{
      code:"ENOENT"
    });
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("preserves the bounded Source Intake failure reason",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-task-source-error-"));
  const firstMessage=message();
  const session=createTaskSession({
    message:firstMessage,model:"codex",taskId:TASK_ID,now:NOW
  });
  const workspace=new TaskSourceWorkspace({
    root,
    prepareTurnSources:async()=>{
      throw new Error("source_receive_failed");
    }
  });
  try {
    await assert.rejects(
      workspace.prepareAndMerge({session,message:firstMessage}),
      /source_receive_failed/
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
