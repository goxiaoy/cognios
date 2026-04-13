use crate::services::url_indexing::pipeline::PipelineOutput;
use crate::services::url_indexing::pipelines::default_web::fetch_default_web;

pub fn run_pipeline(url: &str) -> Result<PipelineOutput, String> {
    fetch_default_web(url)
}
