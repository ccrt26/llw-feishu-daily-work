export class SourceBurstCollector {
  constructor({
    quietMs,maxMs,maxSources,now=Date.now,
    setTimer=globalThis.setTimeout,
    clearTimer=globalThis.clearTimeout,
    onReady
  }) {
    if (!Number.isSafeInteger(quietMs)||quietMs<1||quietMs>5_000||
        !Number.isSafeInteger(maxMs)||maxMs<quietMs||maxMs>15_000||
        !Number.isSafeInteger(maxSources)||maxSources<1||maxSources>8||
        typeof now!=="function"||typeof setTimer!=="function"||
        typeof clearTimer!=="function"||typeof onReady!=="function") {
      throw new Error("source_burst_collector_invalid");
    }
    this.quietMs=quietMs;
    this.maxMs=maxMs;
    this.maxSources=maxSources;
    this.now=now;
    this.setTimer=setTimer;
    this.clearTimer=clearTimer;
    this.onReady=onReady;
    this.collections=new Map();
  }

  accept(message) {
    const collectionKey=keyFor(message);
    const eventKey=eventKeyFor(message);
    const now=this.now();
    if (!Number.isFinite(now)) throw new Error("source_burst_invalid_time");
    let collection=this.collections.get(collectionKey);
    if (collection&&now>=collection.hardAt) {
      this.finalize(collectionKey,collection);
      collection=null;
    }
    if (collection?.eventKeys.has(eventKey)) {
      return {
        status:"held",collectionKey,
        aliases:aliasesOf(collection),reason:"duplicate"
      };
    }
    const addedSources=sourceCount(message);
    const currentSources=collection?.sourceCount??0;
    if (addedSources>this.maxSources||
        currentSources+addedSources>this.maxSources) {
      return {
        status:"rejected",collectionKey,
        aliases:collection?aliasesOf(collection):[],
        reason:"too_many_sources"
      };
    }
    if (!collection) {
      collection={
        key:collectionKey,
        firstAt:now,hardAt:now+this.maxMs,lastAt:now,
        messages:[],eventKeys:new Set(),sourceCount:0,timer:null
      };
      this.collections.set(collectionKey,collection);
    }
    collection.lastAt=now;
    collection.messages.push(structuredClone(message));
    collection.eventKeys.add(eventKey);
    collection.sourceCount+=addedSources;
    this.schedule(collectionKey,collection);
    return {
      status:"held",collectionKey,
      aliases:aliasesOf(collection)
    };
  }

  cancel(message) {
    const collectionKey=keyFor(message);
    const collection=this.collections.get(collectionKey);
    if (!collection) return {collectionKey,messages:[]};
    this.clearTimer(collection.timer);
    this.collections.delete(collectionKey);
    return {
      collectionKey,
      messages:collection.messages.map(value=>structuredClone(value))
    };
  }

  flushAll() {
    for (const [key,collection] of [...this.collections]) {
      this.finalize(key,collection);
    }
  }

  schedule(key,collection) {
    if (collection.timer!==null) this.clearTimer(collection.timer);
    const deadline=Math.min(
      collection.lastAt+this.quietMs,collection.hardAt
    );
    collection.timer=this.setTimer(()=>{
      if (this.collections.get(key)!==collection) return;
      this.finalize(key,collection);
    },Math.max(0,deadline-this.now()));
    collection.timer?.unref?.();
  }

  finalize(key,collection) {
    if (this.collections.get(key)!==collection) return;
    if (collection.timer!==null) this.clearTimer(collection.timer);
    this.collections.delete(key);
    const canonical=combine(collection.messages);
    this.onReady({
      collectionKey:key,
      message:canonical,
      aliases:collection.messages.slice(1).map(value=>structuredClone(value))
    });
  }
}

function combine(messages) {
  const canonical=structuredClone(messages[0]);
  const instructions=messages
    .map(message=>message.instructionText.trim())
    .filter(Boolean);
  canonical.instructionText=instructions.join("\n");
  canonical.attachments=messages.flatMap(message=>
    message.attachments.map(attachment=>structuredClone(attachment))
  );
  const latest=messages.at(-1);
  canonical.receivedAt=latest.receivedAt;
  canonical.replyTarget=structuredClone(latest.replyTarget);
  return canonical;
}

function aliasesOf(collection) {
  return collection.messages.slice(1).map(value=>value.sourceMessageId);
}

function sourceCount(message) {
  if (!message||!Array.isArray(message.attachments)) {
    throw new Error("source_burst_invalid_message");
  }
  return message.attachments.length;
}

function keyFor(message) {
  for (const field of ["source","userId","conversationId"]) {
    if (typeof message?.[field]!=="string"||!message[field]) {
      throw new Error("source_burst_invalid_message");
    }
  }
  return `${message.source}\0${message.userId}\0${message.conversationId}`;
}

function eventKeyFor(message) {
  if (typeof message?.sourceMessageId!=="string"||!message.sourceMessageId) {
    throw new Error("source_burst_invalid_message");
  }
  return `${message.source}\0${message.sourceMessageId}`;
}
