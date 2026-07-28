import test from "node:test";
import assert from "node:assert/strict";
import {
  executeArchiveDiningInvoice
} from "../src/personal-assistant/tools/archive-dining-invoice.mjs";

const invoice={
  invoice_number:"123",issue_date:"2026-07-28",
  buyer_name:"亚信科技（成都）有限公司",
  buyer_tax_id:"91510100732356360H",
  seller_name:"合成餐厅",item_name:"餐饮服务",
  total_with_tax:"100.00"
};
const extraction={
  invoice,
  field_quality:Object.fromEntries(
    Object.keys(invoice).map(key=>[key,"clear"])
  ),
  category:"dining",
  document_verification:"single_invoice"
};

function item(sourceId,overrides={}) {
  return {sourceId,extraction:{...extraction,...overrides}};
}

function binding(sourceId,format="pdf") {
  return {
    handle:{
      sourceId,displayName:`发票.${format}`,mediaClass:"document",
      format,relativePath:`${sourceId}.${format}`,byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    },
    absolutePath:`/private/llw-turn-test/${sourceId}.${format}`,
    archiveExtension:format
  };
}

test("prevalidates every invoice before sequentially archiving originals",async()=>{
  const calls=[];
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{
      items:[item("source-001"),item("source-002")]
    }},
    sourceBindings:[binding("source-001"),binding("source-002")],
    taskKey:"feishu:m1",
    writer:{async archive(input){
      calls.push(input);
      return {
        status:"committed",
        relativePath:`亚信工作/日常发票/餐饮发票/${calls.length}.pdf`
      };
    }}
  });
  assert.equal(calls.length,2);
  assert.notEqual(calls[0].transactionId,calls[1].transactionId);
  assert.equal(calls[0].source,
    "/private/llw-turn-test/source-001.pdf");
  assert.equal(result.status,"committed");
  assert.deepEqual(
    result.items.map(value=>value.sourceId),
    ["source-001","source-002"]
  );
});

test("one invalid invoice causes zero writes for the whole batch",async()=>{
  let calls=0;
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{
      items:[
        item("source-001"),
        item("source-002",{category:"non_dining"})
      ]
    }},
    sourceBindings:[binding("source-001"),binding("source-002")],
    taskKey:"wechat:m2",
    writer:{async archive(){calls+=1;}}
  });
  assert.equal(calls,0);
  assert.equal(result.status,"rejected");
});

test("a second Writer failure returns partial and never executes the third",async()=>{
  let calls=0;
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{
      items:[
        item("source-001"),item("source-002"),item("source-003")
      ]
    }},
    sourceBindings:[
      binding("source-001"),binding("source-002"),binding("source-003")
    ],
    taskKey:"feishu:m3",
    writer:{async archive(){
      calls+=1;
      if (calls===2) throw new Error("disk_failed");
      return {
        status:"committed",
        relativePath:"亚信工作/日常发票/餐饮发票/first.pdf"
      };
    }}
  });
  assert.equal(calls,2);
  assert.equal(result.status,"partial");
  assert.deepEqual(
    result.items.map(value=>value.status),
    ["committed","failed"]
  );
  assert.deepEqual(result.artifacts,[
    "亚信工作/日常发票/餐饮发票/first.pdf"
  ]);
});

test("current no-archive instruction prevents the whole batch before Writer",async()=>{
  let calls=0;
  const result=await executeArchiveDiningInvoice({
    toolCall:{name:"archive_dining_invoice",arguments:{
      items:[item("source-001"),item("source-002")]
    }},
    sourceBindings:[binding("source-001"),binding("source-002")],
    taskKey:"feishu:m4",currentInstruction:"只看金额，不归档",
    writer:{async archive(){calls+=1;}}
  });
  assert.equal(calls,0);
  assert.equal(result.status,"rejected");
});
