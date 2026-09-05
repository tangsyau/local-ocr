import { describe, it, expect } from "vitest";
import { defaultTextSettings as defaults, projectText, normalizeTextSettings, normalizeSmartText } from "./text-processing";
import { canResumeResult, finalizeResult } from "./result-state";
import type { OcrBlock, OcrPage } from "./types";

const block=(text:string,y=100,x=20,width=400):OcrBlock=>({text,score:.9,box:[x,y,x+width,y+20],polygon:[],direction:"horizontal",fontSize:20});
const page=(blocks:OcrBlock[],index=0):OcrPage=>({schemaVersion:1,pageIndex:index,width:600,height:800,source:"ocr",text:blocks.map(b=>b.text).join("\n"),rawText:blocks.map(b=>b.text).join("\n"),blocks,tables:[]});
const result=(pages:OcrPage[])=>finalizeResult({resultType:"text"},pages);

describe("language-aware text projection",()=>{
  it.each([
    ['1.我们几乎不会说一个完全没有历史知识的人是“受过教育”的，', '1．我们几乎不会说一个完全没有历史知识的人是“受过教育”的，'],
    ['2. 下一项\n3.14 是小数\n1.2.3 版本', '2． 下一项\n3.14 是小数\n1.2.3 版本'],
    ['中文...继续', '中文……继续'],
    ['说明(English)', '说明（English）'],
    ['日本語 ( テスト )', '日本語（テスト）'],
    ['Hello（world）！', 'Hello(world)!'],
    ['时间9：00，数值3．14', '时间9:00，数值3.14'],
    ['说明https://例子.com/a?x=1，邮箱 a@example.com', '说明https://例子.com/a?x=1，邮箱 a@example.com'],
    ['文档说明.pdf，版本v1.2', '文档说明.pdf，版本v1.2'],
    ['a   b   c   d', 'a b c d'],
    ['漢 字 と仮名', '漢字と仮名'],
    ['かな の あいだ', 'かな の あいだ'],
    ['甲\n  新段落\n \t\n\n乙', '甲\n  新段落\n\n乙'],
    ['`print( 中文 , 1.2 )`', '`print( 中文 , 1.2 )`'],
    ['```\n中文 ,  x   y\n\n\n```', '```\n中文 ,  x   y\n\n\n```'],
  ])('normalizes safely and idempotently: %s', (input, expected) => {
    expect(normalizeSmartText(input)).toBe(expected);
    expect(normalizeSmartText(expected)).toBe(expected);
  });
  it('joins the reported short continuation while preserving the following paragraph', () => {
    const first='2是我们的思想家、我们的艺术家和将军们造就了我们的时代，无论是好';
    const rest=['今天，没有人会认为阅读莎士比亚的作品，或沉思米开朗基罗的创',
      '作是浪费时间，因为它们自身具有内在价值，不会因为其作者的死亡和我',
      '们时代之间已然逝去的年岁而减损。同样，我们也不会认为研究柏拉图、',
      '亚里士多德或奥古斯丁是浪费韶光，因为他们的思想创作作为人类精神的',
      '卓越成就而永存。自鲁本斯时代以来，很多艺术家都在生活与创作，但是',
      '这并未减损鲁本斯作品的价值。自柏拉图的时代以来，很多思想家都做哲',
      '学研究，但都未摧毁柏拉图哲学的兴味与美妙。'];
    for (const change of [{fontSize:16}, {box:[40,126,100,146]}, {box:[20,145,80,165]}]) {
      const r=result([page([block(first,100,20,600), {...block('是坏。',126,20,60),...change},
        ...rest.map((s,i)=>block(s,180+i*26,20,600))])]);
      expect(projectText(r,defaults).text).toBe(first+'是坏。\n\n'+rest.join(''));
    }
  });
  it('preserves fullwidth numbered lists, headings, separate columns and distant paragraphs', () => {
    const first='这是一段尚未结束的长句，应该结合版面判断是否连接';
    for (const next of [block('2．我们开始下一项',126), block('第二章 新章',126),
      block('另一栏正文',126,500,400), block('独立段落',250), {...block('大标题',126),fontSize:32}]) {
      expect(projectText(result([page([block(first),next])]),defaults).text).toContain('\n\n');
    }
    expect(projectText(result([page([block('1.我们是第一项'),block('2.我们是第二项',126)])]),defaults).text)
      .toBe('1．我们是第一项\n\n2．我们是第二项');
  });
  it('normalizes once before Ruby rendering, preserving offsets, readings and source data', () => {
    const b={...block('𠮷... 薔 薇,中文'),ruby:[{start:5,end:8,text:'ばら<>&'}]};
    const r=result([page([b])]), before=JSON.stringify(r);
    const plain=projectText(r,defaults);
    const ruby=projectText(r,{...defaults,rubyFormat:'ruby'});
    expect(ruby.html).toContain('<ruby>薔薇<rt>ばら&lt;&gt;&amp;</rt></ruby>，中文');
    expect(plain.text).toBe(ruby.text);
    expect(ruby.text).toContain('薔薇（ばら<>&），中文');
    expect(JSON.stringify(r)).toBe(before);
  });
  it('leaves table-mode text and coordinate-free legacy pages intact', () => {
    const p=page([block('表 格 , 内容\n\n\n1.说明')]);
    const r=result([p]);
    expect(projectText({...r,resultType:'table'},defaults).text).toBe(r.text);
    expect(projectText(result([{...p,schemaVersion:undefined}]),defaults).text).toBe(p.text);
  });
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
