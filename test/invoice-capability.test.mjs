import test from "node:test";
import assert from "node:assert/strict";
import {createInvoiceCapability} from "../src/capabilities/invoice/capability.mjs";
import {
  validateInvoiceExtraction,
  deriveInvoiceRuleDecision
} from "../src/capabilities/invoice/decision-validator.mjs";

const event={
  source:"feishu",sourceMessageId:"m1",userId:"u",conversationId:"c",receivedAt:"2026-07-19T02:00:00.000Z",
  attachments:[{type:"image",sourceAttachmentId:"img_abc",displayName:"飞书图片",extension:""}],
  replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c"}
};
const fileEvent={...event,attachments:[{type:"file",sourceAttachmentId:"file_abc",displayName:"发票.pdf",extension:"pdf"}]};

function extraction(overrides={}) {
  return {
    invoice:{
      invoice_number:"INV123",
      issue_date:"2026-07-18",
      buyer_name:"亚信科技（成都）有限公司",
      buyer_tax_id:"91510100732356360H",
      seller_name:"测试餐厅",
      item_name:"餐饮服务",
      total_with_tax:"290.00",
      ...(overrides.invoice||{})
    },
    field_quality:{
      invoice_number:"clear",
      issue_date:"clear",
      buyer_name:"clear",
      buyer_tax_id:"clear",
      seller_name:"clear",
      item_name:"clear",
      total_with_tax:"clear",
      ...(overrides.field_quality||{})
    },
    category:overrides.category??"dining",
    document_verification:overrides.document_verification??"single_invoice",
    ...(overrides.extra||{})
  };
}

function harness({kind="supported_image",raw,archive,failAt="",prepareCode="pdf_render_invalid"}={}) {
  const format=kind==="pdf"?"pdf":"png";
  const extension=kind==="pdf"?"pdf":"png";
  const selectedRaw=raw??extraction();
  const selectedArchive=archive??{status:"committed",relativePath:`亚信工作/日常发票/餐饮发票/2026年07月/290.00.${extension}`};
  const calls={download:0,inspect:0,prepare:0,decide:0,write:0,cleanup:0,downloadInput:null,decideInput:null,writeInput:null};
  const capability=createInvoiceCapability({
    download:async input => {
      calls.download++;
      calls.downloadInput=structuredClone(input);
      if (failAt==="download") throw new Error("secret download");
      return {tempDir:"/tmp/job-safe",file:`/tmp/job-safe/invoice.${extension}`};
    },
    inspect:async () => {
      calls.inspect++;
      if (failAt==="inspect") throw new Error("secret inspect");
      return {kind,format,extension,sizeBytes:10};
    },
    preparePdf:async ({file}) => {
      calls.prepare++;
      if (failAt==="prepare") throw Object.assign(new Error(`secret:${prepareCode}`),{code:prepareCode});
      return {originalFile:file,detectedFormat:"pdf",archiveExtension:"pdf",pageImages:[`${file}.page-1.png`],extractedText:"text",documentFacts:{pageCount:1,textAvailable:true}};
    },
    decide:async input => {
      calls.decide++;
      calls.decideInput=structuredClone(input);
      if (failAt==="decide") throw new Error("secret ai");
      return structuredClone(selectedRaw);
    },
    validate:validateInvoiceExtraction,
    derive:deriveInvoiceRuleDecision,
    writer:{archive:async input => {
      calls.write++;
      calls.writeInput=structuredClone(input);
      if (failAt==="write") throw new Error("secret writer");
      return structuredClone(selectedArchive);
    }},
    cleanup:async () => { calls.cleanup++; }
  });
  return {capability,calls};
}

test("committed and existing image archives get independent exact outcomes",async () => {
  const h=harness();
  assert.equal(h.capability.name,"invoice");
  assert.equal(Object.hasOwn(h.capability,"match"),false);
  const first=await h.capability.handle(event);
  assert.equal(first.status,"committed");
  assert.match(first.reply,/发票已归档\n/);
  assert.match(first.reply,/290.00 元/);
  assert.equal(first.artifacts.length,1);
  assert.equal(h.calls.cleanup,1);
  assert.equal(h.calls.prepare,0);
  assert.equal(h.calls.decideInput.analysisInput.pageImages.length,1);
  assert.equal(h.calls.downloadInput.messageId,"m1");
  assert.equal(h.calls.downloadInput.source,"feishu");
  const secondHarness=harness({archive:{status:"existing",relativePath:"亚信工作/日常发票/餐饮发票/2026年07月/290.00.png"}});
  const second=await secondHarness.capability.handle({...event,sourceMessageId:"m2",attachments:[{type:"image",sourceAttachmentId:"img_def",displayName:"飞书图片",extension:""}]});
  assert.equal(second.status,"existing");
  assert.match(second.reply,/文件已存在，未重复复制/);
  assert.equal(secondHarness.calls.cleanup,1);
});

test("passes a normalized Chinese invoice date to the existing writer",async () => {
  const h=harness({raw:extraction({invoice:{issue_date:"2026年07月21日"}})});
  const result=await h.capability.handle(event);
  assert.equal(result.status,"committed");
  assert.equal(h.calls.write,1);
  assert.equal(h.calls.writeInput.invoice.issue_date,"2026-07-21");
  assert.match(result.reply,/开票日期：2026-07-21/);
});

test("reuses a dispatcher-prepared image without downloading, inspecting or cleaning it again",async () => {
  const h=harness();
  const preparedImage={
    tempDir:"/tmp/job-shared",
    file:"/tmp/job-shared/shared.webp",
    detectedFormat:"webp",
    archiveExtension:"webp",
    sizeBytes:789
  };
  const result=await h.capability.handle(event,{model:"codex",preparedImage});
  assert.equal(result.status,"committed");
  assert.equal(h.calls.download,0);
  assert.equal(h.calls.inspect,0);
  assert.equal(h.calls.cleanup,0);
  assert.equal(h.calls.decide,1);
  assert.deepEqual(h.calls.decideInput.analysisInput,{
    originalFile:preparedImage.file,
    detectedFormat:"webp",
    archiveExtension:"webp",
    pageImages:[preparedImage.file],
    extractedText:"",
    documentFacts:{pageCount:1,textAvailable:false}
  });
  assert.equal(h.calls.writeInput.source,preparedImage.file);
  assert.equal(h.calls.writeInput.extension,"webp");
});

test("passes only the WeChat source and opaque resource id into the existing invoice flow",async () => {
  const h=harness();
  const result=await h.capability.handle({
    ...event,
    source:"wechat",
    sourceMessageId:"1001",
    attachments:[{
      type:"image",sourceAttachmentId:"wxr_0123456789abcdef0123456789abcdef",
      displayName:"微信图片",extension:""
    }],
    replyTarget:{
      source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"
    }
  });
  assert.equal(result.status,"committed");
  assert.deepEqual(h.calls.downloadInput,{
    source:"wechat",
    resourceId:"wxr_0123456789abcdef0123456789abcdef",
    type:"image",
    messageId:"1001"
  });
  assert.equal(h.calls.inspect,1);
  assert.equal(h.calls.decide,1);
  assert.equal(h.calls.write,1);
});

test("PDF prepares every page input and archives only the original PDF",async () => {
  const h=harness({kind:"pdf"});
  const result=await h.capability.handle(fileEvent);
  assert.equal(result.status,"committed");
  assert.equal(h.calls.prepare,1);
  assert.equal(h.calls.decide,1);
  assert.equal(h.calls.write,1);
  assert.equal(h.calls.cleanup,1);
  assert.equal(h.calls.decideInput.analysisInput.detectedFormat,"pdf");
  assert.equal(h.calls.writeInput.source,"/tmp/job-safe/invoice.pdf");
  assert.equal(h.calls.writeInput.extension,"pdf");
});

for (const [label,raw,pattern] of [
  ["name",extraction({invoice:{buyer_name:"其他测试公司"}}),/购买方名称与指定归档主体不匹配/],
  ["tax",extraction({invoice:{buyer_tax_id:"OTHER"}}),/统一社会信用代码\/纳税人识别号与指定归档主体不匹配/],
  ["both",extraction({invoice:{buyer_name:"其他测试公司",buyer_tax_id:"OTHER"}}),/名称和统一社会信用代码\/纳税人识别号均与指定归档主体不匹配/]
]) test(`${label} buyer mismatch gets an exact business rejection and never writes`,async () => {
  const h=harness({raw});
  const result=await h.capability.handle(event);
  assert.equal(result.status,"rejected");
  assert.match(result.reply,pattern);
  assert.equal(result.reply.includes("AI 暂时不可用"),false);
  assert.equal(h.calls.write,0);
  assert.equal(h.calls.cleanup,1);
});

test("missing, unclear, non-dining and invalid archive values never call writer",async () => {
  const cases=[
    [extraction({invoice:{buyer_name:""},field_quality:{buyer_name:"missing"}}),"awaiting_clarification",/必填字段缺失/],
    [extraction({invoice:{buyer_name:""},field_quality:{buyer_name:"unclear"}}),"awaiting_clarification",/必填字段无法清晰读取/],
    [extraction({category:"non_dining"}),"rejected",/不属于当前已启用的餐饮发票类别/],
    [extraction({invoice:{invoice_number:"TEST-20260724-001"}}),"awaiting_clarification",/发票号码格式/]
  ];
  for (const [raw,status,pattern] of cases) {
    const h=harness({raw});
    const result=await h.capability.handle(event);
    assert.equal(result.status,status);
    assert.match(result.reply,pattern);
    assert.equal(h.calls.write,0);
    assert.equal(h.calls.cleanup,1);
  }
});

test("unknown extraction fields remain a technical failure instead of a business rejection",async () => {
  const h=harness({raw:extraction({extra:{action:"archive_dining"}})});
  const result=await h.capability.handle(event);
  assert.equal(result.status,"failed");
  assert.match(result.reply,/AI 暂时不可用或识别结果无效/);
  assert.equal(result.reply.includes("购买方"),false);
  assert.equal(h.calls.write,0);
});

for (const [state,pattern] of [
  ["multiple_invoices",/拆分为一张发票一个 PDF/],
  ["conflicting_fields",/不同页面关键字段冲突/],
  ["unclear",/无法确认整份文件只含一张完整发票/]
]) test(`PDF document state ${state} gets a fixed clarification and never writes`,async () => {
  const h=harness({kind:"pdf",raw:extraction({document_verification:state})});
  const result=await h.capability.handle(fileEvent);
  assert.equal(result.status,"awaiting_clarification");
  assert.match(result.reply,pattern);
  assert.equal(h.calls.write,0);
  assert.equal(h.calls.cleanup,1);
});

for (const [code,pattern] of [
  ["pdf_encrypted",/加密保护/],["pdf_page_limit",/10 页上限/],["pdf_structure_invalid",/结构无法安全解析/],
  ["pdf_text_invalid",/页面无法完整呈现/],["pdf_render_invalid",/页面无法完整呈现/],["pdf_prepare_timeout",/页面处理超时/]
]) test(`PDF preparation error ${code} is safe and never reaches AI`,async () => {
  const h=harness({kind:"pdf",failAt:"prepare",prepareCode:code});
  const result=await h.capability.handle(fileEvent);
  assert.equal(result.status,code==="pdf_encrypted"||code==="pdf_page_limit"?"rejected":"failed");
  assert.match(result.reply,pattern);
  assert.equal(result.reply.includes("secret"),false);
  assert.equal(h.calls.decide,0);
  assert.equal(h.calls.write,0);
  assert.equal(h.calls.cleanup,1);
});

for (const kind of ["ofd","unsupported"]) test(`${kind} gets a fixed non-AI result`,async () => {
  const h=harness({kind});
  const result=await h.capability.handle(fileEvent);
  assert.equal(result.status,"rejected");
  assert.equal(h.calls.prepare,0);
  assert.equal(h.calls.decide,0);
  assert.equal(h.calls.write,0);
  assert.equal(h.calls.cleanup,1);
  assert.match(result.reply,kind==="ofd"?/OFD/:/不支持此附件格式/);
});

for (const stage of ["download","inspect","decide","write"]) test(`${stage} failure returns only safe text and cleans downloaded files`,async () => {
  const h=harness({failAt:stage});
  const result=await h.capability.handle(event);
  assert.equal(result.status,"failed");
  assert.match(result.reply,/发票处理失败，文件未归档/);
  assert.equal(result.reply.includes("secret"),false);
  assert.equal(h.calls.cleanup,stage==="download"?0:1);
});

test("malformed resource marker is rejected before download",async () => {
  const h=harness();
  const result=await h.capability.handle({...event,attachments:[{type:"image",sourceAttachmentId:"bad",displayName:"飞书图片",extension:""}]});
  assert.equal(result.status,"failed");
  assert.match(result.reply,/附件标识无法安全解析/);
  assert.equal(h.calls.download,0);
});
