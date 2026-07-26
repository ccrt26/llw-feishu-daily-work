import {randomUUID} from "node:crypto";

const TERMINAL=new Set(["completed","cancelled","expired"]);

export class TaskSessionManager {
  constructor({state,workspace,createId=randomUUID}) {
    if (!state||!workspace||typeof createId!=="function") {
      throw new Error("invalid_task_session_manager");
    }
    this.state=state;
    this.workspace=workspace;
    this.createId=createId;
  }

  getOpen() {
    const session=this.state.getTaskSession();
    return session?.status==="open"?session:null;
  }

  routerConversation() {
    const session=this.getOpen();
    if (!session) return null;
    return {
      capability:session.capability,status:session.status,goal:session.goal,
      task_summary:session.task_summary,
      current_draft_version:session.current_draft_version,model:session.model,
      grounding_mode:session.grounding_mode,startedAt:session.started_at
    };
  }

  async create({goal,model,groundingMode,sourcePaths,startedAt}) {
    if (this.getOpen()) throw new Error("task_session_unavailable");
    const sessionId=this.createId();
    const session={
      version:1,session_id:sessionId,capability:"assistant-work",status:"open",
      model,grounding_mode:groundingMode,goal,task_summary:"",
      confirmed_requirements:[],rejected_directions:[],source_paths:[...sourcePaths],
      current_draft_version:0,recent_turns:[],
      started_at:startedAt,updated_at:startedAt
    };
    try {
      await this.workspace.create({sessionId,startedAt});
      await this.state.saveTaskSession(session,{verifiedSourcePaths:sourcePaths});
      return structuredClone(session);
    } catch {
      throw new Error("task_session_unavailable");
    }
  }

  async update({
    session,userText,assistantText,sourcePaths,draftVersion,updatedAt
  }) {
    const current=this.getOpen();
    if (!current||current.session_id!==session?.session_id||
        current.model!==session.model||current.capability!==session.capability||
        !Number.isInteger(draftVersion)||
        draftVersion<current.current_draft_version) {
      throw new Error("task_session_unavailable");
    }
    const turns=[
      ...current.recent_turns,
      {role:"user",text:boundedTurn(userText)},
      {role:"assistant",text:boundedTurn(assistantText)}
    ].slice(-12);
    const handledTurns=current.recent_turns.length+2;
    const summary=boundedBytes(
      `目标：${current.goal}；已处理轮次：${handledTurns}`,8000
    );
    const next={
      ...current,task_summary:summary,
      source_paths:[...sourcePaths],current_draft_version:draftVersion,
      recent_turns:turns,updated_at:updatedAt
    };
    try {
      await this.state.saveTaskSession(next,{verifiedSourcePaths:sourcePaths});
      return structuredClone(next);
    } catch {
      throw new Error("task_session_unavailable");
    }
  }

  async close(status,updatedAt) {
    if (!TERMINAL.has(status)||!this.getOpen()) {
      throw new Error("task_session_unavailable");
    }
    try {
      await this.state.closeTaskSession(status,updatedAt);
    } catch {
      throw new Error("task_session_unavailable");
    }
  }

  async recover() {
    const current=this.getOpen();
    if (!current) return null;
    try {
      const working=await this.workspace.load(current.session_id);
      if (working.currentDraftVersion===current.current_draft_version) {
        return structuredClone(current);
      }
      if (working.currentDraftVersion!==current.current_draft_version+1||
          Date.parse(working.updatedAt)<Date.parse(current.updated_at)) {
        throw new Error("invalid");
      }
      const recovered={
        ...current,source_paths:[...working.sourcePaths],
        current_draft_version:working.currentDraftVersion,
        updated_at:working.updatedAt
      };
      await this.state.saveTaskSession(recovered,{
        verifiedSourcePaths:working.sourcePaths
      });
      return structuredClone(recovered);
    } catch {
      throw new Error("task_session_recovery_failed");
    }
  }
}

function boundedTurn(value) {
  if (typeof value!=="string"||!value.trim()||value.includes("\0")) {
    throw new Error("task_session_unavailable");
  }
  return boundedBytes(value,2000);
}

function boundedBytes(value,maxBytes) {
  const characters=[...value];
  while (characters.length&&
      Buffer.byteLength(characters.join(""),"utf8")>maxBytes) {
    characters.pop();
  }
  return characters.join("");
}
