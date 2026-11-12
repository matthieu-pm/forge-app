//! A tick completes queue maintenance before claiming work, and awaits each
//! durable execution result. The setup deadline does not extend a run deadline.
use super::*;

#[derive(Clone, Copy, Debug)]
pub struct DispatchOptions<'a> {
    pub limit: usize,
    pub workspace: Option<&'a str>,
    pub now: Option<DateTime<Utc>>,
    pub enqueue_only: bool,
    pub execution_start_before: Option<i64>,
}
impl Default for DispatchOptions<'_> {
    fn default() -> Self {
        Self {
            limit: 10,
            workspace: None,
            now: None,
            enqueue_only: false,
            execution_start_before: None,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct DispatchReport {
    pub enabled: bool,
    pub events: usize,
    pub scheduled: usize,
    pub executed: usize,
}
impl Service {
    pub async fn dispatch(
        &self,
        options: DispatchOptions<'_>,
    ) -> Result<DispatchReport, StoreError> {
        self.dispatch_using(options, None).await
    }
    pub async fn dispatch_with(
        &self,
        options: DispatchOptions<'_>,
        executor: &dyn Executor,
    ) -> Result<DispatchReport, StoreError> {
        self.dispatch_using(options, Some(executor)).await
    }
    async fn dispatch_using(
        &self,
        options: DispatchOptions<'_>,
        executor: Option<&dyn Executor>,
    ) -> Result<DispatchReport, StoreError> {
        if !self.options.enabled {
            return Ok(DispatchReport::default());
        }
        let limit = options.limit.clamp(1, 100);
        let now = options.now.unwrap_or_else(|| self.time());
        self.expire_runs(now, options.workspace).await?;
        let events = self.enqueue_native(limit * 10, options.workspace).await?;
        let scheduled = self.enqueue_scheduled(now, options.workspace).await?;
        let mut report = DispatchReport {
            enabled: true,
            events,
            scheduled,
            executed: 0,
        };
        for _ in 0..if options.enqueue_only { 0 } else { limit } {
            if options
                .execution_start_before
                .is_some_and(|end| self.time().timestamp_millis() >= end)
            {
                break;
            }
            let run = match executor {
                Some(executor) => self.execute_next_with(executor, options.workspace).await?,
                None => self.execute_next(options.workspace).await?,
            };
            if run.is_none() {
                break;
            }
            report.executed += 1;
        }
        Ok(report)
    }
}
