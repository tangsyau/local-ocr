# Local OCR

一个以隐私为优先的跨平台 OCR 桌面程序原型：Tauri 2 + Vue 3/TypeScript 图形界面，Python + PaddleOCR sidecar。当前 GitHub Actions 自动构建目标为 Windows x64 和 Linux x64。

## 当前功能

- 批量选择 PNG、JPEG、WebP、BMP、TIFF 或 PDF，并按队列顺序识别；
- 在 PP-OCRv5 轻量与高精度检测/识别模型之间切换，模型按需联网下载；
- 模型常驻 Python sidecar，同一档位的连续任务不重复初始化；
- 支持在当前页结束后暂停、继续或取消队列，并提供无响应时强制停止；
- PDF 在识别前读取总页数，任务列表显示当前页、总页数和百分比；
- 识别阶段临时阻断 Python socket 连接；
- 逐页返回文字、置信度、文本框坐标和纯文本；
- 每个文件独立保留结果，可校对、复制并批量导出同名 TXT；
- Windows 发布版将 Tauri 主程序设为 GUI 子系统，并隐藏 sidecar 控制台，同时保留管道通信；
- Windows 和 Linux 启动时默认最大化；较小屏幕仍可滚动和手动调整窗口；
- NDJSON 标准输入/输出通信，不启动本地 HTTP 端口。

当前结果类型预留了 `text`、`table` 和 `document`，但 0.3.1 只实现普通文字 OCR；图片表格不会恢复为行列和合并单元格结构。

## 隐私边界

`prepare` 阶段允许 PaddleOCR 下载所选档位的官方模型。`recognize` 阶段只向 sidecar 传递本地路径，并使用 `block_python_network()` 阻止 Python 网络连接。暂停期间仍处于同一次本地识别任务中。项目不包含文档上传、云端 OCR、遥测或崩溃报告代码。

这个 Python 网络守卫不是操作系统级沙箱。若用于需要形式化合规保证的环境，下一步应把模型下载器拆为独立进程，并在操作系统层限制 OCR worker 的网络权限。

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

仓库已经包含 `.github/workflows/build-desktop.yml`，使用 GitHub 托管的原生 x64 runner 分别构建：

- Windows x64：NSIS EXE；
- Linux x64：AppImage。

### 第一次运行

1. 在 GitHub 新建一个空仓库；
2. 把本项目的全部文件上传到仓库根目录，确保 `.github` 隐藏目录也已上传；
3. 打开仓库的 **Actions** 页面；
4. 选择 **Build Windows and Linux x64**；
5. 点击 **Run workflow**；
6. 两个任务完成后，在该次运行页面底部下载 `local-ocr-windows-x64` 和 `local-ocr-linux-x64`。

工作流也会在推送 `v*` 标签时自动运行，例如：

```bash
git tag v0.3.1
git push origin v0.3.1
```

构建产物作为 Actions Artifact 保存 14 天。当前产物没有代码签名，因此 Windows 首次运行可能显示 SmartScreen 警告。正式公开发布前还应修改 `src-tauri/tauri.conf.json` 中的 `com.example.localocr` 标识，并配置 Windows 代码签名。

工作流对冻结后的 sidecar 和 PP-OCRv5 轻量/高精度模型分别使用内容寻址缓存：源码和依赖未变化时会跳过 PaddleOCR/PyInstaller 的重复安装与冻结。当前最小发布组合为 Windows NSIS EXE 和 Linux AppImage；DEB、RPM 暂不构建。单个平台总超时为 240 分钟，同时为依赖安装、sidecar 冻结、两档模型验证和 Tauri 打包设置了更短的分阶段超时。

### Actions 中执行的验证

工作流不仅检查能否编译，还会：

1. 运行 Vue/TypeScript 生产构建；
2. 运行 Python 单元测试；
3. 执行 `paddle.utils.run_check()`；
4. 使用 PyInstaller 冻结 sidecar；
5. 启动冻结后的 sidecar；
6. 依次下载并载入 PP-OCRv5 轻量和高精度模型；
7. 按文件名加载 Paddle MKL 原生运行库，确认冻结包的动态库搜索路径有效；
8. 生成一张本地测试 PNG，并让冻结后的 sidecar 用两个模型档位各执行一次 `recognize` 推理；
9. 确认 NDJSON 的 `ping`、`prepare`、`recognize` 和 `shutdown` 均正常返回；
10. 最后才执行 Tauri 安装包构建。

因此第一轮 Actions 如果失败，日志通常能够明确区分是 Paddle/PyInstaller 问题，还是 Tauri 安装包问题。

### PaddleX OCR 冻结说明

PaddleX 会在创建 OCR pipeline 前通过 `importlib.metadata` 检查 `ocr-core` 依赖。仅把 Python 模块交给 PyInstaller 还不够，冻结后的 sidecar 也必须包含这些包的 `.dist-info` 元数据。本项目已显式锁定 `paddlex[ocr-core]`，并由 `scripts/build-sidecar.py` 复制 PaddleX、OpenCV、PyPDFium2、Shapely 等 OCR 依赖的分发元数据；不要删掉这些 `--copy-metadata` 参数。

Paddle 的 CPU predictor 还会在运行时按文件名动态载入 MKL。`--collect-all paddle` 会保留 `paddle/libs` 中的原文件，但单文件应用的系统动态库搜索路径只包含解压目录顶层，因此构建脚本还会把 `mklml.dll` 及其 `libiomp5md.dll` 依赖（Windows），或 `libmklml_intel.so`（Linux）加入顶层。Windows 使用 PyInstaller `--hide-console hide-early` 隐藏 sidecar 自己创建的控制台，但仍保留 console bootloader 和标准管道；不要改成 `--noconsole`。烟雾测试使用 UTF-8 原始字节输出 stderr，避免 Windows runner 的 CP1252 控制台掩盖真实错误。

当前固定使用 `paddlepaddle==3.2.2`。PaddlePaddle 3.3.x 的 CPU oneDNN/PIR 路径存在已知回归，PP-OCRv5 在第一次实际推理时可能报 `ConvertPirAttribute2RuntimeAttribute`；仅初始化模型无法发现该问题，因此不要在没有完成真实推理烟雾测试的情况下升级 PaddlePaddle。

### 安装后显示“sidecar 尚未启动”

界面会在启动时自动运行随安装包附带的 OCR sidecar。若启动失败，“准备模型”按钮会变为“启动并准备模型”，点击后可重试；窗口底部会保留具体的权限、路径或进程退出错误。Tauri 的 sidecar 权限项必须让 `name` 与 `Command.sidecar()`/`externalBin` 的值逐字一致（本项目均为 `binaries/ocr-sidecar`），不要额外添加安装后路径不稳定的 `cmd` 限制。项目测试会自动检查这三处配置。

## 不启动 GUI，单独测试 sidecar

安装 PaddleOCR 后：

```bash
python sidecar/main.py
```

然后逐行输入：

```json
{"id":"1","method":"ping","params":{}}
{"id":"2","method":"prepare","params":{"profile":"fast"}}
{"id":"3","method":"recognize","params":{"path":"/absolute/path/to/image.png","scoreThreshold":0.5}}
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
sidecar/main.py              NDJSON 协议入口
sidecar/engine.py            PaddleOCR 初始化与结果标准化
sidecar/network_guard.py     推理阶段 Python 网络守卫
scripts/build-sidecar.py     PyInstaller 与 Tauri target triple 处理
scripts/smoke-sidecar.py     冻结后 sidecar 与模型载入检查
.github/workflows/           Windows/Linux x64 自动构建
```

## 下一阶段建议

1. 增加实验性表格识别结果和 HTML/XLSX 导出；
2. 在图片上叠加 `polygon` 文本框并联动文字块；
3. 增加 JSON、Markdown 导出和关闭程序后的队列恢复；
4. 将模型下载器拆成独立、可联网的 sidecar；
5. 增加自定义模型目录与模型版本清单；
6. 在现有 Windows/Linux 流水线上增加 GitHub Release 发布，并另行验证 macOS arm64；
7. 分开提供 CPU 版与 NVIDIA GPU 版。
