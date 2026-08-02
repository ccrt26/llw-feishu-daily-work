import {createHash} from "node:crypto";
import {lstat,unlink,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {
  assertSafeOoxmlXml,isSafeExternalOoxmlHyperlink,
  openBoundedOoxmlPackage,
  parseOoxmlRelationships,resolveOoxmlTarget
} from "./bounded-ooxml-package.mjs";

const WORD_NAMESPACES=new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main"
]);
const OFFICE_RELATIONSHIP_NAMESPACES=new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships"
]);
const CONTENT_TYPES_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/content-types";
const IMAGE_RELATIONSHIP_TYPES=new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/image"
]);
const SUPPORTED_INTERNAL_RELATIONSHIP_SUFFIXES=new Set([
  "header","footer","footnotes","endnotes","styles","numbering",
  "settings","fontTable","theme","webSettings"
]);
const KNOWN_METADATA_PARTS=[
  /^_rels\/\.rels$/u,
  /^docProps\/(?:core|app|custom)\.xml$/u,
  /^word\/(?:settings|fontTable|webSettings)\.xml$/u,
  /^word\/theme\/theme\d*\.xml$/u
];
const PNG_MAGIC=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const MAX_TEXT_BYTES=512*1024;
const MAX_IMAGES=16;
const KNOWN_WORD_CONTENT_ELEMENTS=new Set([
  "document","body","sectPr","headerReference","footerReference",
  "type","pgSz","pgMar","cols","docGrid","titlePg","p","pPr",
  "pStyle","r","rPr","t","tab","br","cr","numPr","ilvl","numId",
  "tbl","tblPr","tblGrid","gridCol","tr","trPr","tc","tcPr",
  "tblW","tcW","tblBorders","top","left","bottom","right","insideH",
  "insideV","tblLook","tblStyle","tblLayout","vMerge","gridSpan",
  "hdr","ftr","footnotes","footnote","endnotes","endnote","drawing",
  "hyperlink","bookmarkStart","bookmarkEnd","proofErr","noProof",
  "lastRenderedPageBreak","b","bCs","i","iCs","u","color","highlight",
  "sz","szCs","rFonts","lang","spacing","ind","jc","keepNext",
  "keepLines","widowControl","contextualSpacing","snapToGrid","rtl",
  "vertAlign","position","kern","vanish","strike","dstrike","caps",
  "smallCaps","outline","shadow","emboss","imprint","effect","sdt",
  "sdtPr","sdtContent","alias","tag","id","lock","showingPlcHdr"
]);
const DRAWING_NAMESPACES=new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
  "http://schemas.openxmlformats.org/drawingml/2006/picture",
  "http://purl.oclc.org/ooxml/drawingml/picture",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing"
]);

export async function prepareDocxEvidenceJob(job) {
  const created=[];
  try {
    const validated=await validateJob(job);
    const archive=await openBoundedOoxmlPackage(validated.inputPath,{
      expectedSha256:validated.expectedSha256,
      ...(validated.limits.maxEntries===undefined
        ?{}:{maxEntries:validated.limits.maxEntries}),
      ...(validated.limits.maxEntryBytes===undefined
        ?{}:{maxEntryBytes:validated.limits.maxEntryBytes}),
      ...(validated.limits.maxTotalBytes===undefined
        ?{}:{maxTotalBytes:validated.limits.maxTotalBytes})
    });
    requireDocxEnvelope(archive);
    const contentTypes=parseContentTypes(
      archive.readEntry("[Content_Types].xml")
    );
    if (contentTypeForPart(contentTypes,"word/document.xml")!==
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") {
      throw invalid();
    }
    for (const partName of contentTypes.overrides.keys()) {
      if (!archive.hasEntry(partName)) throw invalid();
    }
    const ownerParts=orderedOwnerParts(archive.entryNames);
    const parsedParts=new Set();
    const relationshipParts=new Set();
    const limitations=new Set();
    const relationshipMaps=new Map();
    const referencedParts=new Set();
    const imageReferences=[];
    const observations=[];
    const observationBudget={bytes:2};
    const styles=parseStylesIfPresent(archive,parsedParts,limitations);
    parseNumberingIfPresent(archive,parsedParts);

    for (const [ownerIndex,ownerPartName] of ownerParts.entries()) {
      parsedParts.add(ownerPartName);
      const relations=readOwnerRelationships({
        archive,ownerPartName,relationshipParts,limitations,referencedParts
      });
      relationshipMaps.set(ownerPartName,relations);
      const partResult=parseWordContentPart(
        archive.readEntry(ownerPartName),ownerPartName,styles,
        ownerIndex*1_000_000
      );
      for (const limitation of partResult.limitations) {
        limitations.add(limitation);
      }
      for (const observation of partResult.observations) {
        addObservationWithinBudget(
          observations,observation,validated.limits.maxTextBytes,
          observationBudget,limitations
        );
      }
      imageReferences.push(...partResult.imageReferences);
    }
    auditRemainingRelationships({
      archive,relationshipParts,referencedParts,limitations
    });

    const imageCandidates=[];
    const representedMedia=new Set();
    for (const reference of imageReferences) {
      const relations=relationshipMaps.get(reference.ownerPartName);
      const relation=relations?.get(reference.relationshipId);
      if (!relation||!IMAGE_RELATIONSHIP_TYPES.has(relation.Type)||
          relation.TargetMode==="External") throw invalid();
      const targetMediaPartName=relation.resolvedTarget;
      if (!targetMediaPartName?.startsWith("word/media/")||
          !archive.hasEntry(targetMediaPartName)) throw invalid();
      representedMedia.add(targetMediaPartName);
      const bytes=archive.readEntry(targetMediaPartName);
      const declared=contentTypeForPart(contentTypes,targetMediaPartName);
      const png=bytes.subarray(0,8).equals(PNG_MAGIC)&&
        declared==="image/png"&&targetMediaPartName.toLowerCase().endsWith(".png");
      if (!png) {
        limitations.add("unsupported_image_format");
        continue;
      }
      if (imageCandidates.length>=validated.limits.maxImages) {
        limitations.add("image_budget_exceeded");
        continue;
      }
      const jobRelativePath=`image-${String(imageCandidates.length+1).padStart(3,"0")}.png`;
      const outputPath=`${validated.outputDir}/${jobRelativePath}`;
      await writeFile(outputPath,bytes,{flag:"wx",mode:0o600});
      created.push(outputPath);
      imageCandidates.push(Object.freeze({
        documentOrder:reference.documentOrder,
        ownerPartName:reference.ownerPartName,
        relationshipId:reference.relationshipId,
        targetMediaPartName,
        jobRelativePath,
        sha256:createHash("sha256").update(bytes).digest("hex")
      }));
    }

    classifyPackage({
      archive,parsedParts,relationshipParts,referencedParts,
      representedMedia,limitations
    });
    return Object.freeze({
      originalSha256:archive.sha256,
      observations:Object.freeze(observations),
      imageCandidates:Object.freeze(imageCandidates),
      coverage:Object.freeze({
        status:limitations.size===0?"complete":"partial",
        limitations:Object.freeze([...limitations].sort()),
        parts:Object.freeze({
          parsed:Object.freeze([...parsedParts].sort()),
          relationships:Object.freeze([...relationshipParts].sort()),
          representedMedia:Object.freeze([...representedMedia].sort())
        })
      })
    });
  } catch (error) {
    await Promise.all(created.map(file=>unlink(file).catch(()=>{})));
    if (error?.message==="docx_evidence_invalid") throw error;
    throw invalid();
  }
}

async function validateJob(job) {
  if (!job||typeof job!=="object"||Array.isArray(job)||
      typeof job.inputPath!=="string"||!job.inputPath||
      typeof job.outputDir!=="string"||!job.outputDir||
      !/^[0-9a-f]{64}$/u.test(job.expectedSha256||"")||
      !job.limits||typeof job.limits!=="object") throw invalid();
  const maxTextBytes=job.limits.maxTextBytes;
  const maxImages=job.limits.maxImages;
  if (!Number.isSafeInteger(maxTextBytes)||maxTextBytes<1||
      maxTextBytes>MAX_TEXT_BYTES||!Number.isSafeInteger(maxImages)||
      maxImages<0||maxImages>MAX_IMAGES) throw invalid();
  for (const [name,hardMax] of [
    ["maxEntries",2048],["maxEntryBytes",16*1024*1024],
    ["maxTotalBytes",64*1024*1024]
  ]) {
    const value=job.limits[name];
    if (value!==undefined&&
        (!Number.isSafeInteger(value)||value<1||value>hardMax)) throw invalid();
  }
  const outputInfo=await lstat(job.outputDir);
  if (!outputInfo.isDirectory()||outputInfo.isSymbolicLink()) throw invalid();
  return {
    inputPath:job.inputPath,outputDir:job.outputDir,
    expectedSha256:job.expectedSha256,
    limits:{...job.limits,maxTextBytes,maxImages}
  };
}

function requireDocxEnvelope(archive) {
  if (!archive.hasEntry("[Content_Types].xml")||
      !archive.hasEntry("word/document.xml")) throw invalid();
}

function parseContentTypes(bytes) {
  const defaults=new Map();
  const overrides=new Map();
  let rootSeen=false;
  parseXml(bytes,{
    start(node) {
      if (!rootSeen) {
        rootSeen=true;
        if (node.namespaceURI!==CONTENT_TYPES_NAMESPACE||
            node.localName!=="Types") throw invalid();
        return;
      }
      if (node.namespaceURI!==CONTENT_TYPES_NAMESPACE) throw invalid();
      if (node.localName==="Default") {
        const extension=plainAttribute(node,"Extension")?.toLowerCase();
        const contentType=plainAttribute(node,"ContentType")?.toLowerCase();
        if (!extension||!contentType||defaults.has(extension)) throw invalid();
        defaults.set(extension,contentType);
      } else if (node.localName==="Override") {
        const part=plainAttribute(node,"PartName");
        const contentType=plainAttribute(node,"ContentType")?.toLowerCase();
        if (!part?.startsWith("/")||!contentType||overrides.has(part.slice(1))) {
          throw invalid();
        }
        overrides.set(part.slice(1),contentType);
      } else if (node.localName!=="Types") throw invalid();
    }
  });
  if (!rootSeen||[...defaults.values(),...overrides.values()].some(
    value=>value.includes("macroenabled")
  )) throw invalid();
  return {defaults,overrides};
}

function contentTypeForPart(contentTypes,partName) {
  const override=contentTypes.overrides.get(partName);
  if (override) return override;
  const dot=partName.lastIndexOf(".");
  return dot<0?undefined:contentTypes.defaults.get(
    partName.slice(dot+1).toLowerCase()
  );
}

function orderedOwnerParts(entryNames) {
  const files=entryNames.filter(name=>!name.endsWith("/"));
  const headers=files.filter(name=>/^word\/header\d+\.xml$/u.test(name)).sort();
  const footers=files.filter(name=>/^word\/footer\d+\.xml$/u.test(name)).sort();
  return [
    "word/document.xml",...headers,...footers,
    ...files.includes("word/footnotes.xml")?["word/footnotes.xml"]:[],
    ...files.includes("word/endnotes.xml")?["word/endnotes.xml"]:[]
  ];
}

function parseStylesIfPresent(archive,parsedParts,limitations) {
  const styles=new Map();
  if (!archive.hasEntry("word/styles.xml")) return styles;
  parsedParts.add("word/styles.xml");
  let current=null;
  parseXml(archive.readEntry("word/styles.xml"),{
    start(node) {
      if (!wordNode(node)) return;
      if (node.localName==="style") {
        const type=wordAttribute(node,"type");
        const id=wordAttribute(node,"styleId");
        current=type==="paragraph"&&id?{id,name:"",outlineLevel:null}:null;
      } else if (current&&node.localName==="name") {
        current.name=wordAttribute(node,"val")||"";
      } else if (current&&node.localName==="outlineLvl") {
        const value=Number.parseInt(wordAttribute(node,"val"),10);
        if (Number.isInteger(value)&&value>=0&&value<=8) {
          current.outlineLevel=value;
        }
      }
    },
    end(node) {
      if (wordNode(node)&&node.localName==="style"&&current) {
        styles.set(current.id,Object.freeze(current));
        current=null;
      }
    }
  });
  return styles;
}

function parseNumberingIfPresent(archive,parsedParts) {
  if (!archive.hasEntry("word/numbering.xml")) return;
  parsedParts.add("word/numbering.xml");
  parseXml(archive.readEntry("word/numbering.xml"),{});
}

function readOwnerRelationships({
  archive,ownerPartName,relationshipParts,limitations,referencedParts
}) {
  const partName=relationshipPartName(ownerPartName);
  const map=new Map();
  if (!archive.hasEntry(partName)) return map;
  relationshipParts.add(partName);
  for (const relation of parseOoxmlRelationships(archive.readEntry(partName))) {
    if (relation.TargetMode==="External") {
      if (!isSafeExternalOoxmlHyperlink(relation)) throw invalid();
      map.set(relation.Id,Object.freeze({...relation,resolvedTarget:null}));
      continue;
    }
    if (relation.TargetMode!==undefined&&relation.TargetMode!=="Internal") {
      throw invalid();
    }
    const resolvedTarget=resolveOoxmlTarget(ownerPartName,relation.Target);
    if (!archive.hasEntry(resolvedTarget)) throw invalid();
    referencedParts.add(resolvedTarget);
    const suffix=relationshipTypeSuffix(relation.Type);
    if (!IMAGE_RELATIONSHIP_TYPES.has(relation.Type)&&
        !SUPPORTED_INTERNAL_RELATIONSHIP_SUFFIXES.has(suffix)) {
      limitations.add(relationshipLimitation(suffix));
    }
    map.set(relation.Id,Object.freeze({...relation,resolvedTarget}));
  }
  return map;
}

function auditRemainingRelationships({
  archive,relationshipParts,referencedParts,limitations
}) {
  for (const partName of archive.entryNames) {
    if (!partName.endsWith(".rels")||relationshipParts.has(partName)) continue;
    relationshipParts.add(partName);
    const ownerPartName=ownerForRelationshipPart(partName);
    for (const relation of parseOoxmlRelationships(archive.readEntry(partName))) {
      if (relation.TargetMode==="External") {
        if (!isSafeExternalOoxmlHyperlink(relation)) throw invalid();
        continue;
      }
      if (relation.TargetMode!==undefined&&relation.TargetMode!=="Internal") {
        throw invalid();
      }
      const resolvedTarget=resolveOoxmlTarget(ownerPartName,relation.Target);
      if (!archive.hasEntry(resolvedTarget)) throw invalid();
      referencedParts.add(resolvedTarget);
      const suffix=relationshipTypeSuffix(relation.Type);
      if (partName==="_rels/.rels"&&suffix==="officeDocument") continue;
      if (!IMAGE_RELATIONSHIP_TYPES.has(relation.Type)&&
          !SUPPORTED_INTERNAL_RELATIONSHIP_SUFFIXES.has(suffix)) {
        limitations.add(relationshipLimitation(suffix));
      }
    }
  }
}

function parseWordContentPart(bytes,ownerPartName,styles,orderBase) {
  const observations=[];
  const imageReferences=[];
  const limitations=new Set();
  const paragraphs=[];
  let tableCellDepth=0;
  let textCaptureDepth=0;
  let drawingDepth=0;
  let drawingHasBlip=false;
  let order=orderBase;
  let rootSeen=false;
  parseXml(bytes,{
    start(node) {
      if (!rootSeen) {
        rootSeen=true;
        if (!wordNode(node)||node.localName!==expectedOwnerRoot(ownerPartName)) {
          throw invalid();
        }
      }
      detectUnsupported(node,limitations);
      if (wordNode(node)&&node.localName==="tc") tableCellDepth+=1;
      if (wordNode(node)&&node.localName==="p") {
        paragraphs.push({
          text:"",styleId:null,numId:null,level:0,
          tableCell:tableCellDepth>0
        });
      }
      const paragraph=paragraphs.at(-1);
      if (paragraph&&wordNode(node)&&node.localName==="pStyle") {
        paragraph.styleId=wordAttribute(node,"val")||null;
      } else if (paragraph&&wordNode(node)&&node.localName==="numId") {
        paragraph.numId=wordAttribute(node,"val")||null;
      } else if (paragraph&&wordNode(node)&&node.localName==="ilvl") {
        const level=Number.parseInt(wordAttribute(node,"val"),10);
        if (Number.isInteger(level)&&level>=0&&level<=8) paragraph.level=level;
      } else if (paragraph&&wordNode(node)&&node.localName==="t") {
        textCaptureDepth+=1;
      } else if (paragraph&&wordNode(node)&&node.localName==="tab") {
        paragraph.text+="\t";
      } else if (paragraph&&wordNode(node)&&
          new Set(["br","cr"]).has(node.localName)) {
        paragraph.text+="\n";
      }
      if (wordNode(node)&&node.localName==="drawing") {
        drawingDepth+=1;
        drawingHasBlip=false;
      }
      if (node.localName==="blip"&&drawingDepth>0) {
        const relationshipId=relationshipAttribute(node,"embed");
        if (!relationshipId) throw invalid();
        drawingHasBlip=true;
        imageReferences.push(Object.freeze({
          ownerPartName,relationshipId,documentOrder:order+=1
        }));
      }
    },
    text(value) {
      if (textCaptureDepth>0&&paragraphs.length>0) {
        paragraphs.at(-1).text+=value;
      }
    },
    end(node) {
      if (wordNode(node)&&node.localName==="t"&&textCaptureDepth>0) {
        textCaptureDepth-=1;
      }
      if (wordNode(node)&&node.localName==="p") {
        const paragraph=paragraphs.pop();
        const text=normalizeText(paragraph.text);
        if (text) {
          const style=paragraph.styleId?styles.get(paragraph.styleId):null;
          const headingLevel=headingLevelFor(paragraph.styleId,style);
          observations.push(Object.freeze({
            ownerPartName,documentOrder:order+=1,
            type:paragraph.tableCell?"table_cell"
              :headingLevel!==null?"heading"
                :paragraph.numId!==null?"list_item":"paragraph",
            text,
            ...(headingLevel===null?{}:{level:headingLevel}),
            ...(paragraph.numId===null?{}:{level:paragraph.level})
          }));
        }
      }
      if (wordNode(node)&&node.localName==="tc") tableCellDepth-=1;
      if (wordNode(node)&&node.localName==="drawing") {
        if (!drawingHasBlip) limitations.add("unsupported_drawing");
        drawingDepth-=1;
      }
    }
  });
  return {observations,imageReferences,limitations};
}

function addObservationWithinBudget(
  observations,observation,maxTextBytes,budget,limitations
) {
  const added=Buffer.byteLength(JSON.stringify(observation),"utf8")+
    (observations.length>0?1:0);
  if (budget.bytes+added>maxTextBytes) {
    limitations.add("text_budget_exceeded");
    return;
  }
  observations.push(observation);
  budget.bytes+=added;
}

function classifyPackage({
  archive,parsedParts,relationshipParts,referencedParts,
  representedMedia,limitations
}) {
  for (const name of archive.entryNames) {
    if (name.endsWith("/")||name==="[Content_Types].xml"||
        parsedParts.has(name)||relationshipParts.has(name)||
        KNOWN_METADATA_PARTS.some(pattern=>pattern.test(name))) continue;
    if (name.startsWith("word/media/")) {
      if (!representedMedia.has(name)) limitations.add("unrepresented_media");
      continue;
    }
    if (/^word\/comments(?:Extended|Ids)?\.xml$/iu.test(name)) {
      limitations.add("comments");
      continue;
    }
    if (referencedParts.has(name)&&
        new Set(["word/styles.xml","word/numbering.xml"]).has(name)) continue;
    limitations.add("unknown_visible_part");
  }
}

function detectUnsupported(node,limitations) {
  if (wordNode(node)) {
    if (new Set(["ins","del","moveFrom","moveTo"]).has(node.localName)) {
      limitations.add("tracked_changes");
    } else if (new Set([
      "commentRangeStart","commentRangeEnd","commentReference"
    ]).has(node.localName)) {
      limitations.add("comments");
    } else if (node.localName==="txbxContent") {
      limitations.add("text_box");
    } else if (node.localName==="altChunk") {
      limitations.add("alt_chunk");
    } else if (node.localName==="dataBinding"||node.localName==="customXml") {
      limitations.add("custom_xml_binding");
    }
  }
  const namespace=node.namespaceURI||"";
  if (namespace.includes("drawingml/2006/chart")||
      namespace.includes("drawingml/chart")) limitations.add("chart");
  if (namespace.includes("drawingml/2006/diagram")||
      namespace.includes("drawingml/diagram")) limitations.add("smart_art");
  if (namespace.includes("officeDocument/2006/math")||
      namespace.includes("ooxml/officeDocument/math")) {
    limitations.add("equation");
  }
  if (namespace.includes("wordprocessingShape")||
      namespace.includes("wordprocessingDrawing")&&
        new Set(["anchor","positionH","positionV"]).has(node.localName)) {
    limitations.add("complex_floating_layout");
  }
  const knownUnsupported=namespace.includes("drawingml/2006/chart")||
    namespace.includes("drawingml/chart")||
    namespace.includes("drawingml/2006/diagram")||
    namespace.includes("drawingml/diagram")||
    namespace.includes("officeDocument/2006/math")||
    namespace.includes("ooxml/officeDocument/math")||
    namespace.includes("wordprocessingShape");
  if (!wordNode(node)&&!DRAWING_NAMESPACES.has(namespace)&&
      !knownUnsupported) limitations.add("unknown_visible_xml");
  if (wordNode(node)&&!KNOWN_WORD_CONTENT_ELEMENTS.has(node.localName)&&
      !new Set([
        "ins","del","moveFrom","moveTo","commentRangeStart",
        "commentRangeEnd","commentReference","txbxContent","altChunk",
        "dataBinding","customXml"
      ]).has(node.localName)) limitations.add("unknown_visible_xml");
}

function parseXml(bytes,visitor) {
  const xml=assertSafeOoxmlXml(bytes);
  let cursor=xml.codePointAt(0)===0xfeff?1:0;
  if (xml.startsWith("<?xml",cursor)) {
    const end=xml.indexOf("?>",cursor+5);
    if (end<0) throw invalid();
    const declaration=xml.slice(cursor,end+2);
    if (!/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?(?:\s+standalone=(?:"yes"|'yes'|"no"|'no'))?\s*\?>$/u.test(declaration)) {
      throw invalid();
    }
    cursor=end+2;
  }
  const stack=[];
  let rootSeen=false,rootClosed=false;
  while (cursor<xml.length) {
    if (xml.startsWith("<!--",cursor)) {
      const end=xml.indexOf("-->",cursor+4);
      if (end<0||xml.slice(cursor+4,end).includes("--")) throw invalid();
      cursor=end+3;
      continue;
    }
    if (xml.startsWith("<![CDATA[",cursor)) {
      if (stack.length===0) throw invalid();
      const end=xml.indexOf("]]>",cursor+9);
      if (end<0) throw invalid();
      visitor.text?.(xml.slice(cursor+9,end));
      cursor=end+3;
      continue;
    }
    if (xml[cursor]!=="<") {
      const next=xml.indexOf("<",cursor);
      const end=next<0?xml.length:next;
      const value=decodeXmlValue(xml.slice(cursor,end));
      if (stack.length===0&&value.trim()) throw invalid();
      if (stack.length>0&&value) visitor.text?.(value);
      cursor=end;
      continue;
    }
    if (xml.startsWith("<?",cursor)||xml.startsWith("<!",cursor)) {
      throw invalid();
    }
    if (xml.startsWith("</",cursor)) {
      const closing=parseClosingTag(xml,cursor);
      const frame=stack.pop();
      if (!frame||frame.qname!==closing.qname) throw invalid();
      visitor.end?.(frame.node);
      cursor=closing.end;
      if (stack.length===0) rootClosed=true;
      continue;
    }
    if (rootClosed) throw invalid();
    const start=parseStartTag(xml,cursor);
    const parentNamespaces=stack.at(-1)?.namespaces||new Map();
    const namespaces=new Map(parentNamespaces);
    for (const attribute of start.attributes) {
      if (attribute.qname==="xmlns") namespaces.set("",attribute.value);
      else if (attribute.qname.startsWith("xmlns:")) {
        namespaces.set(attribute.qname.slice(6),attribute.value);
      }
    }
    const elementName=resolveXmlName(start.qname,namespaces,true);
    const attributes=[];
    const expanded=new Set();
    for (const attribute of start.attributes) {
      if (attribute.qname==="xmlns"||attribute.qname.startsWith("xmlns:")) {
        continue;
      }
      const resolved=resolveXmlName(attribute.qname,namespaces,false);
      const key=`${resolved.namespaceURI}\0${resolved.localName}`;
      if (expanded.has(key)) throw invalid();
      expanded.add(key);
      attributes.push(Object.freeze({...resolved,value:attribute.value}));
    }
    const node=Object.freeze({...elementName,attributes:Object.freeze(attributes)});
    if (stack.length===0) {
      if (rootSeen) throw invalid();
      rootSeen=true;
    }
    visitor.start?.(node);
    cursor=start.end;
    if (start.selfClosing) {
      visitor.end?.(node);
      if (stack.length===0) rootClosed=true;
    } else stack.push({qname:start.qname,node,namespaces});
  }
  if (!rootSeen||!rootClosed||stack.length!==0) throw invalid();
}

function parseStartTag(xml,start) {
  let cursor=start+1;
  const name=parseQName(xml,cursor);
  cursor=name.end;
  const attributes=[];
  const names=new Set();
  for (;;) {
    const before=cursor;
    cursor=skipWhitespace(xml,cursor);
    if (xml.startsWith("/>",cursor)) {
      return {qname:name.value,attributes,selfClosing:true,end:cursor+2};
    }
    if (xml[cursor]===">") {
      return {qname:name.value,attributes,selfClosing:false,end:cursor+1};
    }
    if (cursor===before) throw invalid();
    const attributeName=parseQName(xml,cursor);
    if (names.has(attributeName.value)) throw invalid();
    names.add(attributeName.value);
    cursor=skipWhitespace(xml,attributeName.end);
    if (xml[cursor]!=="=") throw invalid();
    cursor=skipWhitespace(xml,cursor+1);
    const quote=xml[cursor];
    if (quote!=="\""&&quote!=="'") throw invalid();
    const end=xml.indexOf(quote,cursor+1);
    if (end<0) throw invalid();
    attributes.push({
      qname:attributeName.value,
      value:decodeXmlValue(xml.slice(cursor+1,end))
    });
    cursor=end+1;
  }
}

function parseClosingTag(xml,start) {
  const name=parseQName(xml,start+2);
  const cursor=skipWhitespace(xml,name.end);
  if (xml[cursor]!==">") throw invalid();
  return {qname:name.value,end:cursor+1};
}

function parseQName(xml,start) {
  if (!/[A-Za-z_]/u.test(xml[start]||"")) throw invalid();
  let cursor=start+1;
  while (/[A-Za-z0-9_.:-]/u.test(xml[cursor]||"")) cursor+=1;
  const value=xml.slice(start,cursor);
  if (value.split(":").length>2||value.endsWith(":")) throw invalid();
  return {value,end:cursor};
}

function resolveXmlName(qname,namespaces,element) {
  const [first,second]=qname.split(":");
  const prefix=second===undefined?"":first;
  const localName=second===undefined?first:second;
  const namespaceURI=prefix
    ?namespaces.get(prefix)
    :element?(namespaces.get("")||""):"";
  if (prefix&&!namespaceURI) throw invalid();
  return {qname,prefix,localName,namespaceURI};
}

function decodeXmlValue(raw) {
  let decoded="",cursor=0;
  while (cursor<raw.length) {
    const ampersand=raw.indexOf("&",cursor);
    if (ampersand<0) {
      decoded+=raw.slice(cursor);
      break;
    }
    decoded+=raw.slice(cursor,ampersand);
    const semicolon=raw.indexOf(";",ampersand+1);
    if (semicolon<0||semicolon-ampersand>12) throw invalid();
    const entity=raw.slice(ampersand+1,semicolon);
    const named={amp:"&",lt:"<",gt:">",apos:"'",quot:'"'}[entity];
    if (named!==undefined) decoded+=named;
    else {
      const hex=/^#x[0-9A-Fa-f]+$/u.test(entity);
      const dec=/^#[0-9]+$/u.test(entity);
      if (!hex&&!dec) throw invalid();
      const point=Number.parseInt(entity.slice(hex?2:1),hex?16:10);
      if (!xmlCodePoint(point)) throw invalid();
      decoded+=String.fromCodePoint(point);
    }
    cursor=semicolon+1;
  }
  for (const value of decoded) {
    if (!xmlCodePoint(value.codePointAt(0))) throw invalid();
  }
  return decoded;
}

function skipWhitespace(xml,start) {
  let cursor=start;
  while (/\s/u.test(xml[cursor]||"")) cursor+=1;
  return cursor;
}

function xmlCodePoint(value) {
  return value===0x9||value===0xa||value===0xd||
    (value>=0x20&&value<=0xd7ff)||
    (value>=0xe000&&value<=0xfffd)||
    (value>=0x10000&&value<=0x10ffff);
}

function wordNode(node) {
  return WORD_NAMESPACES.has(node.namespaceURI);
}

function wordAttribute(node,localName) {
  return node.attributes.find(attribute=>
    attribute.localName===localName&&
    WORD_NAMESPACES.has(attribute.namespaceURI)
  )?.value;
}

function relationshipAttribute(node,localName) {
  return node.attributes.find(attribute=>
    attribute.localName===localName&&
    OFFICE_RELATIONSHIP_NAMESPACES.has(attribute.namespaceURI)
  )?.value;
}

function plainAttribute(node,localName) {
  return node.attributes.find(attribute=>
    attribute.localName===localName&&!attribute.namespaceURI
  )?.value;
}

function normalizeText(value) {
  return value.replace(/[ \t\r\n]+/gu," ").trim();
}

function headingLevelFor(styleId,style) {
  if (style?.outlineLevel!==null&&style?.outlineLevel!==undefined) {
    return style.outlineLevel+1;
  }
  const value=style?.name||styleId||"";
  const match=/^(?:heading|标题)\s*([1-9])$/iu.exec(value);
  return match?Number(match[1]):null;
}

function relationshipPartName(ownerPartName) {
  const slash=ownerPartName.lastIndexOf("/");
  return `${ownerPartName.slice(0,slash)}/_rels/`+
    `${ownerPartName.slice(slash+1)}.rels`;
}

function ownerForRelationshipPart(partName) {
  if (partName==="_rels/.rels") return "_package-root.xml";
  const match=/^(.+)\/_rels\/([^/]+)\.rels$/u.exec(partName);
  if (!match) throw invalid();
  return `${match[1]}/${match[2]}`;
}

function expectedOwnerRoot(ownerPartName) {
  if (ownerPartName==="word/document.xml") return "document";
  if (/^word\/header\d+\.xml$/u.test(ownerPartName)) return "hdr";
  if (/^word\/footer\d+\.xml$/u.test(ownerPartName)) return "ftr";
  if (ownerPartName==="word/footnotes.xml") return "footnotes";
  if (ownerPartName==="word/endnotes.xml") return "endnotes";
  throw invalid();
}

function relationshipTypeSuffix(type) {
  return typeof type==="string"?type.slice(type.lastIndexOf("/")+1):"";
}

function relationshipLimitation(suffix) {
  if (suffix==="aFChunk") return "alt_chunk";
  if (suffix.toLowerCase().includes("comment")) return "comments";
  if (suffix.toLowerCase().includes("chart")) return "chart";
  if (suffix.toLowerCase().includes("diagram")) return "smart_art";
  if (suffix.toLowerCase().includes("customxml")) return "custom_xml_binding";
  return "unknown_visible_relationship";
}

function invalid() {
  return new Error("docx_evidence_invalid");
}

async function runCli() {
  try {
    const chunks=[];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const job=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result=await prepareDocxEvidenceJob(job);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("docx_evidence_invalid\n");
    process.exitCode=1;
  }
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  await runCli();
}
