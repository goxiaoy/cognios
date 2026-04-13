#[derive(Clone, Debug)]
pub struct PipelineOutput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub preview_text: String,
    pub canonical_url: Option<String>,
    pub html: String,
}
