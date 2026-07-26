import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TaskWorkspace} from "../src/workspace/task-workspace.mjs";

const sessionId="123e4567-e89b-42d3-a456-426614174000";

test("creates one private session and versions drafts without overwriting",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-aw-workspace-")); await chmod(root,0o700);
  const workspace=new TaskWorkspace(root);
  await workspace.create({sessionId,startedAt:"2026-07-26T01:00:00.000Z"});
  const first=await workspace.saveDraft({
    sessionId,baseVersion:0,text:"第一版",sourcePaths:["工作资料/合成.md"],
    updatedAt:"2026-07-26T01:01:00.000Z"
  });
  const second=await workspace.saveDraft({
    sessionId,baseVersion:1,text:"第二版",sourcePaths:["工作资料/合成.md"],
    updatedAt:"2026-07-26T01:02:00.000Z"
  });
  assert.deepEqual([first.version,second.version],[1,2]);
  assert.equal(await readFile(join(root,sessionId,"draft-v1.md"),"utf8"),"第一版");
  assert.equal(await readFile(join(root,sessionId,"draft-v2.md"),"utf8"),"第二版");
  assert.deepEqual(await workspace.load(sessionId),{
    currentDraftVersion:2,currentDraft:"第二版",
    sourcePaths:["工作资料/合成.md"],
    startedAt:"2026-07-26T01:00:00.000Z",
    updatedAt:"2026-07-26T01:02:00.000Z"
  });
});

test("rejects base-version conflicts, unsafe IDs, unsafe paths and unexpected files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-aw-workspace-")); await chmod(root,0o700);
  const workspace=new TaskWorkspace(root);
  await workspace.create({sessionId,startedAt:"2026-07-26T01:00:00.000Z"});
  await workspace.saveDraft({sessionId,baseVersion:0,text:"第一版",sourcePaths:[],updatedAt:"2026-07-26T01:01:00.000Z"});
  await assert.rejects(()=>workspace.saveDraft({sessionId,baseVersion:0,text:"覆盖",sourcePaths:[],updatedAt:"2026-07-26T01:02:00.000Z"}),/task_workspace_rejected/);
  await assert.rejects(()=>workspace.create({sessionId:"../outside",startedAt:"2026-07-26T01:00:00.000Z"}),/task_workspace_rejected/);
  await assert.rejects(()=>workspace.saveDraft({sessionId,baseVersion:1,text:"x",sourcePaths:["../outside.md"],updatedAt:"2026-07-26T01:02:00.000Z"}),/task_workspace_rejected/);
  assert.deepEqual((await readdir(join(root,sessionId))).sort(),["draft-v1.md","session.json","sources.json"]);
});
