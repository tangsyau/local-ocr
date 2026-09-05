# Local OCR

一个以隐私为优先的跨平台 OCR 桌面程序原型：Vue 3/TypeScript 图形界面，Python + PaddleOCR sidecar。Windows 和常规 Linux 版本使用 Tauri 2；另提供 Tauri 1 / WebKitGTK 4.0 的 Linux x64 兼容 AppImage。

## 当前功能

当前版本为 **0.12.1：标点规范与正文断行修复**。保留 PDF 智能取文、多语言文本整理与实验性日语注音，并提供整理前后对照查看；不改变 Paddle 模型或 Debian 10 / glibc 2.28 兼容基线。

### 0.12.1 使用方法

智能整理修复段首序号句点、成对括号、省略号、网址保护与空格遗漏。对同栏长句末尾的短续行，结合常见字号和行距处理，减少“无论是好／是坏。”被错误分段。已有的结构化结果可直接重新整理；手工校对版仍优先保留，无需重新下载模型。

文档预览上方的“文档设置”默认展开：默认 PDF 自动取文、智能整理和跨页正文连接，日语注音识别默认关闭。启用日语注音后才能选择三种注音输出。文字来源和注音识别影响下一次识别；断行、跨页连接、注音输出格式只重新整理已有结果，不会重新 OCR。完整说明和已知限制见 [文本处理说明](docs/TEXT_PROCESSING.md)。

- 自动逐页提取可靠的 PDF 文本层；扫描页、乱码、旋转/裁剪坐标或较大图片区域采用整页 OCR。质量检查是保守启发式，不能证明文本层完整；异常时可强制 OCR。当前启动队列仍会准备所选模型，以便随时回退。
- 新页保留原始文字、坐标、来源及字号/方向信息。中日文合并不加空格，英文补空格；软连字符可还原，普通连字符只在文内存在完整拼写证据时去掉，其他情况保留。
- 规则横排、竖排日文可分离注音，输出正文、括号或 HTML Ruby。扫描页的局部识别和字词绑定仍为实验性，存在漏检和错配；请对照原文检查，不适用于复杂混排/古籍夹注。
- 结果区可切换只读原始结果；手工校对内容不会被设置覆盖。Ruby 预览取消勾选后可校对括号文本，手工版不再自动重建 Ruby 对应关系。
- TXT/复制使用当前显示版；文字模式支持 HTML，合并导出时每种格式一份，表格输出沿用原有逻辑。
- 旧结果保持可读；缺少版面数据时保留原文，需要重新识别才能获得新增能力。文字来源/注音识别变化不复用旧断点，输出格式变化不影响续识。

### 历史 0.9.2 构建修复

普通 Linux 布局测试不再试图把已经由应用打开到版本 2 的 IndexedDB 降级打开为版本 1。测试现在是在版本 2 数据库中写入 schema 1 格式的旧会话，再重载应用验证迁移到分离式逐页存储；同时将 IndexedDB 错误转换成可读的 `Error`，不再只输出 `page.evaluate: Event`。

本次 Actions 日志已经确认 Windows NSIS 和 WebKitGTK 4.0 / glibc 2.28 AppImage 的构建、真实模型验证与安装包启动测试全部成功。0.9.2 仅修复普通 Linux 的布局测试脚本，不修改应用界面与 OCR 内核。

### 0.9.1 构建修复

两项 Linux 任务都不再在 `npm ci` 后临时改写根依赖树：布局测试所需的 Playwright 1.62.1 纳入根锁文件；WebKitGTK 4.0 所需的 Tauri 1.6.3 则使用独立目录和独立锁文件。这样避开新版 npm 在 `npm install --no-save` 时触发的 `Cannot read properties of null (reading 'edgesOut')`。Windows 日志显示 0.9.0 的冻结 sidecar、模型、NSIS 和安装启动测试均已通过，本次不改动识别内核。

### 0.9.0 使用方法

**断点续识**：PDF 每完成一页就把该页作为独立检查点保存。任务取消、失败、sidecar 被强制停止或软件异常退出后，点击“重试”，再开始批量识别；若原文件及全部识别设置没有变化，程序会跳过已经完成的连续页面，从下一页继续，进度会计入先前完成页。正在计算但尚未返回的一页不算完成页。主动点击“重新识别当前文件”仍表示从头替换旧结果。

为避免错误拼接，程序同时核对文件大小、纳秒修改时间、模型档位、文字/表格模式、置信度、指定页码和旋转参数。任何一项不同都会自动从头识别。0.8.x 部分结果没有这些完整指纹，因此只恢复查看，不直接续识。

**增量保存**：自动保存数据库将任务摘要和逐页结果分开存放；识别新页面时只写入该页及轻量摘要，不再反复复制整份长 PDF 结果。页面累计值原位更新，跨页表格在任务结束时合并一次。首次打开旧版本的自动保存记录时会迁移到新结构；识别文字仍只存本机且不加密。

**自然排序**：同一次添加的文件自动按文件名自然排序，例如 `第2页.png` 位于 `第10页.png` 前；队列中的“自然排序”按钮可随时重新排序，原有上移/下移仍可用于手工调整。

旧结果的文字/表格模式会从结果本身恢复，而不是套用当前全局模式；旧表格结果缺少模式字段时，会根据表格数据推断。对某项使用“重新识别当前文件”时，程序会切回该结果原来的模型档位与识别模式。

0.12.1 验证记录见 [验证说明](docs/VALIDATION-0.12.1.md)。Windows/Linux 冻结 sidecar、真实模型推理、AppImage 与 NSIS 安装包仍由 GitHub Actions 和目标电脑完成最终验证。

### 0.8.1 历史修复说明

- Windows 路径测试按目录身份比较，兼容长路径和 8.3 短路径；图片/PDF 依赖和 Pillow 插件在主线程初始化，实际解码、识别仍在后台执行。
- 窄窗口和高缩放下保留图片的最低可见高度。中间预览/结果栏空间不足时可滚动，不再强行压缩图片；1080p 初始侧栏布局保持不变。
- CI 模型准备和识别超时前都会输出线程堆栈；短时源码测试也能捕获堆栈。仅测试环境启用，不写入用户日常诊断日志。
- 0.8.1 不需要清空模型缓存或重新导出 0.8.0 模型包；这些兼容性修复已经包含在 0.9.0 中。
- Windows NSIS、Linux 常规 AppImage、WebKitGTK 4.0 / glibc 2.28 兼容 AppImage 的构建方式不变；布局失败时 Actions 的 `local-ocr-layout-checks` 附件包含失败截图和尺寸 JSON。

Windows 的旧日志不足以证明具体卡死原因；本版通过提前初始化和新增诊断处理该问题，仍须以新一轮 Actions 源码测试、真实冻结包识别及目标电脑验证为准。未跳过失败测试，也未单纯延长原有请求超时。

0.8.1 当时已通过 78 项 Python 测试、28 项前端测试，以及标准版/兼容版的前端生产构建。Windows/Linux 原生安装包与模型推理继续由 Actions 执行。

### 0.8.0 使用方法

**PDF 指定页码**：选择队列中的 PDF，在中间文档预览区选择“全部页”或“指定页码”，输入 `1,3-5,8` 后点“应用页码”。页码是 PDF 实际顺序，不是正文印刷页码。范围会去重、排序并校验越界；“应用到勾选 PDF”只影响勾选的 PDF，任一文件验证失败时整次设置不应用。只有选中的页会渲染并送入 OCR，原文第 2、5 页不会被当作连续页合并表格。进度分别显示原文页码和所选页数的完成比例。

**图片旋转**：选中图片，在预览上方左转、右转或还原；也可将当前角度应用到勾选的图片。先按 EXIF 方向读取，再叠加手动旋转，实际 OCR 输入与预览方向一致。原文件不修改。已有结果不会自动重跑；点“重新识别当前文件”加入队列，再点击开始，确认后替换结果。如果第一页就失败，原结果仍保留。本版不增加 PDF 预览、PDF 单页旋转或原图联动校对。

**离线迁移**：请阅读 [离线使用说明](docs/OFFLINE.md)。入口在“模型管理 → 在离线电脑上使用”。联网电脑选择文字/表格与轻量/高精度组合，点“准备并导出模型”；将导出的整个 `LocalOCR-models` 文件夹与目标系统的软件安装包/AppImage 一起带走。离线电脑点“从本地导入模型”，校验及内置样张试识别通过后导入本机缓存，并自动开启“仅使用本地模型”。共用模型去重；包中不含原文档、识别结果、历史数据库或 Python 环境。

迁移采用独立进程逐个验证模型组合，避免切换原生模型；提供下载阶段提示、文件复制进度及取消。导入先在临时目录校验 SHA-256 并以显式本地路径试识别，再短暂提交；普通失败会回滚，已有模型在验证阶段不变。取消不会删除已经下载成功的官方缓存。提交阶段不可取消，请勿强制关机；异常断电仍需检查缓存，不能承诺跨多个目录的文件系统级原子事务。

Windows 不新增内置 WebView2 的大安装包：启动失败时提供原生提示及官方离线运行库下载地址；若安装程序本身因 WebView2 下载失败退出，请先按说明补装运行库。Linux 继续提供常规版与 WebKitGTK 4.0 / glibc 2.28 兼容版。

- 批量选择 PNG、JPEG、WebP、BMP、TIFF 或 PDF，并按队列顺序识别；
- 在“普通文字”和“表格与文字”两种模式之间切换；表格模式使用 TableRecognitionPipelineV2、PicoDet 表格版面检测和 SLANet_plus 轻量结构模型；
- 在 PP-OCRv5 轻量与高精度检测/识别模型之间切换，模型按需联网下载；
- 模型常驻 Python sidecar，同一档位的连续任务不重复初始化；
- 支持在当前页结束后暂停、继续或取消队列，并提供无响应时强制停止；
- PDF 在识别前读取总页数，任务列表显示正在处理的页码、总页数、已完成比例和进度条；
- 识别阶段临时阻断 Python socket 连接；
- 逐页返回文字、置信度、文本框坐标和纯文本；
- 每个文件独立保留结果，可校对、复制，并自由组合导出 TXT、XLSX 和安全的静态 HTML；
- 表格结果按页预览行列及合并单元格；顶部保留唯一可见的横向滚动条，不必滚到长表格底部；
- 表格结果区支持独立纵向滚动；切换到“表格”标签后可复制 TSV 制表符文本并直接粘贴到 Excel；
- 连续 PDF 页或同一次选择的连续图片各只有一张表、列结构一致且重复表头高度相似时，可合并为一张跨页表格并去掉后续页重复表头；
- 后台完成后续批量任务时不会自动切换当前结果，识别期间可以稳定查看、校对已经完成的页面；
- 任务、逐页结果、人工校对和常用设置自动保存在本机，异常关闭后恢复已完成内容，未完成任务等待手动重试；
- 支持拖放图片/PDF、任务排序、多选移除、批量重试、跳过当前文件继续下一项；
- 导出可选分别保存或汇总保存，并设置文件名前后缀、日期/模型/模式标记，以及同名文件自动编号、跳过或覆盖；
- Windows 发布版将 Tauri 主程序设为 GUI 子系统，并隐藏 sidecar 控制台，同时保留管道通信；
- Windows 和 Linux 启动时默认最大化；较小屏幕仍可滚动和手动调整窗口；
- Linux 同时提供 WebKitGTK 4.1 常规版和 WebKitGTK 4.0 兼容版，两个版本共用 OCR 功能；
- NDJSON 标准输入/输出通信，不启动本地 HTTP 端口。

当前表格功能仍属于轻量档：适合常见有线表格和较规整的无线表格。它会恢复行列、单元格文字以及模型判断出的 `rowspan`/`colspan`，但不会还原原始字体、公式、单元格颜色、精确列宽或 Excel 计算逻辑。轻量档明确关闭了会在首次推理时懒下载模型的表格方向分类，因此应先把横置或倒置的表格旋转到正常阅读方向；倾斜严重、密集小字和拍照畸变表格仍可能需要人工校对。跨页合并采用保守规则，没有重复表头、一页包含多张表或表头识别差异较大时，仍会保留为逐页表格，以免误合并无关内容。

### 0.6.1 界面与维护功能

- 识别结果右上角增加专注模式，隐藏设置区和预览区，让文字或表格占满窗口；再次点击或按 `Esc` 退出。
- 每张表格标题下方都有顶部横向滚动条；内容区原生横向滚动条隐藏但仍支持触控板和平移，因此不会出现两个滚动条，也不会覆盖首行。
- “合并 PDF 或同批图片的连续表格”可以随时开关；对已经识别的结果执行“按页拆分”或重新合并，不需要再次 OCR。复制 TSV 和导出 XLSX/HTML 会遵循当前选择。
- 导出区可以任意勾选 TXT、XLSX、HTML 组合；未勾选的格式不会创建文件。
- 队列任务完成时不再抢占当前查看项；1080p 窗口下的标题栏、侧栏间距和任务列表高度也已压缩，初始界面可在一屏显示。
- 模型管理面板显示当前模型组合、缓存目录和占用空间，支持刷新、校验并载入，以及在二次确认后删除当前组合的官方模型缓存。
- 底部错误提示支持展开技术详情，并可复制不含识别文字和文档内容的版本、平台、模型状态及 sidecar 诊断信息。

### 0.7.0 新增功能与边界

**自动保存与恢复**

- 使用桌面 WebView 的本机 IndexedDB 原子保存队列、识别文字、表格数据、修改后的文字和常用设置。只记录原文件路径，不复制原文档；每次修改约 400 ms 后保存，正常关闭前再保存一次。
- PDF 每完成一页就回传该页结果，后续页追加时保留当前阅读位置和已校对文字。断电或强制结束仍可能丢失正在计算或尚未写入的最后一页。
- 重新启动不自动识别；上次正在运行/暂停的任务转回等待。重试从该文件第一页重新识别，不承诺从 PDF 中断页精确续算。已保存的部分结果在重试前可导出。
- 原文件移动/删除后会提示不可访问，历史识别结果仍可查看和导出。恢复原路径后可重试，或移除任务再添加新路径。
- 常规版恢复图片预览时，会重新授权当前这一张本地图片，不开放整个目录；无法显示的图片会给出独立提示，不影响历史识别结果。
- 有未导出结果或正在处理的任务时关闭窗口会提醒。多窗口同时保存发生冲突时会停止覆盖并提示先导出。清理或移除任务也会移除对应的恢复记录。
- 0.6.x 没有自动保存历史，因此无法恢复升级前已经关闭且未导出的旧结果。普通版本与 WebKitGTK 4.0 版本使用不同的应用数据区，历史不自动互通。

**批量和导出**

- 队列空闲时可上移/下移任务，同批图片表格的页序随之调整；运行期间不改变队列顺序。支持多选移除、勾选重试和全部失败项重试。
- “跳过当前文件”在当前页结束后生效，会保留已完成页并继续下一项；“取消队列”仍停止整批。
- 导出规则支持 TXT/XLSX/HTML 任意组合。分别导出时 TXT 按源文件，表格按 PDF 或同次选择的图片批次；汇总导出时每种格式生成一份文件，XLSX 每张逻辑表格一个工作表，不把无关表格强拼成同一张表。
- 前后缀支持 `{date}`、`{profile}`、`{mode}`，非法文件名字符会被替换。默认自动编号不覆盖；选择覆盖时会再次确认数量和文件名。表格缺失的任务不会生成空 XLSX/表格 HTML；文字模式可以生成文字 HTML。
- XLSX 中的 OCR 文字按纯字符串写入，即使以 `=` 开头也不会作为公式执行。HTML 仍使用转义后的静态表格。

**模型与诊断**

- 首次导入 Paddle/PaddleOCR/PaddleX 在 sidecar 主线程执行，完成后再由后台线程创建模型、按需下载；界面仍独立运行。日志区分依赖导入与模型创建，导入期间暂停缓存查询，随后可查询已落盘字节数和必要文件状态。下载源没有可靠总量时不虚构百分比或总大小。
- 切换已载入的模型组合时保留 0.7.1 的进程隔离措施；它并不是已证实的首次 prepare 超时修复。
- 必要文件齐全不等于校验和验证；模型能否实际载入仍由准备操作判断。如缓存异常，使用“删除当前模型缓存”后重新准备；删除范围会在确认框中说明，原文档和识别结果不受影响。
- sidecar 退出后已完成结果和等待队列保留，可一键重启后继续。新进程不会被旧进程迟到的退出事件误关闭。
- 本地运行日志只记录时间、操作类别、错误类别；不写入原始 stderr、文件路径或识别文字。诊断 ZIP 只含白名单版本/系统信息和经过过滤的事件日志，不包含恢复数据库。
- 日志位置：Windows `%LOCALAPPDATA%/local-ocr/logs`；Linux `${XDG_STATE_HOME:-~/.local/state}/local-ocr/logs`。界面提供打开日志目录和导出诊断包入口；日志最多保留约 3 × 256 KB。

## 隐私边界

`prepare` 阶段允许 PaddleOCR 下载所选档位的官方模型；表格模式首次准备还会下载版面检测和表格结构模型，因此耗时和磁盘占用高于普通文字模式。`recognize` 阶段只向 sidecar 传递本地路径，并使用 `block_python_network()` 阻止 Python 网络连接。暂停期间仍处于同一次本地识别任务中。项目不包含文档上传、云端 OCR、遥测或崩溃报告代码。

这个 Python 网络守卫不是操作系统级沙箱。若用于需要形式化合规保证的环境，下一步应把模型下载器拆为独立进程，并在操作系统层限制 OCR worker 的网络权限。

自动保存的识别内容未加密，属于本机用户数据，并不是诊断日志。使用共享电脑或处理敏感材料后，可清理已结束任务/移除相关任务；如需更高保障，应配合操作系统账户隔离及磁盘加密。不要把本机 WebView 数据目录放入云同步目录。

## 开发环境

- Node.js 20+
- Rust 1.77.2+
- Python 3.10–3.12（建议 3.11）
- Tauri 对应平台依赖

PaddlePaddle 的 GPU 和部分平台安装命令不同。本原型的 `requirements.txt` 是 CPU 基线；发布其他架构前应按 PaddlePaddle 官方安装矩阵调整并锁定版本。

## 首次构建

### 1. 安装前端依赖

```bash
npm install
```

### 2. 创建 sidecar 虚拟环境

Linux/macOS：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -r sidecar/requirements-build.txt
```

Windows PowerShell：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
python -m pip install -r sidecar\requirements-build.txt
```

### 3. 生成当前平台的 sidecar

```bash
npm run sidecar:build
```

脚本会按照 Tauri 规则生成类似文件：

```text
src-tauri/binaries/ocr-sidecar-x86_64-pc-windows-msvc.exe
src-tauri/binaries/ocr-sidecar-aarch64-apple-darwin
src-tauri/binaries/ocr-sidecar-x86_64-unknown-linux-gnu
```

### 4. 运行桌面程序

```bash
npm run tauri dev
```

### 5. 生成安装包

```bash
npm run tauri build
```

跨平台发布时应在对应系统上分别执行 sidecar 和 Tauri 构建，不要把某个平台生成的 PaddlePaddle 原生库复制到另一个平台。

## 使用 GitHub Actions 构建

仓库已经包含 `.github/workflows/build-desktop.yml`，构建三个独立产物：

- Windows x64：NSIS EXE；
- Linux x64：Tauri 2 / WebKitGTK 4.1 AppImage；
- Linux x64 WebKitGTK 4.0 兼容版：Tauri 1 AppImage，在 Debian 10（glibc 2.28）容器中构建。

两个 Linux AppImage 是二选一，不需要同时安装。优先使用常规的 `local-ocr-linux-x64`；若目标电脑缺少 WebKitGTK 4.1、启动时报动态库错误，改用名称带 `webkitgtk-4.0` 的兼容版。兼容版标题栏和界面顶部会显示“WebKitGTK 4.0 兼容版”。

### 第一次运行

1. 在 GitHub 新建一个空仓库；
2. 把本项目的全部文件上传到仓库根目录，确保 `.github` 隐藏目录也已上传；
3. 打开仓库的 **Actions** 页面；
4. 选择 **Build Windows and Linux x64**；
5. 点击 **Run workflow**；
6. 三个任务完成后，在该次运行页面底部按目标系统下载：
   - `local-ocr-windows-x64`；
   - `local-ocr-linux-x64`；
   - `local-ocr-linux-x64-webkitgtk-4.0-glibc-2.28`。

工作流也会在推送 `v*` 标签时自动运行，例如：

```bash
git tag v0.12.1
git push origin v0.12.1
```

构建产物作为 Actions Artifact 保存 14 天。当前产物没有代码签名，因此 Windows 首次运行可能显示 SmartScreen 警告。正式公开发布前还应修改 `src-tauri/tauri.conf.json` 中的 `com.example.localocr` 标识，并配置 Windows 代码签名。

注意：修改应用标识可能改变 WebView 历史数据目录；已有自动保存用户数据时，应先设计迁移，不能把修改标识当作无影响的版本升级。

工作流对冻结后的 sidecar 和 PaddleOCR 模型分别使用内容寻址缓存：源码和依赖未变化时会跳过 PaddleOCR/PyInstaller 的重复安装与冻结。常规 Windows/Linux 任务验证普通文字的轻量、高精度两档，再验证一次轻量表格流水线；4.0 兼容任务为缩短首次构建时间，只验证普通文字轻量档和轻量表格流水线。Linux 两个版本都只生成 AppImage，DEB、RPM 暂不构建。单个任务总超时为 240 分钟，同时为依赖安装、sidecar 冻结、模型验证和 Tauri 打包设置了更短的分阶段超时。首次加入表格模型后的构建会比 0.4.x 更久，后续命中缓存会明显缩短。

4.0 任务运行在 Debian 10 Buster（glibc 2.28）容器内，并使用 `archive.debian.org` 中的归档软件源。任务不调用 `actions/setup-python`，因为后者可能把为较新 glibc 构建的宿主 Python 工具缓存挂载进旧容器，先后造成 `pip ENOENT` 或 `GLIBC_2.34 not found`。兼容任务使用提交哈希固定的 `setup-uv` v10.0.1，下载可移植的 Python 3.11.15，在仓库内创建 `.venv` 后才安装及冻结 sidecar；冻结 sidecar、uv 下载和 PaddleOCR 模型均有独立缓存。setup-uv 从 v8 起不再发布 `@v8`、`@v9` 形式的浮动主版本标签，因此不要把固定哈希改回 `astral-sh/setup-uv@v9`。

兼容任务在上传 Artifact 前会解包 AppImage，确认其中存在可执行的 `ocr-sidecar`，并检查主程序以及其中所有 ELF 动态库声明的 GLIBC 版本；只要缺少 sidecar，或者有文件高于 GLIBC 2.28，构建就会失败并列出具体问题。这用于避免在较新容器、错误缓存或外部二进制配置不一致时生成无法使用的兼容包。目标系统至少需要 glibc 2.28。

WebKitGTK 4.0 兼容版不是在 Tauri 2 配置上替换一个系统包：Tauri 2 的 Linux 后端使用 WebKitGTK 4.1，因此项目在 `compat/webkitgtk-4.0` 中保留了单独的 Tauri 1 壳。前端通过 `src/lib/tauri-bridge.ts` 适配 Tauri 1 全局 API 与 Tauri 2 模块 API，Python sidecar 仍是同一份源码。不要用兼容目录覆盖主 `src-tauri` 目录。

AppImage 仍然受 Linux 内核、glibc、显卡驱动及桌面环境等因素影响，WebKitGTK 4.0 版的目标是覆盖只有 4.0 运行环境的机器，并不等于能在所有旧发行版上运行。建议将 GitHub Actions 生成的兼容版放到目标电脑做一次真实的启动、模型准备、图片识别和 PDF 识别测试。

### Actions 中执行的验证

工作流不仅检查能否编译，还会：

1. 运行 Vue/TypeScript 生产构建；
2. 运行任务恢复、批量控制、逐页校对、sidecar 生命周期、表格滚动与 TSV 输出的界面测试；
3. 运行 Python 单元测试；
4. 执行 `paddle.utils.run_check()`；
5. 使用 PyInstaller 冻结 sidecar；
6. 启动冻结后的 sidecar；
7. 依次下载并载入 PP-OCRv5 轻量和高精度模型，并载入 SLANet_plus 轻量表格流水线；
8. 按文件名加载 Paddle MKL 原生运行库，确认冻结包的动态库搜索路径有效；
9. 生成一张本地表格测试 PNG，让冻结后的 sidecar 用两个文字模型档位及轻量表格模式执行真实 `recognize` 推理；
10. 确认 NDJSON 的 `ping`、`prepare`、`recognize` 和 `shutdown` 均正常返回，并验证识别过程中确实收到逐页 `progress` 事件；
11. 执行 Tauri 安装包构建；
12. Windows 在一次性 runner 中静默安装 NSIS，Linux 在虚拟显示中运行 AppImage，要求实际前端与已打包 sidecar 完成握手并检查 x64 架构；
13. 常规 Linux 任务另外运行 Chromium 布局检查，覆盖 1920×1080、1366×768 以及 100%/125%/150% 缩放的等效视口，检查表格单滚动条与专注模式，并上传截图。低分辨率高缩放允许侧栏滚动，1080p 初始侧栏要求一屏显示。
14. 使用冻结后的 sidecar 导出并导入轻量表格模型包（内含轻量文字模型），在独立进程中进行本地试识别，验证无需下载的准备流程；再检查 PDF 选页的原文页码与逐页进度，以及旋转图片的推理路径。此检查在联网 runner 上运行，使用 Python 网络守卫及显式本地模型路径，不等同于整机断网验收。

布局检查使用模拟的原生接口，不替代真实 WebView/安装包检查；安装包启动检查也不等于全套人工验收。源码交付环境若未安装 Chromium、Windows 或对应 WebKitGTK，相关实机检查必须在 Actions/目标电脑执行。

#### 0.7.5 正式图标

采用灰绿色透明纸张图标，保留浅色折角、文字横线和两枚扫描角。Windows 和两种 Linux 构建共用 `src-tauri/icons` 中的图标；SVG 源图位于 `assets/icon-source.svg`，不依赖字体或嵌入位图。PNG/ICO/ICNS 已随源码提交，Actions 无需另行生成。

后续修改 SVG 后，在项目根目录运行 `npm run icons:generate`（先安装 npm 依赖），统一刷新各尺寸图标。此次不改变 OCR、模型、界面布局或构建工作流；安装包是否正常仍以 Actions 和目标电脑测试为准。

#### 0.7.4 模型管理与状态栏整理

模型管理不再提供“重下”和“修复缺失模型”，统一为删除当前组合缓存后重新准备；不再创建隐藏模型备份。模型名称、状态和占用空间使用固定三列，大小右对齐。Windows 路径优先使用 Cascadia Mono/Consolas，中文回退到微软雅黑等无衬线字体。

自动保存状态移到右上角，并区分读取、已启用、保存中、已保存和失败；左下角只保留识别进程状态，不再重复显示第二个字符圆点。

#### 0.7.3 修复 Windows 源码测试的换行差异

0.7.2 的 Actions 日志中，Windows 在 `Run source checks` 的输出流测试失败：实际为 `Creating model: model-A\r\n`，断言只接受 `\n`。这是测试未考虑 Windows 文本流默认换行转换，不是模型下载或 OCR 运行报错。0.7.3 按平台默认换行验证，并在每个平台显式覆盖 LF、CRLF；仍严格检查输出字节、即时刷新、底层 `.buffer` 和模型进度事件。

同批两个 Linux 任务已通过源码测试，但在 PyInstaller 打包阶段记录 `The operation was canceled`，没有进入冻结包模型测试。日志没有说明取消来源，不能把取消当成打包异常或超时。工作流仍保留 `fail-fast: false`；本次不改依赖、模型缓存、构建超时或 OCR 逻辑。

上传 0.7.3 后，请从新提交运行工作流，并让各平台任务运行至结束。下述首次模型准备问题仍需冻结包测试确认。

#### 0.7.2 起保留的首次模型准备超时排查

0.7.1 的 Windows 日志表明卡在第一个轻量文字 `prepare`，并未进入模型切换。没有线程栈之前，不能把它断定为切换模型或下载超时。0.7.2 将首次依赖导入移回主线程，修正输出流包装器误占用 `.buffer` 属性的问题；这些改动仍需在 Windows 冻结包中验证，单元测试不构成原生问题已解决的证明。

冒烟测试会显示 `import_paddle`、`import_paddleocr`、`imports_ready`、`create_pipeline` 阶段，每 30 秒报告等待状态。仅冒烟脚本为子进程设置 `LOCAL_OCR_CI_PREPARE_TRACE=1`：prepare 超过 60 秒后，Python `faulthandler` 每分钟向 CI stderr 输出一次线程栈，不立即结束程序；单请求 900 秒的最终时限保持不变。若仍失败，请提供第一次 `Timeout (0:01:00)!` 后的线程栈和此前阶段日志，而不只是最后的 TimeoutError。

线程栈功能在普通桌面运行中默认关闭，不写入本机恢复数据库或脱敏诊断包；CI 测试只使用脚本生成的测试图。超时清理包含 PyInstaller 引导程序及其子进程。已有模型缓存不删除，OCR/Paddle 的依赖版本不在此补丁中升级。

本地可选布局测试：

```bash
npm ci
node_modules/.bin/playwright install chromium
npm run test:layout
```

因此第一轮 Actions 如果失败，日志通常能够明确区分是 Paddle/PyInstaller 问题，还是 Tauri 安装包问题。

### PaddleX OCR 冻结说明

PaddleX 会在创建 OCR pipeline 前通过 `importlib.metadata` 检查 `ocr-core`/`ocr` 依赖。仅把 Python 模块交给 PyInstaller 还不够，冻结后的 sidecar 也必须包含这些包的 `.dist-info` 元数据。本项目显式安装 `paddleocr[doc-parser]`，构建脚本会读取 PaddleOCR/PaddleX 的可选依赖声明并复制文字和表格流水线所需的分发元数据；不要删掉这段动态 `--copy-metadata` 处理。

Paddle 的 CPU predictor 还会在运行时按文件名动态载入 MKL。`--collect-all paddle` 会保留 `paddle/libs` 中的原文件，但单文件应用的系统动态库搜索路径只包含解压目录顶层，因此构建脚本还会把 `mklml.dll` 及其 `libiomp5md.dll` 依赖（Windows），或 `libmklml_intel.so`（Linux）加入顶层。Windows 使用 PyInstaller `--hide-console hide-early` 隐藏 sidecar 自己创建的控制台，但仍保留 console bootloader 和标准管道；不要改成 `--noconsole`。烟雾测试使用 UTF-8 原始字节输出 stderr，避免 Windows runner 的 CP1252 控制台掩盖真实错误。

OCR 推理期间会把 PaddleOCR 的普通 stdout 日志重定向到 stderr，但 NDJSON 协议使用启动时单独保存的 stdout 管道；不要把 `emit()` 改回直接写当前 `sys.stdout`，否则 PDF 的逐页进度以及推理期间的暂停、取消响应会被日志重定向吞掉。

当前固定使用 `paddlepaddle==3.2.2`。PaddlePaddle 3.3.x 的 CPU oneDNN/PIR 路径存在已知回归，PP-OCRv5 在第一次实际推理时可能报 `ConvertPirAttribute2RuntimeAttribute`；仅初始化模型无法发现该问题，因此不要在没有完成真实推理烟雾测试的情况下升级 PaddlePaddle。

### 安装后显示“sidecar 尚未启动”

界面会在启动时自动运行随安装包附带的 OCR sidecar。若启动失败，“准备模型”按钮会变为“启动并准备模型”，点击后可重试；窗口底部会保留具体的权限、路径或进程退出错误。Tauri 1 和 Tauri 2 的 sidecar 权限项必须让 `name` 与 `Command.sidecar()`/`externalBin` 的值逐字一致（本项目均为 `binaries/ocr-sidecar`），不要额外添加安装后路径不稳定的 `cmd` 限制。项目测试会自动检查这三处配置，并在兼容 AppImage 打包后检查 sidecar 文件是否确实存在。

## 不启动 GUI，单独测试 sidecar

安装 PaddleOCR 后：

```bash
python sidecar/main.py
```

然后逐行输入：

```json
{"id":"1","method":"ping","params":{}}
{"id":"2","method":"prepare","params":{"profile":"fast","mode":"text"}}
{"id":"3","method":"recognize","params":{"path":"/absolute/path/to/image.png","scoreThreshold":0.5,"mode":"text"}}
{"id":"4","method":"pause","params":{}}
{"id":"5","method":"resume","params":{}}
{"id":"6","method":"cancel","params":{}}
```

运行不需要 PaddleOCR 的结构测试：

```bash
python -m pip install "openpyxl>=3.1,<4" "Pillow>=10,<13" "numpy>=1.24,<3" "pypdfium2>=4,<6"
npm run test:python
```

## 项目结构

```text
src/                         Vue 界面与 sidecar 客户端
src-tauri/                   Tauri 配置、权限和 Rust 壳
compat/webkitgtk-4.0/        Tauri 1 / WebKitGTK 4.0 兼容壳
sidecar/main.py              NDJSON 协议入口
sidecar/engine.py            PaddleOCR 初始化与结果标准化
sidecar/network_guard.py     推理阶段 Python 网络守卫
sidecar/document_input.py    PDF 选页、逐页渲染、EXIF 与图片旋转
sidecar/model_pack.py        离线模型包、独立验证进程、校验和导入回滚
scripts/build-sidecar.py     PyInstaller 与 Tauri target triple 处理
scripts/smoke-sidecar.py     冻结后 sidecar 与模型载入检查
scripts/smoke-model-transfer.py  冻结包模型迁移、PDF 选页和旋转检查
scripts/stage-webkit4-sidecar.py  将同平台 sidecar 放入兼容壳
.github/workflows/           Windows/Linux x64 自动构建
```

## 0.8.x 验收与边界

- 代码检查、单元测试和浏览器布局检查不等于 Windows/WebKitGTK 实机验收。发布前请在无模型缓存、已断网的目标电脑，完整测试安装、导入、文字识别和表格识别。
- 普通识别任务在页间暂停/取消；长 PDF 不预先渲染全部页面。单页内的原生推理无法细粒度暂停。
- 页码与旋转设置随现有会话自动保存。旧会话默认全部页、0 度；未完成任务仍从所选的第一页重新识别，不提供精确断点续算。
- 本轮没有新增快捷键、PDF 预览、原图联动校对、GPU 或 macOS 构建，也没有升级 Paddle/OCR 的固定版本。
