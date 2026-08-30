# Local OCR

一个以隐私为优先的跨平台 OCR 桌面程序原型：Vue 3/TypeScript 图形界面，Python + PaddleOCR sidecar。Windows 和常规 Linux 版本使用 Tauri 2；另提供 Tauri 1 / WebKitGTK 4.0 的 Linux x64 兼容 AppImage。

## 当前功能

当前版本为 **0.7.1：可靠性与发布准备版**。没有新增快捷键；仅保留原有的专注模式 `Esc` 退出操作。

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
- 前后缀支持 `{date}`、`{profile}`、`{mode}`，非法文件名字符会被替换。默认自动编号不覆盖；选择覆盖时会再次确认数量和文件名。表格缺失的任务不会生成空 XLSX/HTML。
- XLSX 中的 OCR 文字按纯字符串写入，即使以 `=` 开头也不会作为公式执行。HTML 仍使用转义后的静态表格。

**模型与诊断**

- 模型准备在后台线程执行，界面可查询各模型已落盘字节数和必要文件状态，并显示当前下载/载入的模型名。下载源没有提供可靠总量时使用不定进度，不虚构百分比或总大小。
- Windows 切换轻量、高精度或表格流水线时会先重启 sidecar，再载入新模型，避免多个 Paddle 原生 predictor 在同一进程内连续销毁和重建后卡住。
- 必要文件齐全不等于校验和验证；模型能否实际载入仍由准备操作判断。可修复缺失/不完整模型，也可单独重新下载某个模型。旧缓存移动至 `~/.paddlex/official_models/.local-ocr-backups/`，不会直接删除；备份占用空间需要用户自行清理。
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
git tag v0.7.1
git push origin v0.7.1
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

布局检查使用模拟的原生接口，不替代真实 WebView/安装包检查；安装包启动检查也不等于全套人工验收。源码交付环境若未安装 Chromium、Windows 或对应 WebKitGTK，相关实机检查必须在 Actions/目标电脑执行。

本地可选布局测试：

```bash
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
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
scripts/build-sidecar.py     PyInstaller 与 Tauri target triple 处理
scripts/smoke-sidecar.py     冻结后 sidecar 与模型载入检查
scripts/stage-webkit4-sidecar.py  将同平台 sidecar 放入兼容壳
.github/workflows/           Windows/Linux x64 自动构建
```

## 下一阶段建议

1. 为表格单元格增加点击校对和原图区域联动；
2. 增加跨页表格的手动合并/拆分，并提供更高精度的表格模型档位；
3. 在图片上叠加 `polygon` 文本框并联动文字块；
4. 增加 JSON、Markdown 导出和关闭程序后的队列恢复；
5. 将模型下载器拆成独立、可联网的 sidecar；
6. 增加自定义模型目录与模型版本清单；
7. 在现有 Windows/Linux 流水线上增加 GitHub Release 发布，并另行验证 macOS arm64；
8. 分开提供 CPU 版与 NVIDIA GPU 版。
