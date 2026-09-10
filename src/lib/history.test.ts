import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { OcrTask } from "./types";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
function task(): OcrTask {
  return {id:"book",path:"/book.pdf",fileName:"book.pdf",batchId:"batch",batchIndex:0,status:"completed",resultType:"text",revision:2,textEdited:true,
    result:{path:"/book.pdf",profile:"fast",resultType:"text",cancelled:false,text:"手工校对",editedPageCount:1,pageCount:2,totalPageCount:2,blockCount:0,tableCount:0,rawTableCount:0,elapsedMs:10,tables:[],
      pages:[{pageIndex:0,text:"原始第一章",blocks:[],tables:[]},{pageIndex:1,text:"第二章",blocks:[],tables:[]}]}};
}
describe("durable recognition history", () => {
  it("retains pages and corrections after clearing the queue and reopening", async () => {
    let api = await import("./session");
    await api.loadSession();
    const book=task();
    await api.saveSession({schema:2,savedAt:"2026-09-10",selectedTaskId:book.id,settings:api.defaultSettings,tasks:[book]},
      {pages:book.result!.pages.map(page=>({taskId:book.id,pageIndex:page.pageIndex!,page}))});
    await api.saveSession({schema:2,savedAt:"2026-09-11",selectedTaskId:"",settings:api.defaultSettings,tasks:[]});
    vi.resetModules(); api=await import("./session");
    expect((await api.loadSession())!.tasks).toHaveLength(0);
    const list=await api.listHistory();
    expect(list).toHaveLength(1);
    expect(list[0].task.result!.pages).toHaveLength(0);
    const restored=await api.readHistory("book");
    expect(restored.task.result!.pages.map(page=>page.text)).toEqual(["原始第一章","第二章"]);
    expect(restored.task.result!.text).toBe("手工校对");
    expect(restored.task.result!.editedPageCount).toBe(1);
    await api.deleteHistory(["book"]);
    expect(await api.listHistory()).toEqual([]);
    await expect(api.readHistory("book")).rejects.toThrow("不存在");
  });
  it("protects active records from permanent deletion, restores without original files", async () => {
    const api=await import("./session"); await api.loadSession(); const book=task();
    const session={schema:2 as const,savedAt:"now",selectedTaskId:"book",settings:api.defaultSettings,tasks:[book]};
    await api.saveSession(session,{pages:book.result!.pages.map(page=>({taskId:book.id,pageIndex:page.pageIndex!,page}))});
    await expect(api.deleteHistory(["book"])).rejects.toThrow("当前队列");
    await api.saveSession({...session,tasks:[]});
    const recovered=await api.readHistory("book");
    await api.saveSession({...session,tasks:[recovered.task]});
    expect((await api.loadSession())!.tasks[0].result!.pages).toHaveLength(2);
    await expect(api.deleteHistory(["book"])).rejects.toThrow("当前队列");
  });
  it("migrates a schema-1 session to history without losing inline pages", async () => {
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("local-ocr-session",1);r.onupgradeneeded=()=>r.result.createObjectStore("state");r.onsuccess=()=>resolve(r.result);});
    const api=await import("./session");const book=task();
    await new Promise<void>(resolve=>{const tx=db.transaction("state","readwrite");tx.objectStore("state").put({schema:1,savedAt:"old",settings:api.defaultSettings,tasks:[book]},"session");tx.oncomplete=()=>resolve();});db.close();
    const old=(await api.loadSession())!;
    expect(old.needsPageMigration).toBe(true);
    await api.saveSession(old,{pages:old.tasks[0].result!.pages.map(page=>({taskId:"book",pageIndex:page.pageIndex!,page}))});
    await api.saveSession({...old,tasks:[]});
    expect((await api.readHistory("book")).task.result!.pages).toHaveLength(2);
  });
  it("does not read archived pages at startup", async () => {
    const api=await import("./session");await api.loadSession();const book=task();
    const session={schema:2 as const,savedAt:"now",selectedTaskId:"book",settings:api.defaultSettings,tasks:[book]};
    await api.saveSession(session,{pages:book.result!.pages.map(page=>({taskId:"book",pageIndex:page.pageIndex!,page}))});
    await api.saveSession({...session,tasks:[]});
    const {IDBObjectStore}=await import("fake-indexeddb");const reads=vi.spyOn(IDBObjectStore.prototype,"getAll");
    await api.loadSession(); expect(reads).not.toHaveBeenCalled();reads.mockRestore();
  });
  it("a stale window cannot clear another window's saved queue or history", async () => {
    const first=await import("./session");await first.loadSession();const book=task();
    const session={schema:2 as const,savedAt:"now",selectedTaskId:"book",settings:first.defaultSettings,tasks:[book]};
    await first.saveSession(session,{pages:book.result!.pages.map(page=>({taskId:"book",pageIndex:page.pageIndex!,page}))});
    vi.resetModules();const second=await import("./session");await second.loadSession();
    await first.saveSession({...session,savedAt:"newer"});
    await expect(second.saveSession({...session,tasks:[]})).rejects.toThrow("另一个窗口");
    expect((await first.readHistory("book")).task.result!.pages).toHaveLength(2);
    expect((await first.loadSession())!.tasks).toHaveLength(1);
  });

});
