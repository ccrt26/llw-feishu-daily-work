import {randomBytes} from "node:crypto";
import {
  appendTaskInput,
  createTaskSession,
  pauseTaskSession,
  resolveTaskStage,
  resumeTaskSession,
  validateTaskSession
} from "./task-session.mjs";

const SOURCES=new Set(["feishu","wechat"]);

export class PersonalAssistantTaskSessionManager {
  constructor({
    state,bindings,selectModel,
    createId=()=>randomBytes(32).toString("base64url"),
    now=Date.now
  }) {
    if (!state||!bindings||typeof bindings!=="object"||
        typeof selectModel!=="function"||
        typeof createId!=="function"||typeof now!=="function") {
      throw new Error("task_session_manager_invalid");
    }
    validateBinding(bindings.feishu);
    if (bindings.wechat!==null&&bindings.wechat!==undefined) {
      validateBinding(bindings.wechat);
    }
    this.state=state;
    this.bindings={
      feishu:structuredClone(bindings.feishu),
      wechat:bindings.wechat
        ?structuredClone(bindings.wechat)
        :null
    };
    this.selectModel=selectModel;
    this.createId=createId;
    this.now=now;
    this.sessions={feishu:null,wechat:null};
    this.expiredTaskIds={feishu:null,wechat:null};
    this.loaded={feishu:false,wechat:false};
    this.mutations={feishu:Promise.resolve(),wechat:Promise.resolve()};
  }

  current(source) {
    validateSource(source);
    const value=this.sessions[source];
    return value===null?null:validateTaskSession(value);
  }

  bind(source,binding) {
    validateSource(source);
    validateBinding(binding);
    const current=this.bindings[source];
    if (current&&(
      current.userId!==binding.userId||
      current.conversationId!==binding.conversationId
    )) {
      throw new Error("task_session_manager_invalid");
    }
    this.bindings[source]=structuredClone(binding);
  }

  accept(message) {
    validateBoundMessage(message,this.bindings);
    const source=message.source;
    return this.mutate(source,async()=>{
      let current=await this.load(source,message.receivedAt);
      let replacedTaskId=this.expiredTaskIds[source];
      this.expiredTaskIds[source]=null;
      const messageKey=`${source}:${message.sourceMessageId}`;
      if (this.state.hasOutcome(messageKey)||
          current?.pendingInputs.some(
            input=>input.messageKey===messageKey
          )) {
        return {
          taskId:current?.taskId??null,
          revision:current?.revision??null,
          source,
          isNew:false,
          messageKey,
          duplicate:true
        };
      }
      let isNew=false;
      if (!current||current.status==="paused") {
        replacedTaskId=current?.taskId??replacedTaskId;
        const model=await this.selectModel();
        current=createTaskSession({
          message,model,taskId:this.createId(),now:message.receivedAt
        });
        isNew=true;
      } else {
        current=appendTaskInput({
          session:current,message,now:message.receivedAt
        });
      }
      await this.state.setPersonalAssistantTaskSession(source,current);
      this.sessions[source]=current;
      return {
        taskId:current.taskId,
        revision:current.revision,
        source,
        isNew,
        messageKey,
        ...(replacedTaskId?{replacedTaskId}:{})
      };
    });
  }

  claim(source) {
    validateSource(source);
    return this.mutate(source,async()=>{
      const current=await this.load(
        source,new Date(this.now()).toISOString()
      );
      if (!current||current.status!=="active"||
          !current.pendingInputs.length) return null;
      const pending=[...current.pendingInputs].sort(
        (a,b)=>a.revision-b.revision
      );
      const latest=pending.at(-1);
      const instructionText=pending
        .map(input=>input.instructionText.trim())
        .filter(Boolean)
        .join("\n");
      const message={
        source,
        sourceMessageId:latest.messageKey.slice(source.length+1),
        userId:latest.userId,
        conversationId:latest.conversationId,
        receivedAt:latest.receivedAt,
        instructionText,
        attachments:pending.flatMap(
          input=>structuredClone(input.attachments)
        ),
        replyTarget:structuredClone(latest.replyTarget)
      };
      return Object.freeze({
        taskId:current.taskId,
        revision:current.revision,
        session:validateTaskSession(current),
        message:Object.freeze(message),
        inputKeys:Object.freeze(
          pending.map(input=>input.messageKey)
        )
      });
    });
  }

  isCurrent(snapshot) {
    validateSnapshot(snapshot);
    return this.mutate(snapshot.session.source,async()=>{
      const current=await this.load(
        snapshot.session.source,
        new Date(this.now()).toISOString()
      );
      return Boolean(current&&current.status==="active"&&
        current.taskId===snapshot.taskId&&
        current.revision===snapshot.revision&&
        current.updatedAt===snapshot.session.updatedAt);
    });
  }

  attachSources(snapshot,{addedSourceIds}) {
    validateSnapshot(snapshot);
    validateAddedSourceIds(addedSourceIds);
    const source=snapshot.session.source;
    return this.mutate(source,async()=>{
      const current=await this.load(
        source,new Date(this.now()).toISOString()
      );
      if (!current||current.status!=="active"||
          current.taskId!==snapshot.taskId||
          current.revision<snapshot.revision||
          !sameArray(
            current.sourceIds,snapshot.session.sourceIds
          )) {
        throw new Error("task_session_manager_invalid");
      }
      const nextIds=[
        ...current.sourceIds,...addedSourceIds
      ];
      if (nextIds.length>8) {
        throw new Error("task_session_manager_invalid");
      }
      for (let index=0;index<nextIds.length;index+=1) {
        if (nextIds[index]!==
            `source-${String(index+1).padStart(3,"0")}`) {
          throw new Error("task_session_manager_invalid");
        }
      }
      const next=validateTaskSession({
        ...current,
        sourceIds:nextIds,
        pendingInputs:current.pendingInputs.map(input=>
          input.revision<=snapshot.revision
            ?{...input,attachments:[]}
            :input
        )
      });
      await this.state.setPersonalAssistantTaskSession(source,next);
      this.sessions[source]=next;
      return validateTaskSession(next);
    });
  }

  reserveWriter({
    source,taskId,revision,updatedAt,toolName
  }) {
    validateSource(source);
    if (typeof taskId!=="string"||
        !Number.isSafeInteger(revision)||
        !canonicalIso(updatedAt)||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(toolName||"")) {
      throw new Error("task_session_manager_invalid");
    }
    return this.mutate(source,async()=>{
      const current=await this.load(
        source,new Date(this.now()).toISOString()
      );
      if (!current||current.status!=="active"||
          current.taskId!==taskId||
          current.revision!==revision||
          current.updatedAt!==updatedAt||
          current.writerCheckpoint!==null) return false;
      const next=validateTaskSession({
        ...current,
        writerCheckpoint:{
          revision,toolName,status:"reserved"
        }
      });
      await this.state.setPersonalAssistantTaskSession(source,next);
      this.sessions[source]=next;
      return true;
    });
  }

  isCommitCompatible(snapshot) {
    validateSnapshot(snapshot);
    const source=snapshot.session.source;
    return this.mutate(source,async()=>{
      const current=await this.load(
        source,new Date(this.now()).toISOString()
      );
      if (!current||current.status!=="active"||
          current.taskId!==snapshot.taskId) return false;
      if (current.writerCheckpoint?.revision===
          snapshot.revision) return true;
      return current.writerCheckpoint===null&&
        current.revision===snapshot.revision&&
        current.updatedAt===snapshot.session.updatedAt;
    });
  }

  completeStage(snapshot,result) {
    validateSnapshot(snapshot);
    validateStageResult(result);
    const source=snapshot.session.source;
    return this.mutate(source,async()=>{
      const current=await this.load(
        source,new Date(this.now()).toISOString()
      );
      if (!current||current.status!=="active"||
          current.taskId!==snapshot.taskId) return false;
      const reserved=current.writerCheckpoint?.revision===
        snapshot.revision;
      const direct=current.writerCheckpoint===null&&
        current.revision===snapshot.revision&&
        current.updatedAt===snapshot.session.updatedAt;
      if (!reserved&&!direct) return false;
      const latest=current.pendingInputs
        .filter(input=>input.revision<=snapshot.revision)
        .sort((a,b)=>a.revision-b.revision)
        .at(-1);
      if (!latest) return false;
      const next=resolveTaskStage({
        session:current,
        throughRevision:snapshot.revision,
        userText:snapshot.message.instructionText||
          "（已提供来源）",
        assistantText:result.reply||"本阶段没有用户可见回复。",
        waiting:result.waiting??null,
        taskUpdate:result.taskUpdate??null,
        now:current.updatedAt
      });
      const publicResult={
        capability:"personal-assistant",
        status:result.status,
        reply:result.reply,
        artifacts:structuredClone(result.artifacts||[]),
        replyFiles:structuredClone(result.replyFiles||[]),
        noReplyRequired:result.noReplyRequired===true,
        replyTarget:structuredClone(latest.replyTarget),
        createdAt:latest.receivedAt,
        ...(result.reasonCode?{reasonCode:result.reasonCode}:{})
      };
      const outcomes=current.pendingInputs
        .map(input=>input.messageKey===latest.messageKey
          ?{key:input.messageKey,value:publicResult}
          :input.revision>snapshot.revision&&
              current.writerCheckpoint?.status==="cancel_requested"
            ?{
              key:input.messageKey,
              value:{
                capability:"personal-assistant",
                status:"ignored",
                reply:null,
                artifacts:[],
                replyFiles:[],
                noReplyRequired:true,
                reasonCode:"cancelled",
                createdAt:input.receivedAt
              }
            }
          :{
            key:input.messageKey,
            value:{
              capability:"personal-assistant",
              status:"ignored",
              reply:null,
              artifacts:[],
              replyFiles:[],
              noReplyRequired:true,
              reasonCode:"absorbed_into_task_revision",
              createdAt:input.receivedAt
            }
          })
        .filter(entry=>
          current.writerCheckpoint?.status==="cancel_requested"||
          current.pendingInputs.find(
            input=>input.messageKey===entry.key
          ).revision<=snapshot.revision
        );
      const cancelRequested=
        current.writerCheckpoint?.status==="cancel_requested";
      const committed=await this.state.commitPersonalAssistantTaskStage({
        source,
        expectedTaskId:snapshot.taskId,
        expectedRevision:current.revision,
        nextSession:cancelRequested?null:next,
        outcomes
      });
      if (committed) {
        this.sessions[source]=cancelRequested?null:next;
      }
      return committed;
    });
  }

  async recoverPending() {
    const now=new Date(this.now()).toISOString();
    const pending=[];
    for (const source of SOURCES) {
      if (!this.bindings[source]) continue;
      const session=await this.mutate(
        source,()=>this.load(source,now)
      );
      if (session?.status==="active"&&session.pendingInputs.length) {
        pending.push(source);
      }
    }
    return pending;
  }

  close(source,_reason,now=new Date(this.now()).toISOString()) {
    validateSource(source);
    if (!canonicalIso(now)) {
      throw new Error("task_session_manager_invalid");
    }
    return this.mutate(source,async()=>{
      const current=await this.load(source,now);
      if (!current) return null;
      await this.state.clearPersonalAssistantTaskSession(source);
      this.sessions[source]=null;
      return validateTaskSession(current);
    });
  }

  cancel(source,now=new Date(this.now()).toISOString()) {
    validateSource(source);
    if (!canonicalIso(now)) {
      throw new Error("task_session_manager_invalid");
    }
    return this.mutate(source,async()=>{
      const current=await this.load(source,now);
      if (!current) return null;
      if (current.writerCheckpoint?.status==="reserved") {
        const next=validateTaskSession({
          ...current,
          writerCheckpoint:{
            ...current.writerCheckpoint,
            status:"cancel_requested"
          }
        });
        await this.state.setPersonalAssistantTaskSession(source,next);
        this.sessions[source]=next;
        return validateTaskSession(next);
      }
      await this.state.clearPersonalAssistantTaskSession(source);
      this.sessions[source]=null;
      return validateTaskSession(current);
    });
  }

  pause(source,now=new Date(this.now()).toISOString()) {
    validateSource(source);
    return this.mutate(source,async()=>{
      const current=await this.load(source,now);
      if (!current) return null;
      const next=pauseTaskSession({session:current,now});
      await this.state.setPersonalAssistantTaskSession(source,next);
      this.sessions[source]=next;
      return validateTaskSession(next);
    });
  }

  resume(source,now=new Date(this.now()).toISOString()) {
    validateSource(source);
    return this.mutate(source,async()=>{
      const current=await this.load(source,now);
      if (!current) return null;
      const next=resumeTaskSession({session:current,now});
      await this.state.setPersonalAssistantTaskSession(source,next);
      this.sessions[source]=next;
      return validateTaskSession(next);
    });
  }

  async load(source,now) {
    if (!this.loaded[source]) {
      if (typeof this.state.loadPersonalAssistantTaskSession===
          "function") {
        const loaded=
          await this.state.loadPersonalAssistantTaskSession(source,now);
        this.sessions[source]=loaded.session;
        this.expiredTaskIds[source]=loaded.expiredTaskId;
      } else {
        this.sessions[source]=
          await this.state.getPersonalAssistantTaskSession(source,now);
      }
      this.loaded[source]=true;
    } else if (this.sessions[source]&&
        Date.parse(now)>Date.parse(this.sessions[source].expiresAt)) {
      this.expiredTaskIds[source]=this.sessions[source].taskId;
      await this.state.clearPersonalAssistantTaskSession(source);
      this.sessions[source]=null;
    }
    return this.sessions[source];
  }

  mutate(source,operation) {
    const next=this.mutations[source].then(operation);
    this.mutations[source]=next.catch(()=>{});
    return next;
  }
}

function validateSource(source) {
  if (!SOURCES.has(source)) {
    throw new Error("task_session_manager_invalid");
  }
}

function validateBinding(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.userId!=="string"||!value.userId||
      typeof value.conversationId!=="string"||
      !value.conversationId) {
    throw new Error("task_session_manager_invalid");
  }
}

function validateBoundMessage(message,bindings) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      !SOURCES.has(message.source)) {
    throw new Error("task_session_manager_invalid");
  }
  const binding=bindings[message.source];
  if (!binding||message.userId!==binding.userId||
      message.conversationId!==binding.conversationId) {
    throw new Error("task_session_manager_invalid");
  }
}

function validateSnapshot(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.taskId!=="string"||
      !Number.isSafeInteger(value.revision)||
      !value.session) {
    throw new Error("task_session_manager_invalid");
  }
  const session=validateTaskSession(value.session);
  if (session.taskId!==value.taskId||
      session.revision!==value.revision) {
    throw new Error("task_session_manager_invalid");
  }
}

function validateStageResult(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.status!=="string"||
      !(value.reply===null||typeof value.reply==="string")||
      !Array.isArray(value.artifacts||[])||
      !Array.isArray(value.replyFiles||[])||
      typeof value.noReplyRequired!=="boolean") {
    throw new Error("task_session_manager_invalid");
  }
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function validateAddedSourceIds(value) {
  if (!Array.isArray(value)||value.length>8||
      new Set(value).size!==value.length||
      value.some(item=>!/^source-00[1-8]$/u.test(item))) {
    throw new Error("task_session_manager_invalid");
  }
}

function sameArray(left,right) {
  return left.length===right.length&&
    left.every((value,index)=>value===right[index]);
}
