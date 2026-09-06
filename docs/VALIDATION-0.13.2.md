# 0.13.2 验证记录

输入日志：logs_92197955514.zip。Windows 和 WebKitGTK 4.0 均成功上传安装包。普通 Linux 布局断言报告 controlRange=748、bodyRange=748、bodyLeft=733。

根据 15px 差值与样式检查，处理水平工具条上不需要的稳定垂直滚动槽：scrollbar-gutter 从 stable 改为 auto。保留 0.13.1 比例同步，纵向阅读区保持 stable。未改模型和构建依赖。

CI 保留最后一列可达性严格断言，并增加工具条自身末端可达性断言以及 controlLeft/controlGutter 诊断，避免混淆工具条范围与同步问题。

本地前端 87 项测试、Python 项目配置 11 项通过。前端构建通过。当前环境浏览器执行受阻，尚未复现或验证原生浏览器的 15px 问题；必须由下一次 GitHub Actions 布局检查确认，不能以单元测试代替。未执行原生安装包构建。
