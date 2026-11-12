//! Only the claimed-loop worker can construct a coordinator with shared-run
//! authority. Binding one occurrence never opens personal/local conversations.
use super::*;

#[derive(Clone)]
pub(crate) struct LoopBinding {
    pub workspace_id: String,
    pub loop_id: Uuid,
    pub run_id: Uuid,
    pub thread_id: Uuid,
    pub agent_run_id: Uuid,
    pub deadline_ms: i64,
}
impl Service {
    pub(crate) fn for_loop(&self, mut binding: LoopBinding) -> Self {
        let mut service = self.clone();
        let maximum = service.controls["runWallClockMs"]
            .as_i64()
            .unwrap_or(900_000)
            .clamp(1, 900_000);
        binding.deadline_ms = binding
            .deadline_ms
            .min(service.time().timestamp_millis().saturating_add(maximum));
        let remaining = binding
            .deadline_ms
            .saturating_sub(service.time().timestamp_millis())
            .max(1);
        service.controls["runWallClockMs"] = json!(
            maximum
                .min(forge_core::loops::RUN_WALL_CLOCK_MS)
                .min(remaining)
        );
        service.controls["userMonthlyBudgetMicros"] = Value::Null;
        service.loop_binding = Some(binding);
        service
    }
    pub(super) fn bound_loop(&self, actor: &Actor) -> bool {
        let (Some(binding), Some(scope)) = (&self.loop_binding, &actor.loop_scope) else {
            return false;
        };
        matches!(&actor.authentication,Authentication::Loop{loop_id,run_id}if loop_id==&binding.loop_id.to_string() && run_id==&binding.run_id.to_string())
            && actor.workspace_id == binding.workspace_id
            && actor.user_id == forge_core::loops::principal_id(&binding.loop_id.to_string())
            && scope.loop_id == binding.loop_id.to_string()
            && scope.run_id == binding.run_id.to_string()
    }
    pub(super) fn bound_loop_thread(&self, actor: &Actor, id: Uuid) -> bool {
        self.bound_loop(actor)
            && self
                .loop_binding
                .as_ref()
                .is_some_and(|b| b.thread_id == id)
    }
    pub(super) fn bound_loop_run(&self, actor: &Actor, run: &Run) -> bool {
        self.bound_loop_thread(actor, run.thread_id)
            && self.loop_binding.as_ref().is_some_and(|b| {
                b.agent_run_id == run.id
                    && run.requested_selection["loopRunId"] == b.run_id.to_string()
            })
    }
    pub(super) fn run_deadline(&self, run: &Run) -> i64 {
        let ordinary = run
            .started_at
            .unwrap_or_else(|| self.time())
            .timestamp_millis()
            .saturating_add(
                self.controls["runWallClockMs"]
                    .as_i64()
                    .unwrap_or(900_000)
                    .clamp(1, 900_000),
            );
        self.loop_binding
            .as_ref()
            .map_or(ordinary, |b| b.deadline_ms)
    }
    pub(super) fn stream_window(&self, run: &Run) -> u64 {
        let configured = self.controls["runWallClockMs"]
            .as_u64()
            .unwrap_or(900_000)
            .min(900_000);
        if self.loop_binding.is_some() {
            configured.min(
                self.run_deadline(run)
                    .saturating_sub(self.time().timestamp_millis())
                    .max(0) as u64,
            )
        } else {
            configured
        }
    }
}
