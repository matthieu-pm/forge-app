use async_trait::async_trait;
use forge_core::{agents::files::Blobs, files::UploadError};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[derive(Default)]
pub struct Memory {
    pub values: Mutex<HashMap<String, Vec<u8>>>,
    pub fail_put: AtomicBool,
    pub fail_delete: AtomicBool,
    pub pause_put: AtomicBool,
    pub pause_get: AtomicBool,
    pub deleted: AtomicUsize,
    pub entered: tokio::sync::Notify,
    pub resume: tokio::sync::Notify,
}
#[async_trait]
impl Blobs for Memory {
    async fn put(&self, reference: &str, bytes: Vec<u8>) -> Result<(), UploadError> {
        if self.fail_put.load(Ordering::SeqCst) {
            return Err(UploadError::Transport);
        }
        {
            let mut values = self.values.lock().unwrap();
            if values.contains_key(reference) {
                return Err(UploadError::Transport);
            }
            values.insert(reference.into(), bytes);
        }
        if self.pause_put.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        Ok(())
    }
    async fn get(&self, reference: &str, max: usize) -> Result<Option<Vec<u8>>, UploadError> {
        let bytes = self.values.lock().unwrap().get(reference).cloned();
        if bytes.as_ref().is_some_and(|b| b.len() > max) {
            return Err(UploadError::Transport);
        }
        if self.pause_get.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        Ok(bytes)
    }
    async fn delete(&self, reference: &str) -> Result<(), UploadError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(UploadError::Transport);
        }
        self.deleted.fetch_add(1, Ordering::SeqCst);
        self.values.lock().unwrap().remove(reference);
        Ok(())
    }
}
