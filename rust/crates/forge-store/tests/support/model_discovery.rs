use async_trait::async_trait;
use forge_core::agents::providers::{self as p, Code, Discovery, DiscoveryInput, Error, Model};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
pub struct Provider {
    pub models: Mutex<Vec<Model>>,
    pub fail: AtomicBool,
    pub pause: AtomicBool,
    pub calls: AtomicUsize,
    pub entered: tokio::sync::Notify,
    pub resume: tokio::sync::Notify,
}
impl Default for Provider {
    fn default() -> Self {
        Self {
            models: Mutex::new(p::normalize(
                "openai",
                Some(&serde_json::json!({"data":[{"id":"gpt-5"}]})),
                &[],
            )),
            fail: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            entered: Default::default(),
            resume: Default::default(),
        }
    }
}
#[async_trait]
impl Discovery for Provider {
    async fn validate_endpoint(&self, value: &str) -> Result<String, Error> {
        Ok(p::endpoint(value)?.to_string())
    }
    async fn discover(&self, _: &DiscoveryInput) -> Result<Vec<Model>, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let fail = self.fail.load(Ordering::SeqCst);
        let result = self.models.lock().unwrap().clone();
        if self.pause.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        if fail {
            Err(Error::new(
                Code::DiscoveryFailed,
                "Private fixture diagnostic",
            ))
        } else {
            Ok(result)
        }
    }
}
