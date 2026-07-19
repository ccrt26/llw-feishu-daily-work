import test from "node:test";
import assert from "node:assert/strict";
import {createInvoiceCapability} from "../src/capabilities/invoice/capability.mjs";
import {validateInvoiceDecision} from "../src/capabilities/invoice/decision-validator.mjs";

const event={messageId:"m1",messageType:"image",content:"![Image](img_abc)",senderId:"u",chatId:"c",chatType:"p2p"};

function decision(action="archive_dining",format="png") {
  return {
    action,confidence:action==="archive_dining"?"high":"low",reason:"核验结果",question:action==="needs_clarification"?"项目类别无法确认，请确认票面类别。":"",
    invoice:{invoice_number:"INV123",issue_date:"2026-07-18",buyer_name:"亚信科技（成都）有限公司",buyer_tax_id:"91510100732356360H",seller_name:"餐厅",item_name:"餐饮服务",total_with_tax:"290.00",file_format:format},
    buyer_verification:"exact_match",category:action==="needs_clarification"?"uncertain":"dining",document_verification:"single_invoice"
  };
}

function harness({kind="supported_image",raw,archive,failAt="",prepareCode="pdf_render_invalid"}={}) {
  const format=kind === "pdf" ? "pdf" : "png";
  const extension=kind === "pdf" ? "pdf" : "png";
  const selectedRaw=raw ?? decision("archive_dining",format);
  const selectedArchive=archive ?? {status:"committed",relativePath:`亚信工作/日常发票/餐饮发票/2026年07月/290.00.${extension}`};
  const calls={download:0,inspect:0,prepare:0,decide:0,write:0,cleanup:0,decideInput:null,writeInput:null};
  const capability=createInvoiceCapability({
    download:async () => {calls.download++; if(failAt==="download") throw new Error("secret download"); return {tempDir:"/tmp/job-safe",file:`/tmp/job-safe/invoice.${extension}`};},
    inspect:async () => {calls.inspect++; if(failAt==="inspect") throw new Error("secret inspect"); return {kind,format,extension,sizeBytes:10};},
    preparePdf:async ({file}) => {
      calls.prepare++;
      if (failAt==="prepare") throw Object.assign(new Error(`secret:${prepareCode}`),{code:prepareCode});
      return {originalFile:file,detectedFormat:"pdf",archiveExtension:"pdf",pageImages:[`${file}.page-1.png`],extractedText:"text",documentFacts:{pageCount:1,textAvailable:true}};
    },
    decide:async input => {calls.decide++; calls.decideInput=structuredClone(input); if(failAt==="decide") throw new Error("secret ai"); return structuredClone(selectedRaw);},
    validate:validateInvoiceDecision,
    writer:{archive:async input => {calls.write++; calls.writeInput=structuredClone(input); if(failAt==="write") throw new Error("secret writer"); return structuredClone(selectedArchive);}},
    cleanup:async () => {calls.cleanup++;}
  });
  return {capability,calls};
}

test("committed and existing image archives get independent exact outcomes",async () => {
  const h=harness();
  assert.equal(h.capability.name,"invoice"); assert.equal(h.capability.match(event),true); assert.equal(h.capability.match({...event,messageType:"text"}),false);
  const first=await h.capability.handle(event);
  assert.equal(first.status,"committed"); assert.match(first.reply,/发票已归档\n/); assert.match(first.reply,/290.00 元/); assert.equal(first.artifacts.length,1); assert.equal(h.calls.cleanup,1);
  assert.equal(h.calls.prepare,0); assert.equal(h.calls.decideInput.analysisInput.pageImages.length,1);
  const secondHarness=harness({archive:{status:"existing",relativePath:"亚信工作/日常发票/餐饮发票/2026年07月/290.00.png"}});
  const second=await secondHarness.capability.handle({...event,messageId:"m2",content:"![Image](img_def)"});
  assert.equal(second.status,"existing"); assert.match(second.reply,/文件已存在，未重复复制/); assert.equal(secondHarness.calls.cleanup,1);
});

test("PDF prepares every page input and archives only the original PDF",async () => {
  const h=harness({kind:"pdf"});
  const result=await h.capability.handle({...event,messageType:"file",content:'<file key="file_abc"/>'});
  assert.equal(result.status,"committed");
  assert.equal(h.calls.prepare,1); assert.equal(h.calls.decide,1); assert.equal(h.calls.write,1); assert.equal(h.calls.cleanup,1);
  assert.equal(h.calls.decideInput.analysisInput.detectedFormat,"pdf");
  assert.equal(h.calls.writeInput.source,"/tmp/job-safe/invoice.pdf");
  assert.equal(h.calls.writeInput.extension,"pdf");
});

test("buyer mismatch and uncertain category never call writer",async () => {
  const rejected=decision("reject"); rejected.confidence="high"; rejected.reason="购买方名称不匹配"; rejected.invoice.buyer_name="其他公司"; rejected.buyer_verification="name_mismatch";
  const a=harness({raw:rejected}); const result=await a.capability.handle(event);
  assert.equal(result.status,"rejected"); assert.match(result.reply,/未通过入库核验/); assert.equal(a.calls.write,0); assert.equal(a.calls.cleanup,1);
  const b=harness({raw:decision("needs_clarification")}); const unclear=await b.capability.handle(event);
  assert.equal(unclear.status,"awaiting_clarification"); assert.match(unclear.reply,/需要确认/); assert.equal(b.calls.write,0); assert.equal(b.calls.cleanup,1);
});

test("missing, unclear, tax-mismatched and non-dining decisions never call writer",async () => {
  const mutations=[
    d=>{d.invoice.buyer_name="";d.buyer_verification="name_missing";d.question="购买方名称缺失，请重新发送清晰票面。";},
    d=>{d.invoice.buyer_name="";d.buyer_verification="name_unclear";d.question="购买方名称模糊，请重新发送清晰票面。";},
    d=>{d.action="reject";d.confidence="high";d.invoice.buyer_tax_id="OTHER";d.buyer_verification="tax_id_mismatch";d.question="";d.reason="购买方税号不匹配";},
    d=>{d.category="non_dining";d.question="票面项目明确非餐饮，请确认目标类别。";}
  ];
  for (const mutate of mutations) {
    const raw=decision("needs_clarification"); mutate(raw);
    const h=harness({raw}); const result=await h.capability.handle(event);
    assert.ok(["awaiting_clarification","rejected"].includes(result.status)); assert.equal(h.calls.write,0); assert.equal(h.calls.cleanup,1);
  }
});

for (const [state,pattern] of [
  ["multiple_invoices",/拆分为一张发票一个 PDF/],
  ["conflicting_fields",/不同页面关键字段冲突/],
  ["unclear",/无法确认整份 PDF 只含一张完整发票/]
]) test(`PDF document state ${state} gets a fixed clarification and never writes`,async () => {
  const raw=decision("needs_clarification","pdf"); raw.document_verification=state;
  const h=harness({kind:"pdf",raw});
  const result=await h.capability.handle({...event,messageType:"file",content:'<file key="file_abc"/>'});
  assert.equal(result.status,"awaiting_clarification"); assert.match(result.reply,pattern); assert.equal(h.calls.write,0); assert.equal(h.calls.cleanup,1);
});

for (const [code,pattern] of [
  ["pdf_encrypted",/加密保护/], ["pdf_page_limit",/10 页上限/], ["pdf_structure_invalid",/结构无法安全解析/],
  ["pdf_text_invalid",/页面无法完整呈现/], ["pdf_render_invalid",/页面无法完整呈现/], ["pdf_prepare_timeout",/页面处理超时/]
]) test(`PDF preparation error ${code} is safe and never reaches AI`,async () => {
  const h=harness({kind:"pdf",failAt:"prepare",prepareCode:code});
  const result=await h.capability.handle({...event,messageType:"file",content:'<file key="file_abc"/>'});
  assert.equal(result.status,code==="pdf_encrypted"||code==="pdf_page_limit"?"rejected":"failed");
  assert.match(result.reply,pattern); assert.equal(result.reply.includes("secret"),false);
  assert.equal(h.calls.decide,0); assert.equal(h.calls.write,0); assert.equal(h.calls.cleanup,1);
});

for (const kind of ["ofd","unsupported"]) test(`${kind} gets a fixed non-AI result`,async () => {
  const h=harness({kind}); const result=await h.capability.handle({...event,messageType:"file",content:'<file key="file_abc"/>'});
  assert.equal(result.status,"rejected"); assert.equal(h.calls.prepare,0); assert.equal(h.calls.decide,0); assert.equal(h.calls.write,0); assert.equal(h.calls.cleanup,1);
  assert.match(result.reply,kind==="ofd"?/OFD/:/不支持此附件格式/);
});

for (const stage of ["download","inspect","decide","write"]) test(`${stage} failure returns only safe text and cleans downloaded files`,async () => {
  const h=harness({failAt:stage}); const result=await h.capability.handle(event);
  assert.equal(result.status,"failed"); assert.match(result.reply,/发票处理失败，文件未归档/); assert.equal(result.reply.includes("secret"),false);
  assert.equal(h.calls.cleanup,stage==="download"?0:1);
});

test("malformed resource marker is rejected before download",async () => {
  const h=harness(); const result=await h.capability.handle({...event,content:"x![Image](img_abc)"});
  assert.equal(result.status,"failed"); assert.match(result.reply,/附件标识无法安全解析/); assert.equal(h.calls.download,0);
});
