use crate::actor::Actor;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspacePlan {
    #[default]
    Free,
    Basic,
    Business,
    Enterprise,
}
impl WorkspacePlan {
    pub fn from_storage(value: &str) -> Self {
        match value {
            "starter" | "basic" => Self::Basic,
            "plus" | "business" => Self::Business,
            "enterprise" => Self::Enterprise,
            _ => Self::Free,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Basic => "basic",
            Self::Business => "business",
            Self::Enterprise => "enterprise",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecurityFeature {
    RestrictInvitations,
    RestrictGuestAgents,
    TeamCreationPolicy,
    WorkspaceLabelPolicy,
    WorkspaceTemplatePolicy,
    LoopManagementPolicy,
    FileUploadRestrictions,
    ApplicationApprovals,
    SupportPiiReduction,
    SamlScim,
    Hipaa,
}
pub const SECURITY_FEATURES: [SecurityFeature; 11] = [
    SecurityFeature::RestrictInvitations,
    SecurityFeature::RestrictGuestAgents,
    SecurityFeature::TeamCreationPolicy,
    SecurityFeature::WorkspaceLabelPolicy,
    SecurityFeature::WorkspaceTemplatePolicy,
    SecurityFeature::LoopManagementPolicy,
    SecurityFeature::FileUploadRestrictions,
    SecurityFeature::ApplicationApprovals,
    SecurityFeature::SupportPiiReduction,
    SecurityFeature::SamlScim,
    SecurityFeature::Hipaa,
];
impl SecurityFeature {
    pub fn required_plan(self) -> WorkspacePlan {
        match self {
            Self::RestrictInvitations | Self::RestrictGuestAgents => WorkspacePlan::Basic,
            Self::TeamCreationPolicy
            | Self::WorkspaceLabelPolicy
            | Self::WorkspaceTemplatePolicy
            | Self::LoopManagementPolicy => WorkspacePlan::Business,
            _ => WorkspacePlan::Enterprise,
        }
    }
}
pub fn entitlements(
    plan: WorkspacePlan,
    overrides: &HashMap<SecurityFeature, bool>,
) -> HashMap<SecurityFeature, bool> {
    SECURITY_FEATURES
        .into_iter()
        .map(|feature| {
            (
                feature,
                *overrides
                    .get(&feature)
                    .unwrap_or(&(plan >= feature.required_plan())),
            )
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspacePolicy {
    AllMembers,
    Admins,
}
impl WorkspacePolicy {
    pub fn allows(self, actor: &Actor) -> bool {
        self == Self::AllMembers || actor.has_role(&["owner", "admin"])
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    #[serde(alias = "invite_links_enabled")]
    pub invite_links_enabled: bool,
    #[serde(alias = "google_authentication_enabled")]
    pub google_authentication_enabled: bool,
    #[serde(alias = "email_passkey_authentication_enabled")]
    pub email_passkey_authentication_enabled: bool,
    #[serde(alias = "invitation_policy")]
    pub invitation_policy: WorkspacePolicy,
    #[serde(alias = "team_creation_policy")]
    pub team_creation_policy: WorkspacePolicy,
    #[serde(alias = "workspace_labels_policy")]
    pub workspace_labels_policy: WorkspacePolicy,
    #[serde(alias = "workspace_templates_policy")]
    pub workspace_templates_policy: WorkspacePolicy,
    #[serde(alias = "loops_policy")]
    pub loops_policy: WorkspacePolicy,
    #[serde(alias = "api_key_creation_policy")]
    pub api_key_creation_policy: WorkspacePolicy,
    #[serde(alias = "agent_guidance_policy")]
    pub agent_guidance_policy: WorkspacePolicy,
    #[serde(alias = "restrict_file_uploads")]
    pub restrict_file_uploads: bool,
    #[serde(alias = "allowed_upload_types", deserialize_with = "strings_only")]
    pub allowed_upload_types: Vec<String>,
    #[serde(alias = "review_third_party_applications")]
    pub review_third_party_applications: bool,
    #[serde(alias = "reduce_support_pii")]
    pub reduce_support_pii: bool,
    #[serde(alias = "block_guest_agent_access")]
    pub block_guest_agent_access: bool,
    #[serde(alias = "share_ai_usage_data")]
    pub share_ai_usage_data: bool,
    #[serde(alias = "agent_web_search_enabled")]
    pub agent_web_search_enabled: bool,
    #[serde(alias = "external_loop_sources_enabled")]
    pub external_loop_sources_enabled: bool,
    #[serde(alias = "mcp_servers_enabled")]
    pub mcp_servers_enabled: bool,
    #[serde(alias = "hipaa_enabled")]
    pub hipaa_enabled: bool,
}

fn strings_only<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            invite_links_enabled: true,
            google_authentication_enabled: true,
            email_passkey_authentication_enabled: true,
            invitation_policy: WorkspacePolicy::AllMembers,
            team_creation_policy: WorkspacePolicy::Admins,
            workspace_labels_policy: WorkspacePolicy::Admins,
            workspace_templates_policy: WorkspacePolicy::Admins,
            loops_policy: WorkspacePolicy::Admins,
            api_key_creation_policy: WorkspacePolicy::AllMembers,
            agent_guidance_policy: WorkspacePolicy::Admins,
            restrict_file_uploads: false,
            allowed_upload_types: vec![],
            review_third_party_applications: false,
            reduce_support_pii: false,
            block_guest_agent_access: false,
            share_ai_usage_data: false,
            agent_web_search_enabled: false,
            external_loop_sources_enabled: false,
            mcp_servers_enabled: false,
            hipaa_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecurityAction {
    #[serde(rename = "security.manage")]
    SecurityManage,
    #[serde(rename = "members.invite")]
    MembersInvite,
    #[serde(rename = "teams.create")]
    TeamsCreate,
    #[serde(rename = "workspace-labels.manage")]
    WorkspaceLabelsManage,
    #[serde(rename = "workspace-templates.manage")]
    WorkspaceTemplatesManage,
    #[serde(rename = "loops.manage")]
    LoopsManage,
    #[serde(rename = "api-keys.create")]
    ApiKeysCreate,
    #[serde(rename = "agent-guidance.manage")]
    AgentGuidanceManage,
    #[serde(rename = "agents.invoke")]
    AgentsInvoke,
    #[serde(rename = "attachments.upload")]
    AttachmentsUpload,
    #[serde(rename = "applications.install")]
    ApplicationsInstall,
    #[serde(rename = "agent.web-search")]
    AgentWebSearch,
    #[serde(rename = "agent.mcp")]
    AgentMcp,
    #[serde(rename = "loops.trigger-external")]
    LoopsTriggerExternal,
    #[serde(rename = "ai-usage.share")]
    AiUsageShare,
}

impl SecuritySettings {
    pub fn allows(&self, actor: &Actor, action: SecurityAction) -> bool {
        match action {
            SecurityAction::SecurityManage => actor.has_role(&["owner", "admin"]),
            SecurityAction::MembersInvite => self.invitation_policy.allows(actor),
            SecurityAction::TeamsCreate => self.team_creation_policy.allows(actor),
            SecurityAction::WorkspaceLabelsManage => self.workspace_labels_policy.allows(actor),
            SecurityAction::WorkspaceTemplatesManage => {
                self.workspace_templates_policy.allows(actor)
            }
            SecurityAction::LoopsManage => self.loops_policy.allows(actor),
            SecurityAction::ApiKeysCreate => self.api_key_creation_policy.allows(actor),
            SecurityAction::AgentGuidanceManage => self.agent_guidance_policy.allows(actor),
            SecurityAction::AgentsInvoke => {
                !self.block_guest_agent_access || !actor.has_role(&["guest"])
            }
            SecurityAction::ApplicationsInstall => {
                !self.review_third_party_applications || actor.has_role(&["owner", "admin"])
            }
            SecurityAction::AgentWebSearch => self.agent_web_search_enabled,
            SecurityAction::AgentMcp => self.mcp_servers_enabled,
            SecurityAction::LoopsTriggerExternal => self.external_loop_sources_enabled,
            SecurityAction::AiUsageShare => self.share_ai_usage_data,
            SecurityAction::AttachmentsUpload => true,
        }
    }
    pub fn upload_allowed(&self, content_type: &str) -> bool {
        !self.restrict_file_uploads
            || content_type.starts_with("image/")
            || content_type.starts_with("video/")
            || self
                .allowed_upload_types
                .iter()
                .any(|allowed| allowed == content_type)
    }
}

pub fn normalized_domain(value: &str) -> Option<String> {
    let candidate = value
        .trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
        .to_lowercase();
    let candidate = candidate.strip_suffix('.').unwrap_or(&candidate);
    if candidate.is_empty() || candidate.contains(['/', '@', ':']) {
        return None;
    }
    // domainToASCII preserves numeric DNS labels. Parsing as a URL host would
    // reinterpret abbreviated numeric names as IPv4 addresses.
    let ascii = idna::domain_to_ascii(candidate).ok()?;
    let labels: Vec<_> = ascii.split('.').collect();
    if ascii.len() > 253
        || labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label.as_bytes()[0].is_ascii_alphanumeric()
                || !label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(ascii)
}
