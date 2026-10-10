' agent-sync 启动器（node 版，隐藏黑窗）：面板服务后台常驻并自动弹出 Edge 应用窗口
CreateObject("WScript.Shell").Run "node D:\ai-agent-backup\server.mjs --open", 0, False
