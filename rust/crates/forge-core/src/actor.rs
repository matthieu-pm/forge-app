use serde::{Deserialize, Serialize};

/// Keep wire spelling identical to the existing first-party/public contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ApiScope {
    #[serde(rename = "teams:read")]
    TeamsRead,
    #[serde(rename = "teams:write")]
    TeamsWrite,
    #[serde(rename = "issues:read")]
    IssuesRead,
    #[serde(rename = "issues:write")]
    IssuesWrite,
    #[serde(rename = "projects:read")]
    ProjectsRead,
    #[serde(rename = "projects:write")]
    ProjectsWrite,
    #[serde(rename = "agents:read")]
    AgentsRead,
    #[serde(rename = "agents:write")]
    AgentsWrite,
    #[serde(rename = "agents:approve")]
    AgentsApprove,
    #[serde(rename = "model-connections:read")]
    ModelConnectionsRead,
    #[serde(rename = "model-connections:write")]
    ModelConnectionsWrite,
}

pub const API_SCOPES: [ApiScope; 11] = [
    ApiScope::TeamsRead,
    ApiScope::TeamsWrite,
    ApiScope::IssuesRead,
    ApiScope::IssuesWrite,
    ApiScope::ProjectsRead,
    ApiScope::ProjectsWrite,
    ApiScope::AgentsRead,
    ApiScope::AgentsWrite,
    ApiScope::AgentsApprove,
    ApiScope::ModelConnectionsRead,
    ApiScope::ModelConnectionsWrite,
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Authentication {
    Session { session_id: String },
    ApiKey { credential_id: String },
    Loop { loop_id: String, run_id: String },
    Agent { run_id: String, token_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopScope {
    pub loop_id: String,
    pub run_id: String,
    pub team_id: String,
    pub all_public: bool,
    #[serde(default)]
    pub cancelling: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: String,
    pub workspace_id: String,
    pub workspace_role: String,
    pub authentication: Authentication,
    pub scopes: Option<Vec<ApiScope>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_scope: Option<LoopScope>,
}

#[derive(Debug, thiserror::Error)]
#[error("You do not have permission to perform this action.")]
pub struct AccessDenied;

impl Actor {
    pub fn has_role(&self, allowed: &[&str]) -> bool {
        self.workspace_role
            .split(',')
            .map(str::trim)
            .any(|role| !role.is_empty() && allowed.contains(&role))
    }

    pub fn has_scope(&self, scope: ApiScope) -> bool {
        match &self.scopes {
            None => matches!(self.authentication, Authentication::Session { .. }),
            Some(scopes) => scopes.contains(&scope),
        }
    }

    pub fn require_scope(&self, scope: ApiScope) -> Result<(), AccessDenied> {
        if self.has_scope(scope) {
            Ok(())
        } else {
            Err(AccessDenied)
        }
    }

    pub fn can_manage_teams(&self) -> bool {
        self.has_role(&["owner", "admin"]) && self.has_scope(ApiScope::TeamsWrite)
    }

    pub fn can_read_all_private_teams(&self) -> bool {
        self.has_role(&["owner", "admin"]) && self.has_scope(ApiScope::TeamsRead)
    }

    pub fn can_manage_workspace_models(&self) -> bool {
        self.has_role(&["owner", "admin"]) && self.has_scope(ApiScope::ModelConnectionsWrite)
    }

    /// Session rotation preserves a user's receipt identity. API keys and agent
    /// runs have independent identities, matching the TypeScript implementation.
    pub fn command_principal(&self) -> String {
        match &self.authentication {
            Authentication::Session { .. } => format!("user:{}", self.user_id),
            Authentication::ApiKey { credential_id } => format!("apiKey:{credential_id}"),
            Authentication::Agent { run_id, .. } => format!("agent:{run_id}:{}", self.user_id),
            Authentication::Loop { loop_id, run_id } => format!("loop:{loop_id}:{run_id}"),
        }
    }
}

pub fn permissions_to_scopes(value: &serde_json::Value) -> Vec<ApiScope> {
    let Some(permissions) = value.as_object() else {
        return vec![];
    };
    let mut result = vec![];
    for (resource, actions) in permissions {
        let Some(actions) = actions.as_array() else {
            continue;
        };
        for action in actions {
            let Some(action) = action.as_str() else {
                continue;
            };
            if let Ok(scope) =
                serde_json::from_value(serde_json::Value::String(format!("{resource}:{action}")))
            {
                result.push(scope);
            }
        }
    }
    result
}
