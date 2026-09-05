# 0.10.0 验证记录

本地验证完成：

- Python 单元测试：93 项通过。
- 前端逻辑及 Vue 交互测试：51 项通过。
- TypeScript/vue-tsc 类型检查通过。
- 标准 Vite 生产构建通过。
- WebKitGTK 4.0 / Safari 13 目标 Vite 构建通过。
- Python 源码 compileall 通过。
- 实际 PDFium 文字型 PDF 测试证明文本页不调用 render；混合文件仅扫描页调用模拟 OCR，并验证原文页码、断点与文件句柄关闭。
- 注音预处理以用户提供的竖排样图进行了候选框检查；样图不包含在公开源码包中。本项只验证候选区域，不代表已完成真实 Paddle 注音识别准确率测试。

本地未完成：

- Chromium 布局截图测试：当前环境未装对应浏览器，下载超时；没有以旧截图冒充新版本验证。
- 完整 Paddle 模型、冻结 sidecar 和安装后的桌面程序：当前环境无完整 Paddle 运行环境。
- Windows NSIS、常规 Linux AppImage、WebKitGTK 4.0 / glibc 2.28 AppImage：须上传源码后运行 Actions，再在目标电脑验收。

Actions 保留现有真实模型、离线迁移、三平台安装包启动和 Linux 布局检查；冻结 sidecar 冒烟新增长文本层提取、混合页面及注音开启分支。请特别以横排/竖排日文实际书页检查 Ruby 的漏检与字词错配，勿将流程测试等同于准确率保证。
