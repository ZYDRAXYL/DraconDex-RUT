// DraconDex-RUT — the Tauri shell.
//
// It owns no app logic. It spawns the Node sidecar (sidecar/server.cjs), which
// runs DraconDex-EXE's real electron/main.js + db layer behind a stubbed
// `electron` module and serves the real renderer on 127.0.0.1. This side does
// what Electron's native layer used to: open/close/track windows, native file
// dialogs, open URLs/paths, move to trash. Protocol: JSON lines; sidecar ->
// here on stdout (prefixed "\x01DDX "), here -> sidecar on stdin.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Sidecar {
    stdin: Mutex<ChildStdin>,
}
impl Sidecar {
    fn send(&self, v: Value) {
        let mut s = self.stdin.lock().unwrap();
        let _ = writeln!(s, "{v}");
        let _ = s.flush();
    }
}

static ORIGIN: OnceLock<(u16, String)> = OnceLock::new(); // (port, token)
static SIDECAR_GONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ponytail: dev layout only — EXE checked out beside this repo, `node` on PATH.
// Bundling Node + the EXE tree as resources is the next step for a shippable build.
fn exe_root() -> PathBuf {
    std::env::var_os("DRACONDEX_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../DraconDex-EXE"))
}
fn sidecar_script() -> PathBuf {
    std::env::var_os("DRACONDEX_SIDECAR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/server.cjs"))
}

fn win_id(label: &str) -> Option<u64> {
    label.strip_prefix('w')?.parse().ok()
}

fn push_state(app: &AppHandle, label: &str) {
    let (Some(id), Some(w)) = (win_id(label), app.get_webview_window(label)) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    app.state::<Arc<Sidecar>>().send(json!({
        "t": "state", "id": id,
        "bounds": { "x": pos.x, "y": pos.y, "width": size.width, "height": size.height },
        "maximized": w.is_maximized().unwrap_or(false),
        "minimized": w.is_minimized().unwrap_or(false),
    }));
}

fn open_window(app: &AppHandle, m: &Value) -> tauri::Result<()> {
    let (port, token) = ORIGIN.get().expect("sidecar ready");
    let id = m["id"].as_u64().unwrap_or(0);
    let query = m["query"].as_str().unwrap_or("");
    let index = format!("http://127.0.0.1:{port}/electron/index.html");
    let url = if query.is_empty() { index.clone() } else { format!("{index}?{query}") };
    let f = |k: &str| m[k].as_f64();
    let mut b = WebviewWindowBuilder::new(app, format!("w{id}"), WebviewUrl::External(url.parse().unwrap()))
        .title("DraconDex")
        .inner_size(f("width").unwrap_or(1280.0), f("height").unwrap_or(800.0))
        .decorations(m["frame"].as_bool().unwrap_or(false))
        // The token reaches the page only through here, never over HTTP.
        .initialization_script(&format!("window.__DDX={{token:{},win:{id}}};", json!(token)))
        // Same rule as main.js's will-navigate guard: stay on the app's own document.
        .on_navigation(move |u| u.as_str().split(['?', '#']).next() == Some(index.as_str()));
    if let (Some(w), Some(h)) = (f("minWidth"), f("minHeight")) {
        b = b.min_inner_size(w, h);
    }
    if let (Some(x), Some(y)) = (f("x"), f("y")) {
        b = b.position(x, y);
    } else {
        b = b.center();
    }
    if let Some(parent) = m["parent"].as_u64().and_then(|p| app.get_webview_window(&format!("w{p}"))) {
        b = b.parent(&parent)?;
    }
    b.build()?;
    Ok(())
}

fn dialog(app: &AppHandle, save: bool, o: &Value) -> Result<Value, String> {
    let mut d = app.dialog().file();
    if let Some(t) = o["title"].as_str() {
        d = d.set_title(t);
    }
    for f in o["filters"].as_array().into_iter().flatten() {
        let exts: Vec<&str> = f["extensions"].as_array().into_iter().flatten().filter_map(|e| e.as_str()).collect();
        d = d.add_filter(f["name"].as_str().unwrap_or(""), &exts);
    }
    if let Some(p) = o["defaultPath"].as_str().map(PathBuf::from) {
        if p.is_dir() {
            d = d.set_directory(&p);
        } else {
            if let Some(dir) = p.parent().filter(|d| d.is_dir()) {
                d = d.set_directory(dir);
            }
            if let Some(name) = p.file_name() {
                d = d.set_file_name(name.to_string_lossy());
            }
        }
    }
    let props: Vec<&str> = o["properties"].as_array().into_iter().flatten().filter_map(|p| p.as_str()).collect();
    let to_s = |p: tauri_plugin_dialog::FilePath| p.into_path().ok().map(|p| p.to_string_lossy().into_owned());
    if save {
        let picked = d.blocking_save_file().and_then(to_s);
        return Ok(json!({ "canceled": picked.is_none(), "filePath": picked }));
    }
    if props.contains(&"createDirectory") {
        d = d.set_can_create_directories(true);
    }
    let multi = props.contains(&"multiSelections");
    let picked: Vec<String> = match (props.contains(&"openDirectory"), multi) {
        (true, true) => d.blocking_pick_folders().unwrap_or_default().into_iter().filter_map(to_s).collect(),
        (true, false) => d.blocking_pick_folder().and_then(to_s).into_iter().collect(),
        (false, true) => d.blocking_pick_files().unwrap_or_default().into_iter().filter_map(to_s).collect(),
        (false, false) => d.blocking_pick_file().and_then(to_s).into_iter().collect(),
    };
    Ok(json!({ "canceled": picked.is_empty(), "filePaths": picked }))
}

fn handle_call(app: &AppHandle, op: &str, a: &Value) -> Result<Value, String> {
    let win = || {
        a["id"].as_u64().and_then(|id| app.get_webview_window(&format!("w{id}"))).ok_or("no such window")
    };
    let e = |r: Result<(), tauri::Error>| r.map(|_| Value::Null).map_err(|e| e.to_string());
    let path = || a["path"].as_str().unwrap_or("").to_string();
    match op {
        "win.close" => e(win()?.close()),
        "win.show" => e(win()?.show()),
        "win.focus" => e(win()?.set_focus()),
        "win.minimize" => e(win()?.minimize()),
        "win.unminimize" => e(win()?.unminimize()),
        "win.maximize" => e(win()?.maximize()),
        "win.unmaximize" => e(win()?.unmaximize()),
        "dialog.open" => dialog(app, false, a),
        "dialog.save" => dialog(app, true, a),
        "shell.openExternal" => {
            let url = a["url"].as_str().unwrap_or("");
            match url::Url::parse(url).map(|u| u.scheme().to_string()).as_deref() {
                Ok("http" | "https" | "mailto") => app.opener().open_url(url, None::<&str>).map(|_| Value::Null).map_err(|e| e.to_string()),
                _ => Err(format!("refused to open {url}")),
            }
        }
        "shell.openPath" => app.opener().open_path(path(), None::<&str>).map(|_| Value::Null).map_err(|e| e.to_string()),
        "shell.showItemInFolder" => app.opener().reveal_item_in_dir(path()).map(|_| Value::Null).map_err(|e| e.to_string()),
        "shell.trashItem" => trash::delete(path()).map(|_| Value::Null).map_err(|e| e.to_string()),
        _ => Err(format!("unknown op {op}")),
    }
}

fn on_sidecar_line(app: &AppHandle, m: Value) {
    let side = app.state::<Arc<Sidecar>>().inner().clone();
    match m["t"].as_str() {
        Some("ready") => {
            let port = m["port"].as_u64().unwrap_or(0) as u16;
            let _ = ORIGIN.set((port, m["token"].as_str().unwrap_or("").to_string()));
            let wa = app.primary_monitor().ok().flatten().map(|mon| {
                let s = mon.scale_factor();
                let (p, z) = (mon.position().to_logical::<f64>(s), mon.size().to_logical::<f64>(s));
                json!({ "x": p.x, "y": p.y, "width": z.width, "height": z.height })
            });
            side.send(json!({ "t": "start", "workArea": wa }));
        }
        Some("open") => {
            let (app2, m2) = (app.clone(), m.clone());
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = open_window(&app2, &m2) {
                    eprintln!("[rut] open window failed: {e}");
                    app2.state::<Arc<Sidecar>>().send(json!({ "t": "closed", "id": m2["id"] }));
                }
            });
        }
        Some("call") => {
            let app2 = app.clone();
            // Own thread: native dialogs block until the user answers.
            std::thread::spawn(move || {
                let r = handle_call(&app2, m["op"].as_str().unwrap_or(""), &m["args"]);
                let reply = match r {
                    Ok(v) => json!({ "t": "reply", "rpc": m["rpc"], "ok": true, "value": v }),
                    Err(e) => json!({ "t": "reply", "rpc": m["rpc"], "ok": false, "error": e }),
                };
                side.send(reply);
            });
        }
        _ => {} // "quit": the process exit that follows ends the app
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(s) = app.try_state::<Arc<Sidecar>>() {
                s.send(json!({ "t": "second-instance", "argv": argv, "cwd": cwd }));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?.join("novel-manager-data");
            std::fs::create_dir_all(&data)?;
            let node = std::env::var("DRACONDEX_NODE").unwrap_or_else(|_| "node".into());
            let mut child = Command::new(node)
                .arg(sidecar_script())
                .arg(exe_root())
                .env("DRACONDEX_DATA_DIR", &data)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("could not start the Node sidecar (is Node.js on PATH, or DRACONDEX_NODE set?): {e}"))?;
            app.manage(Arc::new(Sidecar { stdin: Mutex::new(child.stdin.take().unwrap()) }));
            let stdout = child.stdout.take().unwrap();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    match line.strip_prefix("\x01DDX ") {
                        Some(j) => match serde_json::from_str(j) {
                            Ok(m) => on_sidecar_line(&handle, m),
                            Err(e) => eprintln!("[rut] bad sidecar message: {e}"),
                        },
                        None => println!("{line}"),
                    }
                }
                let _ = child.wait();
                SIDECAR_GONE.store(true, std::sync::atomic::Ordering::SeqCst);
                handle.exit(0);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let label = window.label();
            match event {
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => push_state(app, label),
                WindowEvent::Focused(true) => {
                    if let Some(id) = win_id(label) {
                        app.state::<Arc<Sidecar>>().send(json!({ "t": "focus", "id": id }));
                    }
                }
                WindowEvent::Destroyed => {
                    if let Some(id) = win_id(label) {
                        app.state::<Arc<Sidecar>>().send(json!({ "t": "closed", "id": id }));
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DraconDex")
        .run(|_app, event| {
            // The sidecar decides when the app quits (main.js's window-all-closed
            // -> app.quit(), after its will-quit work) — not the last window closing.
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                if !SIDECAR_GONE.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
