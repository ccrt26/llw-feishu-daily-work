import {normalizeEvent} from "../core/event-normalizer.mjs";
import {
  checkIncomingSecurity,checkSecurity
} from "../core/security-gate.mjs";
import {createFeishuIncomingMessage} from "../core/incoming-message.mjs";
import {handleModelCommand} from "../core/model-command.mjs";
import {
  classifyDisabledMediaInput,DEFAULT_MEDIA_INPUT_GATES,
  isUnsupportedMediaExtension,normalizeMediaInputGates
} from "../core/media-support.mjs";
import {SourceBurstCollector} from "./source-burst-collector.mjs";
import {
  classifyTaskControl
} from "./task-session.mjs";

export class PersonalAssistantDispatcher {
  constructor({
    binding,bindings,state,coordinator,modelMode,deepseekEnabled,messenger,
    taskManager,taskWorkspace=null,cancelTaskWork=async()=>{},
    onFailure=()=>{},sourceBurstQuietMs=0,
    sourceBurstMaxMs=sourceBurstQuietMs?15_000:0,
    sourceBurstAttachmentQuietMs=sourceBurstQuietMs,
    mediaInputGates=DEFAULT_MEDIA_INPUT_GATES,
    maxSourcesPerTurn=8,
    now=Date.now,setTimer=globalThis.setTimeout,
    clearTimer=globalThis.clearTimeout
  }) {
    this.binding=binding;
    this.bindings=bindings;
    this.state=state;
    this.coordinator=coordinator;
    this.taskManager=taskManager;
    this.taskWorkspace=taskWorkspace;
    this.cancelTaskWork=cancelTaskWork;
    this.modelMode=modelMode;
    this.deepseekEnabled=deepseekEnabled;
    this.messenger=messenger;
    this.onFailure=typeof onFailure==="function"?onFailure:()=>{};
    this.mediaInputGates=normalizeMediaInputGates(mediaInputGates);
    if (!taskManager||
        !Number.isSafeInteger(sourceBurstQuietMs)||
        sourceBurstQuietMs<0||sourceBurstQuietMs>5_000||
        !Number.isSafeInteger(sourceBurstAttachmentQuietMs)||
        (sourceBurstQuietMs===0&&(
          sourceBurstMaxMs!==0||sourceBurstAttachmentQuietMs!==0
        ))||
        (sourceBurstQuietMs>0&&(
          sourceBurstAttachmentQuietMs<sourceBurstQuietMs||
          sourceBurstAttachmentQuietMs>sourceBurstMaxMs
        ))) {
      throw new Error("invalid_coalesce_window");
    }
    this.acceptedTasks=new Set();
    this.acceptedMessageKeys=new Set();
    this.runningSources=new Set();
    this.rescheduleSources=new Set();
    this.queue=Promise.resolve();
    this.sourceCollector=sourceBurstQuietMs
      ?new SourceBurstCollector({
        quietMs:sourceBurstQuietMs,
        attachmentQuietMs:sourceBurstAttachmentQuietMs,
        maxMs:sourceBurstMaxMs,
        maxSources:maxSourcesPerTurn,now,setTimer,clearTimer,
        onReady:({message})=>this.scheduleTask(message.source)
      })
      :null;
  }

  acceptRawEvent(raw) {
    let event;
    try {
      event=normalizeEvent(raw);
    } catch {
      return Promise.resolve({handled:false,reason:"invalid_event"});
    }
    const security=checkSecurity(event,this.binding);
    if (!security.ok) return Promise.resolve({
      handled:false,reason:security.reason
    });
    let message;
    try {
      message=createFeishuIncomingMessage(event);
    } catch {
      return Promise.resolve({handled:false,reason:"invalid_message"});
    }
    return this.acceptIncomingMessage(message);
  }

  async acceptIncomingMessage(message) {
    const security=checkIncomingSecurity(message,this.bindings);
    if (!security.ok) return {
      handled:false,reason:security.reason
    };
    if (!validTurnShape(message)) {
      return {handled:false,reason:"invalid_message"};
    }
    if (!message.instructionText.trim()&&!message.attachments.length) {
      return {handled:false,reason:"empty_message"};
    }
    const key=personalOutcomeKey(message);
    if (this.state.hasOutcome(key)||this.acceptedMessageKeys.has(key)) {
      return {handled:false,reason:"duplicate"};
    }
    const mediaGate=classifyDisabledMediaInput(
      message,this.mediaInputGates
    );
    if (mediaGate) {
      this.scheduleUnsupportedMedia(
        message,mediaInputGateCommand(mediaGate)
      );
      return {handled:true,status:"rejected"};
    }
    if (hasUnsupportedMedia(message)) {
      this.scheduleUnsupportedMedia(message,unsupportedMediaCommand());
      return {handled:true,status:"rejected"};
    }
    return this.acceptTaskInput(message);
  }

  async handleTaskIncomingMessage(message) {
    const result=await this.acceptIncomingMessage(message);
    if (!result.handled||result.status!=="accepted") return result;
    await this.flushAcceptedMessages();
    const outcome=this.state.getOutcome?.(personalOutcomeKey(message));
    return {
      handled:true,
      status:outcome?.status??result.status
    };
  }

  async recoverPendingTasks() {
    if (!this.taskManager) return [];
    const sources=await this.taskManager.recoverPending();
    for (const source of sources) this.scheduleTask(source);
    return [...sources];
  }

  async acceptTaskInput(message) {
    const control=classifyTaskControl({
      instructionText:message.instructionText,
      hasAttachments:message.attachments.length>0
    });
    if (control) return this.handleTaskControl(message,control);
    if (!message.attachments.length) {
      const command=await handleModelCommand(message.instructionText,{
        modelMode:this.modelMode,deepseekEnabled:this.deepseekEnabled
      });
      if (command) {
        this.scheduleTaskCommand(message,command);
        return {handled:true,status:command.status};
      }
    }
    const current=this.taskManager.current(message.source);
    if (current?.writerCheckpoint?.status==="cancel_requested") {
      this.scheduleTaskCommand(message,{
        status:"existing",
        reply:"当前写入正在结束；完成后会按实际结果告知。请稍后再发送新的要求。"
      });
      return {handled:true,status:"existing"};
    }
    if (current?.status==="active"&&
        current.sourceIds.length+
          current.pendingInputs.reduce(
            (count,input)=>count+input.attachments.length,0
          )+
          message.attachments.length>8) {
      this.scheduleRejectedSource(message);
      return {handled:true,status:"rejected"};
    }
    let accepted;
    try {
      accepted=await this.taskManager.accept(message);
    } catch (error) {
      if (error?.message!=="task_session_invalid") throw error;
      this.scheduleRejectedSource(message);
      return {handled:true,status:"rejected"};
    }
    if (accepted.duplicate) {
      return {handled:false,reason:"duplicate"};
    }
    if (accepted.replacedTaskId&&this.taskWorkspace) {
      await this.taskWorkspace.remove({
        taskId:accepted.replacedTaskId
      });
    }
    if (this.sourceCollector) {
      this.sourceCollector.accept({
        ...message,
        instructionText:message.instructionText||"已接收来源",
        attachments:[]
      });
    } else {
      this.scheduleTask(message.source);
    }
    return {handled:true,status:"accepted"};
  }

  async handleTaskControl(message,control) {
    const source=message.source;
    if (control.kind==="new_task") {
      const closed=await this.taskManager.close(
        source,"new_task",message.receivedAt
      );
      await this.releaseClosedTask(closed,"new_task");
      if (control.instructionText) {
        const replacement={
          ...message,
          instructionText:control.instructionText
        };
        const accepted=await this.taskManager.accept(replacement);
        if (this.sourceCollector) {
          this.sourceCollector.accept({
            ...replacement,attachments:[]
          });
        } else {
          this.scheduleTask(source);
        }
        return {
          handled:true,
          status:accepted.duplicate?"existing":"accepted"
        };
      }
      this.scheduleTaskCommand(message,{
        status:"committed",
        reply:"当前任务已结束，请直接发送新的要求。"
      });
      return {handled:true,status:"committed"};
    }
    if (control.kind==="cancel"||control.kind==="end") {
      const closed=control.kind==="cancel"
        ?await this.taskManager.cancel(source,message.receivedAt)
        :await this.taskManager.close(
          source,"ended",message.receivedAt
        );
      const writerFinishing=Boolean(
        closed?.writerCheckpoint?.status==="cancel_requested"
      );
      if (!writerFinishing) {
        await this.releaseClosedTask(closed,control.kind);
      }
      this.scheduleTaskCommand(message,{
        status:"committed",
        reply:writerFinishing
          ?"已收到取消；写入已经开始，无法安全撤回。完成后会按实际结果告知，之后不再继续当前任务。"
          :control.kind==="cancel"
          ?"已取消，当前任务不会继续处理或保存。"
          :"当前任务已结束。"
      });
      return {handled:true,status:"committed"};
    }
    if (control.kind==="pause") {
      let paused=null;
      try {
        paused=await this.taskManager.pause(
          source,message.receivedAt
        );
      } catch (error) {
        if (error?.message!=="task_session_invalid") throw error;
      }
      this.scheduleTaskCommand(message,{
        status:paused?"committed":"existing",
        reply:paused
          ?"当前任务已暂停；需要继续时直接说“继续刚才的”。"
          :"当前没有可暂停的任务。"
      });
      return {
        handled:true,status:paused?"committed":"existing"
      };
    }
    if (control.kind==="resume") {
      let resumed=null;
      try {
        resumed=await this.taskManager.resume(
          source,message.receivedAt
        );
      } catch (error) {
        if (error?.message!=="task_session_invalid") throw error;
      }
      if (resumed?.pendingInputs.length) this.scheduleTask(source);
      this.scheduleTaskCommand(message,{
        status:resumed?"committed":"existing",
        reply:resumed
          ?"已继续当前任务。"
          :"当前没有已暂停且可继续的任务。"
      });
      return {
        handled:true,status:resumed?"committed":"existing"
      };
    }
    throw new Error("task_control_invalid");
  }

  async releaseClosedTask(session,reason) {
    if (!session) return;
    const reasonCode=new Map([
      ["cancel","cancelled"],
      ["end","ended"],
      ["new_task","replaced_by_new_task"]
    ]).get(reason)||"task_closed";
    for (const input of session.pendingInputs) {
      if (this.state.hasOutcome(input.messageKey)) continue;
      await this.state.saveOutcome(input.messageKey,{
        capability:"personal-assistant",
        status:"ignored",
        reply:null,
        artifacts:[],
        replyFiles:[],
        noReplyRequired:true,
        reasonCode,
        createdAt:input.receivedAt
      });
    }
    await this.cancelTaskWork({
      source:session.source,
      taskId:session.taskId,
      reason
    });
    if (this.taskWorkspace) {
      await this.taskWorkspace.remove({taskId:session.taskId});
    }
  }

  scheduleTaskCommand(message,command) {
    const key=personalOutcomeKey(message);
    const task=this.enqueue(
      ()=>this.persistAndSendCommand(key,message,command)
    );
    this.trackTask(task,[key]);
  }

  scheduleTask(source) {
    if (!this.taskManager) {
      throw new Error("task_session_manager_required");
    }
    if (this.runningSources.has(source)) {
      this.rescheduleSources.add(source);
      return;
    }
    this.runningSources.add(source);
    let snapshot=null;
    const task=(async()=>{
      try {
        snapshot=await this.taskManager.claim(source);
        if (!snapshot) return;
        const result=await this.coordinator.handleTask(snapshot);
        if (result?.status==="stale") {
          this.rescheduleSources.add(source);
        }
      } catch (error) {
        if (snapshot) {
          await this.commitTaskFailure(snapshot,error).catch(()=>{});
        } else {
          try {
            this.onFailure(boundedFailureCode(error));
          } catch {}
        }
      } finally {
        this.runningSources.delete(source);
        const current=this.taskManager.current(source);
        if (!current&&snapshot&&this.taskWorkspace) {
          await this.taskWorkspace.remove({
            taskId:snapshot.taskId
          }).catch(()=>{});
        }
        const requested=this.rescheduleSources.delete(source);
        const hasNewerInput=Boolean(
          current?.status==="active"&&snapshot&&
          current.pendingInputs.some(
            input=>input.revision>snapshot.revision
          )
        );
        const shouldRun=current?.status==="active"&&(
          requested||hasNewerInput
        );
        if (shouldRun) this.scheduleTask(source);
      }
    })();
    this.trackTask(task);
  }

  async commitTaskFailure(snapshot,error) {
    const reasonCode=boundedFailureCode(error);
    try {
      this.onFailure(failureLogCode(error,reasonCode));
    } catch {}
    const reply=failureReply(reasonCode,error);
    const committed=await this.taskManager.completeStage(snapshot,{
      status:"failed",
      reply,
      artifacts:[],
      replyFiles:[],
      noReplyRequired:false,
      reasonCode,
      waiting:null
    });
    if (!committed) {
      this.rescheduleSources.add(snapshot.session.source);
      return;
    }
    const key=snapshot.inputKeys.at(-1);
    const outcome=this.state.getOutcome?.(key);
    if (!outcome?.reply) return;
    if (typeof this.coordinator.sendOutcome==="function") {
      await this.coordinator.sendOutcome(
        key,outcome,outcome.replyTarget
      );
      return;
    }
    await this.messenger.send({
      capability:"personal-assistant",
      replyTarget:outcome.replyTarget,
      text:outcome.reply,
      idempotencyKey:`reply:${key}`,
      replyFiles:outcome.replyFiles||[]
    });
    await this.state.markReplied?.(key);
  }

  scheduleUnsupportedMedia(message,command) {
    const key=personalOutcomeKey(message);
    const task=this.enqueue(()=>this.persistAndSendCommand(
      key,message,command
    ));
    this.trackTask(task,[key]);
  }

  scheduleRejectedSource(message) {
    const key=personalOutcomeKey(message);
    const task=this.enqueue(()=>this.persistAndSendCommand(key,message,{
      status:"rejected",
      reply:"一次最多处理 8 个文件；超出的文件未加入本轮，请分开发送。",
      reasonCode:"too_many_sources"
    }));
    this.trackTask(task,[key]);
  }

  trackTask(task,keys=[]) {
    for (const key of keys) this.acceptedMessageKeys.add(key);
    this.acceptedTasks.add(task);
    task.catch(()=>{
      try { this.onFailure("personal_assistant_failed"); } catch {}
    }).finally(()=>{
      this.acceptedTasks.delete(task);
      for (const key of keys) this.acceptedMessageKeys.delete(key);
    });
  }

  async flushAcceptedMessages() {
    this.sourceCollector?.flushAll();
    while (this.acceptedTasks.size) {
      await Promise.allSettled([...this.acceptedTasks]);
    }
    await this.queue;
  }

  enqueue(operation) {
    const next=this.queue.then(operation);
    this.queue=next.catch(()=>{});
    return next;
  }

  async persistAndSendCommand(key,message,draft) {
    const outcome={
      capability:"personal-assistant",
      status:draft.status,reply:draft.reply,artifacts:[],
      replyFiles:[],noReplyRequired:false,
      replyTarget:structuredClone(message.replyTarget),
      createdAt:new Date().toISOString(),
      ...(draft.reasonCode?{reasonCode:draft.reasonCode}:{})
    };
    await this.state.saveOutcome(key,outcome);
    await this.messenger.send({
      capability:"personal-assistant",
      replyTarget:message.replyTarget,text:draft.reply,
      idempotencyKey:`reply:${key}`,replyFiles:[]
    });
    await this.state.markReplied(key);
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      await this.coordinator.sendOutcome(
        outcome.messageId,outcome,outcome.replyTarget
      );
    }
  }
}

const SAFE_FAILURE_CODES=new Set([
  "source_receive_failed","source_security_rejected",
  "source_limit_exceeded",
  "content_safety_rejected","agent_turn_context_invalid",
  "personal_rules_invalid","assistant_model_failed",
  "assistant_model_unsupported","provider_result_invalid",
  "assistant_timeout","assistant_process_failed",
  "assistant_result_invalid","pdf_prepare_failed",
  "tool_call_invalid","tool_execution_failed","writer_partial",
  "reply_delivery_failed"
]);
const PRECISE_PRE_WRITER_FAILURES=new Set([
  "assistant_timeout","assistant_process_failed",
  "assistant_result_invalid","pdf_prepare_failed"
]);
const PUBLIC_VIDEO_FAILURE_CODES=new Set([
  "bilibili_url_invalid","bilibili_access_denied",
  "bilibili_control_invalid","bilibili_media_unavailable",
  "bilibili_media_invalid","bilibili_limit_exceeded",
  "bilibili_source_workspace_mode_failed",
  "bilibili_result_metadata_invalid",
  "bilibili_audio_descriptor_invalid",
  "bilibili_video_descriptor_invalid",
  "bilibili_audio_workspace_realpath_failed",
  "bilibili_video_workspace_realpath_failed",
  "bilibili_audio_file_realpath_failed",
  "bilibili_video_file_realpath_failed",
  "bilibili_audio_file_stat_failed",
  "bilibili_video_file_stat_failed",
  "bilibili_audio_file_metadata_invalid",
  "bilibili_video_file_metadata_invalid",
  "bilibili_audio_read_failed","bilibili_video_read_failed",
  "bilibili_audio_hash_mismatch","bilibili_video_hash_mismatch",
  "bilibili_source_handle_invalid"
]);
const SAFE_FAILURE_PHASES=new Set([
  "outcome_lookup_failed","reply_recovery_failed",
  "conversation_lookup_failed","personal_rule_confirmation_failed",
  "model_selection_failed","source_preparation_failed",
  "content_safety_rejected","personal_rules_load_failed",
  "daily_candidates_load_failed","agent_turn_context_invalid",
  "assistant_model_failed","public_video_source_preparation_failed",
  "public_video_prepare_failed",
  "save_knowledge_execution_failed",
  "record_daily_work_execution_failed",
  "archive_dining_invoice_execution_failed",
  "create_document_execution_failed","conversation_state_failed",
  "outcome_persist_failed","reply_delivery_failed"
]);

function boundedFailureCode(error) {
  if (PRECISE_PRE_WRITER_FAILURES.has(error?.message)) {
    return error.message;
  }
  if (SAFE_FAILURE_PHASES.has(error?.failurePhase)) {
    return error.failurePhase;
  }
  if (SAFE_FAILURE_CODES.has(error?.message)) return error.message;
  if (error?.message==="assistant_source_invalid") {
    return "source_security_rejected";
  }
  if (error?.message==="assistant_source_too_large") {
    return "source_limit_exceeded";
  }
  return "tool_execution_failed";
}

function failureLogCode(error,fallback) {
  const code=error?.publicVideoFailureCode;
  return error?.failurePhase===
      "public_video_source_preparation_failed"&&
    PUBLIC_VIDEO_FAILURE_CODES.has(code)
    ?`public_video_source:${code}`
    :fallback;
}

function failureReply(code,error) {
  if (code==="public_video_source_preparation_failed") {
    const specific=publicVideoFailureReply(
      error?.publicVideoFailureCode
    );
    if (specific) return specific;
  }
  return new Map([
    [
      "source_receive_failed",
      "文件未能安全接收，本次没有调用 AI，也没有写入。请重新发送该文件。"
    ],
    [
      "source_security_rejected",
      "文件未通过安全检查，本次没有调用 AI，也没有写入。请确认文件未加密、未损坏且格式正确。"
    ],
    [
      "source_limit_exceeded",
      "文件数量或大小超过本轮上限，本次没有调用 AI，也没有写入。请分开发送。"
    ],
    [
      "assistant_model_unsupported",
      "当前尚未支持这种文件格式，本次没有调用 Writer，也没有写入。"
    ],
    [
      "assistant_model_failed",
      "AI 本次未能完成分析，系统没有确认任何写入；请稍后重试。"
    ],
    [
      "assistant_timeout",
      "AI 分析超过当前时间上限，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "assistant_process_failed",
      "AI 进程本次未能正常完成，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "assistant_result_invalid",
      "AI 返回结果未通过安全校验，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "pdf_prepare_failed",
      "PDF 已安全保留，但页面准备失败，本次没有完成分析，也没有确认任何写入；可以直接重试，不需要重新发送文件。"
    ],
    [
      "public_video_source_preparation_failed",
      "未能完整取得公开视频的音频和画面，本次没有调用转写、AI 或 Writer，也没有确认任何写入；请重新发送同一链接。"
    ],
    [
      "public_video_prepare_failed",
      "公开视频来源已保留，但音频转写或画面准备失败，本次没有完成分析，也没有确认任何写入；可以直接重试。"
    ],
    [
      "tool_call_invalid",
      "AI 返回的操作请求未通过安全校验，系统没有写入；请重试。"
    ]
  ]).get(code)||
    "本次工具执行失败，系统没有确认新的写入；请稍后重试。";
}

function publicVideoFailureReply(code) {
  if (!PUBLIC_VIDEO_FAILURE_CODES.has(code)) return null;
  if (code==="bilibili_url_invalid") {
    return "没有识别到有效的 B 站视频链接，所以没有调用转写、AI 或 Writer，也没有写入。请重新复制并发送该视频链接。";
  }
  if (code==="bilibili_access_denied") {
    return "本次无法访问 B 站视频来源（可能是网络或站点临时拒绝），所以没有调用转写、AI 或 Writer，也没有写入。需要时请重新发送同一链接。";
  }
  if (code==="bilibili_media_unavailable") {
    return "B 站本次没有提供完整可用的音频和画面，所以没有调用转写、AI 或 Writer，也没有写入。需要时请重新发送同一链接。";
  }
  if (code==="bilibili_control_invalid") {
    return "B 站返回的视频信息不完整或异常，系统无法安全确定音频和画面，所以没有调用转写、AI 或 Writer，也没有写入。请重新发送链接；如果持续出现，可能是该视频当前不可读取。";
  }
  if (code==="bilibili_media_invalid") {
    return "取得的 B 站音频或画面内容无效，未通过媒体检查，所以没有调用转写、AI 或 Writer，也没有写入。请重新发送；如果持续出现，可能是该视频当前不可读取。";
  }
  if (code==="bilibili_limit_exceeded") {
    return "该 B 站视频超过当前安全处理上限，所以没有调用转写、AI 或 Writer，也没有写入。请改用更短或更小的视频。";
  }
  return "视频来源已取得，但本地安全校验未通过，所以没有调用转写、AI 或 Writer，也没有写入。请重新发送；如果持续出现，请反馈给维护人员。";
}

function validTurnShape(message) {
  return message&&typeof message==="object"&&!Array.isArray(message)&&
    typeof message.instructionText==="string"&&
    Array.isArray(message.attachments)&&message.attachments.length<=8;
}

function hasUnsupportedMedia(message) {
  return message.attachments.some(attachment=>{
    if (attachment?.type!=="file") return false;
    const declared=typeof attachment.extension==="string"
      ?attachment.extension
      :"";
    const name=typeof attachment.displayName==="string"
      ?attachment.displayName
      :"";
    const extension=(declared||name.split(".").pop()||"")
      .trim().toLowerCase().replace(/^\./u,"");
    return isUnsupportedMediaExtension(extension);
  });
}

function unsupportedMediaCommand() {
  return {
    status:"rejected",
    reply:"当前版本尚未支持音频或视频文件，本次没有调用 AI 或 Writer，也没有写入。",
    reasonCode:"unsupported_media"
  };
}

function mediaInputGateCommand(reasonCode) {
  const reply=new Map([
    [
      "native_voice_disabled",
      "当前阶段原生语音输入尚未启用，本次没有下载、调用 AI 或 Writer，也没有写入。"
    ],
    [
      "audio_file_disabled",
      "当前阶段尚未支持音频或视频文件，本次没有调用 AI 或 Writer，也没有写入。"
    ],
    [
      "local_video_disabled",
      "当前阶段尚未支持音频或视频文件，本次没有调用 AI 或 Writer，也没有写入。"
    ],
    [
      "web_page_disabled",
      "当前阶段网页读取尚未启用，本次没有访问网页、调用 AI 或 Writer，也没有写入。"
    ],
    [
      "bilibili_disabled",
      "当前阶段 B 站视频读取尚未启用，本次没有访问链接、调用 AI 或 Writer，也没有写入。"
    ],
    [
      "douyin_disabled",
      "当前阶段抖音视频读取尚未启用，本次没有访问链接、调用 AI 或 Writer，也没有写入。"
    ]
  ]).get(reasonCode);
  if (!reply) throw new Error("media_input_gate_invalid");
  return {status:"rejected",reply,reasonCode};
}

export function personalOutcomeKey(message) {
  if (!new Set(["feishu","wechat"]).has(message?.source)||
      typeof message.sourceMessageId!=="string"||
      !message.sourceMessageId) {
    throw new Error("invalid_incoming_message");
  }
  return `${message.source}:${message.sourceMessageId}`;
}
