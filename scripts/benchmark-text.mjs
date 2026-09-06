// Synthetic frontend workload; excludes PDF rendering and model inference.
import {build} from 'esbuild';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {reactive,watch,nextTick} from 'vue';
const compiled=await build({entryPoints:['src/lib/text-processing.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {projectText,defaultTextSettings}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const sessionBundle=await build({entryPoints:['src/lib/session.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {sessionHeader}=await import('data:text/javascript;base64,'+Buffer.from(sessionBundle.outputFiles[0].text).toString('base64'));
const rows=[];
for(const count of [100,500,1000]){
 if(global.gc)global.gc();
 const heapBefore=process.memoryUsage().heapUsed;
 const pages=Array.from({length:count},(_,i)=>({pageIndex:i,schemaVersion:1,width:600,height:840,source:'ocr',text:'',tables:[],blocks:Array.from({length:30},(_,j)=>({text:'这是用于测量长文档逐页整理、段落衔接与保存开销的测试文字。',box:[20,40+j*24,560,60+j*24],fontSize:20,polygon:[],score:.95,direction:'horizontal'}))}));
 for(const p of pages)p.text=p.blocks.map(b=>b.text).join('\n');
 const result=reactive({path:'benchmark.pdf',profile:'fast',resultType:'text',text:'',pages,pageCount:count,totalPageCount:count+1,selectedPageCount:count+1,partial:true,cancelled:false,tables:[]});
 let t=performance.now();projectText(result,defaultTextSettings);const cold=performance.now()-t;
 t=performance.now();projectText(result,defaultTextSettings);const warm=performance.now()-t;
 const task=reactive({revision:0,result});
 let stop=watch(task,()=>{}, {deep:true});t=performance.now();task.revision++;await nextTick();const deep=performance.now()-t;stop();
 stop=watch(()=>sessionHeader({schema:2,savedAt:'',selectedTaskId:'',settings:{},tasks:[task]}).tasks,()=>{}, {deep:true});t=performance.now();task.revision++;await nextTick();const header=performance.now()-t;stop();
 rows.push({pages:count,heapBeforeMiB:+(heapBefore/1048576).toFixed(2),heapAfterMiB:+(process.memoryUsage().heapUsed/1048576).toFixed(2),coldProjectionMs:+cold.toFixed(2),warmProjectionMs:+warm.toFixed(2),deepWatchMs:+deep.toFixed(2),headerWatchMs:+header.toFixed(2)});
}
const report={memoryNote:'Sampled Node process heap, not peak/native memory; includes Vue and benchmark allocations',explicitGc:!!global.gc,kind:'Synthetic Vue/JS frontend; no model or native WebView benchmark',node:process.version,measurements:rows};
console.log(JSON.stringify(report,null,2));
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
