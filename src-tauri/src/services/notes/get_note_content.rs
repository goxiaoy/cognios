use std::path::Path;

pub fn get_note_content(note_id: &str, notes_dir: &Path) -> Result<String, String> {
    let note_path = notes_dir.join(format!("{note_id}.md"));
    match std::fs::read_to_string(&note_path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}
