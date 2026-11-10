//! Source-owned feature ceilings and explicit workspace rollout configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductFeature {
    Signals,
    Reviews,
    Insights,
    Billing,
    Applications,
    Integrations,
    PersonalPreferenceImport,
    ExternalImport,
    ExternalExport,
    Sla,
    TeamAgents,
    AgentGuidance,
    RecurringIssues,
    ScheduledUpdates,
    ThreadSummaries,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureMode {
    Disabled,
    Preview,
    Enabled,
}

impl ProductFeature {
    fn ceiling(self) -> FeatureMode {
        match self {
            Self::Signals | Self::Reviews => FeatureMode::Preview,
            Self::Billing | Self::PersonalPreferenceImport | Self::Sla => FeatureMode::Enabled,
            _ => FeatureMode::Disabled,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rollout {
    mode: FeatureMode,
    workspace_ids: Vec<String>,
}

#[derive(Debug, Default)]
pub struct FeatureRollouts(HashMap<ProductFeature, Rollout>);

#[derive(Debug, thiserror::Error)]
#[error("Invalid FORGE_FEATURE_ROLLOUTS configuration.")]
pub struct InvalidFeatureRollouts;

impl FeatureRollouts {
    pub fn parse(raw: Option<&str>) -> Result<Self, InvalidFeatureRollouts> {
        let Some(raw) = raw else {
            return Ok(Self::default());
        };
        let entries: HashMap<ProductFeature, Rollout> =
            serde_json::from_str(raw).map_err(|_| InvalidFeatureRollouts)?;
        for (feature, rollout) in &entries {
            if rollout.workspace_ids.len() > 1000
                || rollout
                    .workspace_ids
                    .iter()
                    .any(|id| id.is_empty() || id.trim() != id || id == "*")
                || rollout.mode == FeatureMode::Disabled
                || feature.ceiling() == FeatureMode::Disabled
                || (rollout.mode == FeatureMode::Enabled
                    && feature.ceiling() != FeatureMode::Enabled)
                || (*feature == ProductFeature::Billing && rollout.mode != FeatureMode::Enabled)
            {
                return Err(InvalidFeatureRollouts);
            }
        }
        Ok(Self(entries))
    }

    pub fn mode(
        &self,
        feature: ProductFeature,
        workspace_id: &str,
        billing_enabled: bool,
    ) -> FeatureMode {
        if workspace_id.is_empty() || (feature == ProductFeature::Billing && !billing_enabled) {
            return FeatureMode::Disabled;
        }
        self.0
            .get(&feature)
            .filter(|rollout| rollout.workspace_ids.iter().any(|id| id == workspace_id))
            .map(|rollout| rollout.mode)
            .unwrap_or(FeatureMode::Disabled)
    }
}
