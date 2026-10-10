' agent-sync 隐藏启动器：面板服务后台常驻，不显示控制台黑窗
' 由开始菜单快捷方式调用（wscript.exe 本文件）
CreateObject("WScript.Shell").Run """D:\ai-agent-backup\build\agent-sync.exe""", 0, False
