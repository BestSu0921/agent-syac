#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// agent-sync 桌面壳：真实窗口 + 托盘 + 单实例。
// 职责只有三件事：拉起 node sidecar（面板服务）、就绪后开窗口、退出时回收子进程。
// 面板/引擎逻辑全在 server.mjs / sync.mjs（http://127.0.0.1:7717），本壳不含业务。

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

const PANEL_URL: &str = "http://127.0.0.1:7717";

struct ServerChild(Mutex<Option<Child>>);

fn show_panel(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("panel") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn server_ready() -> bool {
    TcpStream::connect(("127.0.0.1", 7717)).is_ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：聚焦已有窗口（单实例语义）
            show_panel(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 服务脚本解析：exe 同级有 server.mjs（绿色单文件形态，agent-sync 根目录）则直接用根目录的真实文件，
            // 否则回退打包资源目录（安装形态）。
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."));
            let resource_dir = handle.path().resource_dir()?;
            // Windows 下 resource_dir 带 \\?\ 前缀，node 解析该形式的主脚本路径会 EISDIR，剥掉
            let resource_dir = PathBuf::from(resource_dir.to_string_lossy().replace(r"\\?\", ""));
            let (home, server_script) = if exe_dir.join("server.mjs").is_file() {
                (exe_dir.clone(), exe_dir.join("server.mjs"))
            } else {
                let r = resource_dir.join("resources");
                (r.clone(), r.join("server.mjs"))
            };
            println!("[tauri] AGENT_SYNC_HOME = {}", home.display());
            println!("[tauri] server 脚本 = {}", server_script.display());

            use std::os::windows::process::CommandExt;
            let mut child = std::process::Command::new("node")
                .arg(&server_script)
                .env("AGENT_SYNC_HOME", &home)
                .env("AGENT_SYNC_AUTOOPEN", "0")
                .env("AGENT_SYNC_TAURI", "1")
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()?;
            println!("[tauri] node sidecar 已启动 pid={}", child.id());
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            app.manage(ServerChild(Mutex::new(Some(child))));

            // 转发服务日志到本壳控制台
            if let Some(out) = stdout {
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        println!("[server] {}", line);
                    }
                });
            }
            if let Some(err) = stderr {
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(err).lines().map_while(Result::ok) {
                        println!("[server-err] {}", line);
                    }
                });
            }

            // 等服务就绪（最多 20s）再开面板窗口
            let thread_handle = handle.clone();
            std::thread::spawn(move || {
                for _ in 0..80 {
                    if server_ready() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                let url: tauri::Url = PANEL_URL.parse().expect("invalid panel url");
                let _ = tauri::WebviewWindowBuilder::new(&thread_handle, "panel", tauri::WebviewUrl::External(url))
                    .title("agent-sync")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(980.0, 640.0)
                    .build();
            });

            // 托盘：左键开面板；菜单：打开面板 / 退出
            let open_item = tauri::menu::MenuItem::with_id(&handle, "open", "打开面板", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(&handle, &[&open_item, &quit_item])?;
            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("agent-sync")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_panel(tray.app_handle());
                    }
                })
                .build(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 缩到托盘（真正退出走托盘菜单，sidecar 在 Exit 时回收）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building agent-sync")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, .. } = event {
                if code.is_none() {
                    if let Some(state) = app.try_state::<ServerChild>() {
                        if let Some(mut child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
