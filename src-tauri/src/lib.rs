mod commands;
mod db;
mod services;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let conn = db::init_db(&app_data_dir).expect("failed to initialize database");
            app.manage(db::DbConnection::new(conn));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health::db_health_check,
            commands::tasks::create_task,
            commands::tasks::get_task,
            commands::tasks::update_task,
            commands::tasks::delete_task,
            commands::tasks::list_tasks,
            commands::tasks::ensure_recurring_tasks,
            commands::task_categories::list_task_categories,
            commands::task_categories::get_task_category,
            commands::task_categories::create_task_category,
            commands::task_categories::update_task_category,
            commands::task_categories::delete_task_category,
            commands::task_recurrence::list_task_recurrences,
            commands::task_recurrence::get_task_recurrence,
            commands::task_recurrence::delete_task_recurrence,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
