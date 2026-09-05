import { describe, it, expect } from "vitest";
import { defaultTextSettings as defaults, projectText, normalizeTextSettings, normalizeSmartText } from "./text-processing";
import { canResumeResult, finalizeResult } from "./result-state";
import type { OcrBlock, OcrPage } from "./types";

const block=(text:string,y=100,x=20,width=400):OcrBlock=>({text,score:.9,box:[x,y,x+width,y+20],polygon:[],direction:"horizontal",fontSize:20});
const page=(blocks:OcrBlock[],index=0):OcrPage=>({schemaVersion:1,pageIndex:index,width:600,height:800,source:"ocr",text:blocks.map(b=>b.text).join("\n"),rawText:blocks.map(b=>b.text).join("\n"),blocks,tables:[]});
const result=(pages:OcrPage[])=>finalizeResult({resultType:"text"},pages);

describe("language-aware text projection",()=>{
  it("normalizes multilingual punctuation, OCR spaces and blank lines conservatively",()=>{
    expect(normalizeSmartText("中文 , 测试 !\n\n\nEnglish   text 2.5\n日本語 ( テスト )")).toBe("中文，测试！\n\nEnglish text 2.5\n日本語（テスト）");
    expect(normalizeSmartText("网址 https://example.com/a,b，邮箱 a@example.com")).toBe("网址 https://example.com/a,b，邮箱 a@example.com");
  });
  it("applies cleanup only to smart and continuous projections",()=>{
    const r=result([page([block("中文 , 测试"),block("第二 行",126)])]);
    expect(projectText(r,defaults).text).toBe("中文，测试第二行");
    expect(projectText(r,{...defaults,textMode:"original"}).text).toBe("中文 , 测试\n第二 行");
  });
  it("joins CJK without spaces and English with spaces",()=>{
    expect(projectText(result([page([block("中文正文",100),block("继续正文。",126)])]),defaults).text).toBe("中文正文继续正文。");
    expect(projectText(result([page([block("English text",100),block("continues here.",126)])]),defaults).text).toBe("English text continues here.");
    expect(projectText(result([page([block("日本語の",100),block("続きです。",126)])]),defaults).text).toBe("日本語の続きです。");
  });
  it("preserves original line breaks",()=>{
    const r=result([page([block("第一行"),block("第二行",126)])]);
    expect(projectText(r,{...defaults,textMode:"original"}).text).toBe("第一行\n第二行");
  });
  it("preserves real hyphens but removes discretionary soft hyphens",()=>{
    expect(projectText(result([page([block("recog\u00ad"),block("nition",126)])]),defaults).text).toBe("recognition");
    expect(projectText(result([page([block("well-"),block("known",126)])]),defaults).text).toBe("well-known");
    const r=result([page([block("recog-"),block("nition improves recognition",126),block("keep recog-nition unchanged",152)])]);
    expect(projectText(r,defaults).text).toBe("recognition improves recognition keep recog-nition unchanged");
  });
  it("preserves indentation, short poetry, lists and dialogue",()=>{
    expect(projectText(result([page([block("正文"),block("新段落",126,60)])]),defaults).text).toContain("\n\n");
    expect(projectText(result([page([block("诗句",100,20,60),block("下一句",126,20,60)])]),defaults).text).toContain("\n");
    for(const line of ["1. List", "「对话」"]){
      expect(projectText(result([page([block("正文"),block(line,126)])]),defaults).text).toContain("\n\n");
    }
  });
  it("joins only consecutive, completed pages",()=>{
    const r=result([page([block("开始")],0),page([block("继续")],1)]);
    expect(projectText(r,defaults).text).toBe("开始继续");
    expect(projectText({...r,partial:true},defaults).text).toBe("开始\n\n继续");
    expect(projectText({...r,cancelled:true},defaults).text).toBe("开始\n\n继续");
    expect(projectText(result([r.pages[0],{...r.pages[1],pageIndex:3}]),defaults).text).toBe("开始\n\n继续");
    expect(projectText(r,{...defaults,crossPageText:false}).text).toBe("开始\n\n继续");
  });
  it("removes repeated edge headers and page numbers, not matching body text",()=>{
    const r=result([0,1,2].map(i=>page([block("书名",20),block("书名",300),block(String(i+1),770)],i)));
    const output=projectText(r,defaults).text;
    expect(output.match(/书名/g)).toHaveLength(3);
    expect(output).not.toMatch(/[123]/);
    expect(projectText({...r,partial:true},defaults).text.match(/书名/g)).toHaveLength(6);
  });
  it("never rewrites legacy results, table text or manual edits",()=>{
    const p={...page([block("原始"),block("换行",126)]),schemaVersion:undefined};
    expect(projectText(result([p]),defaults).text).toBe(p.text);
    expect(projectText({...result([p]),text:"我的校对"},defaults,true).text).toBe("我的校对");
    expect(projectText({...result([p]),text:"我的校对"},defaults,true,true).text).toBe(p.text);
  });
  it("orders vertical columns right to left",()=>{
    const left={...block("左列"),direction:"vertical" as const,box:[20,20,40,500]};
    const right={...block("右列"),direction:"vertical" as const,box:[50,20,70,500]};
    expect(projectText(result([page([left,right])]),defaults).text).toBe("右列左列");
  });
  it("uses Unicode codepoint offsets for ruby and escapes all source text",()=>{
    const b={...block("𠮷薔薇色<script>"),ruby:[{start:1,end:4,text:"ばらいろ"}]};
    const r=result([page([b,{...block("ばらいろ"),role:"ruby"}])]);
    expect(projectText(r,{...defaults,rubyFormat:"ruby"}).html).toContain("𠮷<ruby>薔薇色<rt>ばらいろ</rt></ruby>&lt;script&gt;");
    expect(projectText(r,{...defaults,rubyFormat:"ignore"}).text).toBe(b.text);
    expect(projectText(r,defaults).text).toBe("𠮷薔薇色（ばらいろ）<script>");
    expect(projectText(r,defaults,false,true).text).toContain("\nばらいろ");
  });
  it("switches cached output modes without mutating any source data",()=>{
    const r=result([page([block("first"),block("second",126)])]);
    const original=JSON.stringify(r);
    for(const textMode of ["original","smart","continuous"] as const) projectText(r,{...defaults,textMode});
    expect(JSON.stringify(r)).toBe(original);
  });
  it("invalidates resume for extraction or ruby changes, not formatting",()=>{
    const r={...result([page([block("one")])]),selectedPageCount:3,scoreThreshold:.5,sourceSize:1,sourceMtimeNs:"2",pdfSource:"auto" as const,rubyEnabled:false};
    const options={profile:r.profile,mode:"text" as const,threshold:.5,pageRange:"",rotation:0,sourceSize:1,sourceMtimeNs:"2",pdfSource:"auto" as const};
    expect(canResumeResult(r,options)).toBe(true);
    expect(canResumeResult(r,{...options,pdfSource:"ocr"})).toBe(false);
    expect(canResumeResult(r,{...options,rubyEnabled:true})).toBe(false);
    expect(normalizeTextSettings({textMode:"continuous"}).pdfSource).toBe("auto");
  });
});
