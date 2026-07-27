import {assertContentSafe} from "./content-safety.mjs";
import {buildAgentTurnContext} from "./context-builder.mjs";
import {getModelToolDeclarations} from "./tool-definitions.mjs";
import {executeSaveKnowledge} from "./tools/save-knowledge.mjs";

export class PersonalAssistantCoordinator {
  constructor({
    prepareSource,assistant,writer,outcomeStore,messenger,
    personalRules,model,skillVersion
  }) {
    this.prepareSource=prepareSource;
    this.assistant=assistant;
    this.writer=writer;
    this.outcomeStore=outcomeStore;
    this.messenger=messenger;
    this.personalRules=[...personalRules];
    this.model=model;
    this.skillVersion=skillVersion;
  }

  async handle(message) {
    const key=`${message.source}:${message.sourceMessageId}`;
    const existing=await this.outcomeStore.get(key);
    if (existing) {
      if (existing.reply) {
        await this.messenger.send(
          existing.replyTarget||message.replyTarget,
          existing.reply
        );
      }
      return existing;
    }
    const prepared=await this.prepareSource(message);
    assertContentSafe({
      instructionText:message.instructionText,
      evidence:prepared?.evidence??null,
      conversation:null,
      limits:{maxContextBytes:512*1024}
    });
    const context=buildAgentTurnContext({
      message,
      evidence:prepared?.evidence??null,
      conversation:null,
      personalRules:this.personalRules,
      model:this.model,
      toolDeclarations:getModelToolDeclarations()
    });
    const decision=await this.assistant.decide(context);
    let result;
    if (decision.kind==="reply") {
      result={status:"committed",reply:decision.text,artifacts:[]};
    } else if (decision.kind==="ask") {
      result={status:"awaiting_clarification",reply:decision.question,artifacts:[]};
    } else if (decision.toolCall.name==="save_knowledge") {
      result=await executeSaveKnowledge({
        toolCall:decision.toolCall,
        preparedSource:prepared.preparedSource,
        writer:this.writer,
        skillVersion:this.skillVersion,
        ingestedAt:message.receivedAt
      });
    } else {
      result={
        status:"rejected",
        reply:"当前任务暂时没有可安全执行的工具。",
        artifacts:[]
      };
    }
    const outcome={
      ...result,
      replyTarget:structuredClone(message.replyTarget)
    };
    await this.outcomeStore.save(outcome,key);
    if (outcome.reply) await this.messenger.send(outcome.replyTarget,outcome.reply);
    return outcome;
  }
}
