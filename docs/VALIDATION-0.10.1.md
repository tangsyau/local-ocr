# 0.10.1 验证记录

本地验证完成：

- Python 单元测试：93 项通过。
- 前端逻辑及 Vue 交互测试：52 项通过。
- TypeScript/vue-tsc 类型检查通过。
- 标准 Vite 生产构建通过。
- WebKitGTK 4.0 / Safari 13 目标 Vite 构建通过。
- 文档设置组件测试确认默认展开、五个设置项完整显示，三个下拉菜单采用统一结构。

本地未完成：

- Chromium 布局截图测试：当前环境未安装 Playwright 对应的 Chromium；脚本已新增默认展开、下拉框等高和同行卡片等高断言，由 GitHub Actions 执行。
- 完整 Paddle 模型、冻结 sidecar 和安装后的桌面程序：当前环境无完整 Paddle 运行环境。
- Windows NSIS、常规 Linux AppImage、WebKitGTK 4.0 / glibc 2.28 AppImage：须上传源码后运行 Actions，再在目标电脑验收。

本版只调整文档设置的显示和排列；OCR、文本整理、注音数据、模型及离线包格式保持不变。
