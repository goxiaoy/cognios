use std::fs;
use std::path::Path;

pub fn ensure_cache_dir(cache_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|error| error.to_string())
}

pub fn write_html_cache(cache_dir: &Path, node_id: &str, html: &str) -> Result<String, String> {
    ensure_cache_dir(cache_dir)?;
    let path = cache_dir.join(format!("{node_id}.html"));
    fs::write(&path, html).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
