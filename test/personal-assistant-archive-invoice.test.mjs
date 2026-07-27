import test from "node:test";
import assert from "node:assert/strict";
import {executeArchiveDiningInvoice} from "../src/personal-assistant/tools/archive-dining-invoice.mjs";

const invoice={
  invoice_number:"123",issue_date:"2026-07-28",
  buyer_name:"亚信科技（成都）有限公司",buyer_tax_id:"91510100732356360H",
  seller_name:"合成餐厅",item_name:"餐饮服务",total_with_tax:"100.00"
};
const extraction={
  invoice,
  field_quality:Object.fromEntries(Object.keys(invoice).map(key=>[key,"clear"])),
  category:"dining",
  document_verification:"single_invoice"
};

test("applies existing seven-field hard rules before archiving the bound original",async()=>{
  const calls=[];
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{extraction}},
    analysisInput:{originalFile:"/private/job/source.pdf",archiveExtension:"pdf"},
    transactionId:"tx1",
    writer:{async archive(input){
      calls.push(input);
      return {status:"committed",relativePath:"亚信工作/日常发票/餐饮发票/2026年07月/20260728-100.00-01.pdf"};
    }}
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].source,"/private/job/source.pdf");
  assert.equal(result.status,"committed");
});

test("current no-archive instruction prevents the invoice tool before Writer",async()=>{
  let calls=0;
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{extraction}},
    analysisInput:{originalFile:"/private/job/source.pdf",archiveExtension:"pdf"},
    transactionId:"tx2",currentInstruction:"只告诉我金额，不要归档",
    writer:{async archive(){ calls+=1; }}
  });
  assert.equal(calls,0);
  assert.equal(result.status,"rejected");
});
