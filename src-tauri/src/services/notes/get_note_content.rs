use std::path::Path;

pub fn get_note_content(note_id: &str, notes_dir: &Path) -> Result<String, String> {
    let note_path = notes_dir.join(format!("{note_id}.md"));
    if !note_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&note_path).map_err(|error| error.to_string())
}
