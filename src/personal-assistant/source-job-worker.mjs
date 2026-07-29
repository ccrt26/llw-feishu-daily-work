import {isPreparedSourceSetId} from "./source-job-store.mjs";

const TERMINAL=new Set(["completed","cancelled","expired"]);

export class SourceJobWorker {
  constructor({store,run,onFailure=()=>{}}) {
    if (!store||typeof store.get!=="function"||
        typeof store.requestCancel!=="function"||
        typeof store.transition!=="function"||
        typeof run!=="function"||typeof onFailure!=="function") {
      throw new Error("source_job_worker_invalid");
    }
    this.store=store;
    this.run=run;
    this.onFailure=onFailure;
    this.queue=[];
    this.queuedIds=new Set();
    this.running=null;
    this.draining=false;
    this.flushWaiters=[];
  }

  submit(binding) {
    validateBinding(binding);
    const id=binding.preparedSourceSetId;
    if (this.queuedIds.has(id)) return {status:"duplicate"};
    this.queuedIds.add(id);
    this.queue.push(frozenBinding(binding));
    this.kick();
    return {status:"queued"};
  }

  async requestCancel(binding) {
    validateBinding(binding);
    const job=await this.store.requestCancel(binding);
    if (this.running?.binding.preparedSourceSetId===
        binding.preparedSourceSetId) {
      this.running.controller.abort();
    }
    return job;
  }

  flush() {
    if (!this.draining&&!this.running&&!this.queue.length) {
      return Promise.resolve();
    }
    return new Promise(resolve=>this.flushWaiters.push(resolve));
  }

  kick() {
    if (this.draining) return;
    this.draining=true;
    queueMicrotask(()=>this.drain());
  }

  async drain() {
    while (this.queue.length) {
      const binding=this.queue.shift();
      const controller=new AbortController();
      this.running={binding,controller};
      try {
        await this.run({
          ...binding,signal:controller.signal
        });
        await this.finishCancellation(binding);
      } catch (error) {
        try {
          if (controller.signal.aborted) {
            await this.finishCancellation(binding);
          } else {
            await this.finishFailure(binding);
            this.onFailure("source_job_worker_failed");
          }
        } catch {
          try { this.onFailure("source_job_state_failed"); } catch {}
        }
      } finally {
        this.running=null;
        this.queuedIds.delete(binding.preparedSourceSetId);
      }
    }
    this.draining=false;
    const waiters=this.flushWaiters.splice(0);
    for (const resolve of waiters) resolve();
    if (this.queue.length) this.kick();
  }

  async finishCancellation(binding) {
    const job=await this.store.get(binding);
    if (!job.cancelRequested||TERMINAL.has(job.state)) return;
    await this.store.transition({
      ...binding,from:job.state,to:"cancelled"
    });
  }

  async finishFailure(binding) {
    const job=await this.store.get(binding);
    if (TERMINAL.has(job.state)||job.state==="failed") return;
    await this.store.transition({
      ...binding,from:job.state,to:"failed",
      patch:{
        failure:{code:"source_job_worker_failed",recoverable:true}
      }
    });
  }
}

function validateBinding(binding) {
  if (!binding||typeof binding!=="object"||Array.isArray(binding)||
      !isPreparedSourceSetId(binding.preparedSourceSetId)||
      !new Set(["feishu","wechat"]).has(binding.source)||
      typeof binding.userId!=="string"||!binding.userId||
      typeof binding.conversationId!=="string"||
      !binding.conversationId) {
    throw new Error("source_job_worker_invalid");
  }
}

function frozenBinding(binding) {
  return Object.freeze({
    preparedSourceSetId:binding.preparedSourceSetId,
    source:binding.source,
    userId:binding.userId,
    conversationId:binding.conversationId
  });
}
