// Chromium layout checks use a mocked native bridge. Installed-package startup
// (real WebView + real sidecar) is tested separately by smoke-desktop.py.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error("Install playwright@1.62.1 and its Chromium browser to run layout tests");
  playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "playwright"));
}
const server = await createServer({ server: { host: "127.0.0.1", port: 17320, strictPort: true }, logLevel: "error" });
await server.listen();
let browser;
const screenshots = path.resolve("test-results/layout");
await mkdir(screenshots, { recursive: true });
try {
  browser = await playwright.chromium.launch();
  for (const [screenWidth, screenHeight] of [[1920, 1080], [1366, 768]]) {
    for (const scale of [1, 1.25, 1.5]) {
      // Reserve 80 physical pixels for title bar/taskbar, then simulate the CSS
      // viewport size and device scale factor seen by the desktop WebView.
      const viewport = { width: Math.floor(screenWidth / scale), height: Math.floor((screenHeight - 80) / scale) };
      const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/src/lib/sidecar.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
        export class SidecarRequestError extends Error {}
        export const ocrSidecar = { running: true, stderr: '', start: async()=>{}, stop: async()=>{},
          onExit: ()=>()=>{}, request: async(method, params)=>{
            if(method==='ui_smoke_status') return {enabled:false};
            if(method==='validate_paths') return {items:params.items.map(x=>({id:x.id,exists:true}))};
            if(method==='model_status') return null;
            if(method==='document_info') return {totalPageCount:12,selectedPageCount:3};
            return {};
          }};` }));
      await page.route("**/src/lib/tauri-bridge.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
        export const isWebkitGtk40Build=false;
        export const localImagePreview=async()=>{
          const canvas=document.createElement('canvas');canvas.width=800;canvas.height=400;
          const drawing=canvas.getContext('2d');drawing.fillStyle='#527563';drawing.fillRect(0,0,800,400);
          drawing.fillStyle='#f0f4e6';drawing.font='48px sans-serif';drawing.fillText('LOCAL OCR',50,100);
          return canvas.toDataURL('image/png');
        };
        export const createId=()=>crypto.randomUUID();
        export const openLocalDialog=async()=>null;
        export const listenBeforeClose=async()=>()=>{};
        export const listenFileDrop=async()=>()=>{};` }));
      await page.goto("http://127.0.0.1:17320");
      await page.getByText("识别进程已就绪", { exact: false }).waitFor();
      const dimensions = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar");
        return { documentWidth: document.documentElement.scrollWidth, width: innerWidth,
          sidebarFits: sidebar.scrollHeight <= sidebar.clientHeight + 2 };
      });
      assert.ok(dimensions.documentWidth <= dimensions.width + 2, "app overflows horizontally");
      if (screenWidth === 1920) assert.ok(dimensions.sidebarFits, `1080p initial sidebar overflows at ${scale}`);
      await page.screenshot({ path: path.join(screenshots, `${screenWidth}-${scale}-initial.png`) });
      await page.evaluate(async () => {
        const table = { pageIndex: 0, endPageIndex: 0, tableIndex: 0, sourceTableCount: 1, score: .95, box: [], html: "",
          rows: Array.from({length:120}, (_,row)=>Array.from({length:15}, (_,column)=>({row,column,rowSpan:1,colSpan:1,text:`行 ${row} 列 ${column}`,box:[]}))) };
        const result = {path:"/sample.png",profile:"fast",resultType:"table",cancelled:false,text:"识别测试",pageCount:1,totalPageCount:1,
          blockCount:1,tableCount:1,rawTableCount:1,elapsedMs:10,pages:[{pageIndex:0,text:"识别测试",blocks:[],tables:[table]}],tables:[table]};
        const session = {schema:1,savedAt:new Date().toISOString(),selectedTaskId:"sample",tasks:[{id:"sample",batchId:"sample",batchIndex:0,
          path:"/sample.png",fileName:"sample.png",status:"completed",resultType:"table",result}],
          settings:{profile:"fast",mode:"table",threshold:.5,merge:true,formats:["txt","xlsx"],exportGrouping:"separate",exportCollision:"rename"}};
        await new Promise((resolve,reject)=>{
          const request=indexedDB.open("local-ocr-session",1);
          request.onsuccess=()=>{ const db=request.result; const tx=db.transaction("state","readwrite");
            tx.objectStore("state").put(session,"session"); tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};request.onerror=reject;
        });
      });
      await page.reload();
      await page.getByRole("button", { name: "表格 1", exact: true }).click();
      const scrollInfo = await page.evaluate(() => {
        const top = document.querySelector(".table-top-scroll");
        const body = document.querySelector(".table-scroll");
        const header = document.querySelector(".table-card-header");
        top.scrollLeft = 420;
        top.dispatchEvent(new Event("scroll"));
        return { top: top.scrollLeft, body: body.scrollLeft, width: top.scrollWidth, viewport: top.clientWidth,
          bodyScrollbar: getComputedStyle(body,"::-webkit-scrollbar").display, headerPosition: getComputedStyle(header).position };
      });
      assert.ok(scrollInfo.width > scrollInfo.viewport);
      assert.equal(scrollInfo.top, scrollInfo.body);
      assert.ok(scrollInfo.top > 0);
      assert.equal(scrollInfo.bodyScrollbar,"none");
      assert.notEqual(scrollInfo.headerPosition,"sticky");
      await page.getByRole("button", {name:"进入专注模式",exact:true}).click();
      const focusFits = await page.locator(".result-panel").evaluate((element)=>element.getBoundingClientRect().bottom <= innerHeight + 2);
      assert.ok(focusFits, "focus mode exceeds viewport");
      await page.screenshot({path:path.join(screenshots,`${screenWidth}-${scale}-table.png`)});
      await page.getByRole("button", {name:"退出专注模式",exact:true}).click();
      await page.getByRole("button", {name:"右转 90°",exact:true}).click();
      await page.waitForFunction(() => {
        const box = document.querySelector('.rotation-box');
        return box && box.getBoundingClientRect().height > box.getBoundingClientRect().width;
      });
      const rotationFits = await page.evaluate(() => {
        const image = document.querySelector('.rotation-box img').getBoundingClientRect();
        const stage = document.querySelector('.rotation-stage').getBoundingClientRect();
        return image.left >= stage.left && image.right <= stage.right + 1 && image.top >= stage.top && image.bottom <= stage.bottom + 1;
      });
      assert.ok(rotationFits, 'rotated preview must fit without clipping');
      await page.screenshot({path:path.join(screenshots,`${screenWidth}-${scale}-rotation.png`)});
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`Layout passed: ${screenWidth}x${screenHeight} / ${scale*100}%`);
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
