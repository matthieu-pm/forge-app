use crate::security::{SecurityFeature, SecuritySettings, WorkspacePolicy};
use serde::{Deserialize, Serialize};

macro_rules! settings {
    ($name:ident,$value:ty,{$($variant:ident=>$field:ident:$wire:literal),+ $(,)?})=>{
        #[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
        pub enum $name {$(#[serde(rename=$wire)]$variant),+}
        impl $name {
            pub fn column(self)->&'static str {match self {$(Self::$variant=>stringify!($field)),+}}
            pub fn key(self)->&'static str {match self {$(Self::$variant=>$wire),+}}
            pub fn get(self,settings:&SecuritySettings)->$value {match self {$(Self::$variant=>settings.$field),+}}
            pub fn set(self,settings:&mut SecuritySettings,value:$value) {match self {$(Self::$variant=>settings.$field=value),+}}
        }
    }
}

settings!(BooleanSetting,bool,{
    InviteLinksEnabled=>invite_links_enabled:"inviteLinksEnabled",
    GoogleAuthenticationEnabled=>google_authentication_enabled:"googleAuthenticationEnabled",
    EmailPasskeyAuthenticationEnabled=>email_passkey_authentication_enabled:"emailPasskeyAuthenticationEnabled",
    RestrictFileUploads=>restrict_file_uploads:"restrictFileUploads",
    ReviewThirdPartyApplications=>review_third_party_applications:"reviewThirdPartyApplications",
    ReduceSupportPii=>reduce_support_pii:"reduceSupportPii",
    BlockGuestAgentAccess=>block_guest_agent_access:"blockGuestAgentAccess",
    ShareAiUsageData=>share_ai_usage_data:"shareAiUsageData",
    AgentWebSearchEnabled=>agent_web_search_enabled:"agentWebSearchEnabled",
    ExternalLoopSourcesEnabled=>external_loop_sources_enabled:"externalLoopSourcesEnabled",
    McpServersEnabled=>mcp_servers_enabled:"mcpServersEnabled",
    HipaaEnabled=>hipaa_enabled:"hipaaEnabled",
});
settings!(PolicySetting,WorkspacePolicy,{
    InvitationPolicy=>invitation_policy:"invitationPolicy",
    TeamCreationPolicy=>team_creation_policy:"teamCreationPolicy",
    WorkspaceLabelsPolicy=>workspace_labels_policy:"workspaceLabelsPolicy",
    WorkspaceTemplatesPolicy=>workspace_templates_policy:"workspaceTemplatesPolicy",
    LoopsPolicy=>loops_policy:"loopsPolicy",
    ApiKeyCreationPolicy=>api_key_creation_policy:"apiKeyCreationPolicy",
    AgentGuidancePolicy=>agent_guidance_policy:"agentGuidancePolicy",
});

impl BooleanSetting {
    pub fn required_feature(self, value: bool) -> Option<SecurityFeature> {
        if !value {
            return None;
        }
        match self {
            Self::RestrictFileUploads => Some(SecurityFeature::FileUploadRestrictions),
            Self::ReviewThirdPartyApplications => Some(SecurityFeature::ApplicationApprovals),
            Self::ReduceSupportPii => Some(SecurityFeature::SupportPiiReduction),
            Self::BlockGuestAgentAccess => Some(SecurityFeature::RestrictGuestAgents),
            Self::HipaaEnabled => Some(SecurityFeature::Hipaa),
            _ => None,
        }
    }
}
impl PolicySetting {
    pub fn required_feature(self, value: WorkspacePolicy) -> Option<SecurityFeature> {
        if value != WorkspacePolicy::Admins {
            return None;
        }
        match self {
            Self::InvitationPolicy => Some(SecurityFeature::RestrictInvitations),
            Self::TeamCreationPolicy => Some(SecurityFeature::TeamCreationPolicy),
            Self::WorkspaceLabelsPolicy => Some(SecurityFeature::WorkspaceLabelPolicy),
            Self::WorkspaceTemplatesPolicy => Some(SecurityFeature::WorkspaceTemplatePolicy),
            Self::LoopsPolicy => Some(SecurityFeature::LoopManagementPolicy),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SecurityCommand {
    SetBoolean {
        key: BooleanSetting,
        value: bool,
        expected_version: i32,
    },
    SetPolicy {
        key: PolicySetting,
        value: WorkspacePolicy,
        expected_version: i32,
    },
    AddDomain {
        domain: String,
        expected_version: i32,
    },
    RemoveDomain {
        domain_id: uuid::Uuid,
        expected_version: i32,
    },
    VerifyDomain {
        domain_id: uuid::Uuid,
        expected_version: i32,
    },
    ResetInviteLink {
        expected_version: i32,
    },
}
impl SecurityCommand {
    pub fn expected_version(&self) -> i32 {
        match self {
            Self::SetBoolean {
                expected_version, ..
            }
            | Self::SetPolicy {
                expected_version, ..
            }
            | Self::AddDomain {
                expected_version, ..
            }
            | Self::RemoveDomain {
                expected_version, ..
            }
            | Self::VerifyDomain {
                expected_version, ..
            }
            | Self::ResetInviteLink { expected_version } => *expected_version,
        }
    }
    pub fn required_feature(&self) -> Option<SecurityFeature> {
        match self {
            Self::SetBoolean { key, value, .. } => key.required_feature(*value),
            Self::SetPolicy { key, value, .. } => key.required_feature(*value),
            _ => None,
        }
    }
}
